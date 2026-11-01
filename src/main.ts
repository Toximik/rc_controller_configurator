/**
 * \author Toximik
 * \file main.ts
 * \brief Configurator app: connect (port picker, identity / API check),
 *        status poll at 10 Hz, disconnect / board loss / auto reconnect,
 *        pages status, outputs and lights (tabs = URL hash).
 */

import { byId, h, setText } from "./dom.ts";
import { MspClient, MspTimeout } from "./msp/client.ts";
import { IncompatibleBoard, readIdentity, type Identity } from "./msp/identity.ts";
import { MspErrorReply } from "./msp/client.ts";
import { decodeBattery, decodeOutputsLive, decodeRc, decodeStatus } from "./msp/payloads.ts";
import { API_MINOR_KNOWN, MSP } from "./msp/protocol.ts";
import { STATUS_FLAG } from "./msp/payloads.ts";
import { SerialLink, webSerialSupported } from "./serial.ts";
import { SaveTracker } from "./ui/area.ts";
import { LightsView } from "./ui/lights.ts";
import { OutputsView } from "./ui/outputs.ts";
import { StatusView } from "./ui/status.ts";

/** Status poll period [ms] (PHASE2_MSP_PLAN.md section 6: ~10 Hz) */
const POLL_MS = 100;
/** Consecutive failed polls before the board counts as not answering */
const POLL_FAIL_LIMIT = 5;

type ConnState = "disconnected" | "connecting" | "connected" | "lost";

const ui = {
  state: byId("conn-state"),
  connect: byId<HTMLButtonElement>("connect"),
  reboot: byId<HTMLButtonElement>("reboot"),
  showAll: byId<HTMLInputElement>("show-all"),
  notice: byId("notice"),
  identity: byId("identity"),
  tabs: byId("tabs"),
  status: byId("status"),
  outputs: byId("outputs"),
  lights: byId("lights"),
  footer: byId("footer"),
};

let state: ConnState = "disconnected";
let link: SerialLink | null = null;
let client: MspClient | null = null;
let session = 0; // incremented on every connect / disconnect: stale loops stop
let lastPortInfo: SerialPortInfo | null = null;
/** Set when the board accepted REBOOT: the following USB loss is expected */
let rebootTimer: ReturnType<typeof setTimeout> | null = null;
/** Board writes refused (armed): from the status poll */
let boardLocked = false;
let statusView: StatusView | null = null;
const saves = new SaveTracker();
const outputsView = new OutputsView(saves);
const lightsView = new LightsView(saves);
const areaViews = [outputsView, lightsView];
const hasUnsavedWork = () => areaViews.some((v) => v.hasUnsavedWork);

const PAGES = ["status", "outputs", "lights"] as const;
type Page = (typeof PAGES)[number];

function currentPage(): Page {
  const p = location.hash.slice(1);
  return (PAGES as readonly string[]).includes(p) ? (p as Page) : "status";
}

/** Tabs and pages visible only while connected (settings pages also while lost: edits stay visible) */
function showPages(): void {
  const page = currentPage();
  const on = state === "connected" || (state === "lost" && hasUnsavedWork());
  ui.tabs.hidden = !on;
  ui.status.hidden = !on || page !== "status" || state !== "connected";
  ui.outputs.hidden = !on || page !== "outputs";
  ui.lights.hidden = !on || page !== "lights";
  for (const a of ui.tabs.querySelectorAll<HTMLAnchorElement>("a")) {
    a.toggleAttribute("aria-current", a.hash === `#${page}`);
  }
}

function setState(next: ConnState): void {
  state = next;
  setText(ui.state, next);
  ui.state.dataset["state"] = next;
  ui.connect.textContent = next === "connected" || next === "connecting" ? "Disconnect" : "Connect";
  ui.connect.disabled = next === "connecting";
  ui.reboot.hidden = next !== "connected";
  ui.reboot.disabled = boardLocked || rebootTimer !== null;
  ui.showAll.disabled = next !== "disconnected" && next !== "lost";
  showPages();
}

function notice(text: string, tone: "info" | "warn" | "bad" = "info"): void {
  ui.notice.hidden = !text;
  ui.notice.dataset["tone"] = tone;
  setText(ui.notice, text);
}

function showIdentity(id: Identity): void {
  const row = (k: string, v: string) => [h("dt", {}, k), h("dd", {}, v)];
  ui.identity.replaceChildren(
    h("h2", {}, id.board.boardName || "Board"),
    h(
      "dl",
      { class: "fields inline" },
      ...row("Firmware", `${id.variant} ${id.firmware}`),
      ...row("API", `${id.api.major}.${id.api.minor}`),
      ...row("Hardware", `${id.board.boardId} rev 0x${id.board.hardwareRevision.toString(16).padStart(4, "0")}`),
      ...row("MCU UID", id.board.uid || "-"),
      ...row("Built", `${id.build.date} ${id.build.time}${id.build.git ? ` (${id.build.git})` : ""}`),
    ),
  );
  ui.identity.hidden = false;
  if (id.newerMinor) {
    notice(`Firmware API ${id.api.major}.${id.api.minor} is newer than this configurator knows (1.${API_MINOR_KNOWN}): it works, newer features are not shown.`, "info");
  }
}

async function connect(port: SerialPort): Promise<void> {
  const my = ++session;
  setState("connecting");
  notice("");
  try {
    link = await SerialLink.open(
      port,
      (chunk) => client?.receive(chunk),
      (reason) => lost(my, reason),
    );
    client = new MspClient(link, () => {}); // CLI text (banner, prompt) is ignored
    lastPortInfo = port.getInfo();
    const id = await readIdentity(client, API_MINOR_KNOWN);
    if (my !== session) return;
    if (rebootTimer !== null) {
      clearTimeout(rebootTimer);
      rebootTimer = null;
      notice("Board rebooted and reconnected.", "info");
    }
    showIdentity(id);
    setState("connected");
    statusView ??= new StatusView();
    ui.status.replaceChildren(statusView.root);
    for (const v of areaViews) v.attach(client);
    showPages();
    void pollLoop(my, client);
  } catch (error) {
    if (my !== session) return;
    const msg = error instanceof IncompatibleBoard ? error.message
      : error instanceof MspTimeout ? "The port does not answer MSP – is it the RC_Controller board (CLI port)?"
      : `Connect failed: ${(error as Error).message}`;
    await disconnect();
    notice(msg, "bad");
  }
}

async function disconnect(): Promise<void> {
  session++;
  if (rebootTimer !== null) clearTimeout(rebootTimer);
  rebootTimer = null;
  saves.reset();
  for (const v of areaViews) v.detach();
  client?.close();
  client = null;
  const l = link;
  link = null;
  await l?.close();
  setState("disconnected");
}

function lost(my: number, reason: string): void {
  if (my !== session) return;
  session++;
  saves.reset();
  for (const v of areaViews) v.detach();
  client?.close(reason);
  client = null;
  void link?.close();
  link = null;
  setState("lost");
  if (rebootTimer !== null) {
    notice("Board rebooting – reconnects automatically…", "info");
  } else {
    notice(`Connection lost (${reason}). Reconnects automatically when the board comes back (reboot, replug).`, "warn");
  }
}

async function pollLoop(my: number, c: MspClient): Promise<void> {
  let failures = 0;
  let polls = 0;
  let windowStart = performance.now();
  let rate = 0;
  while (my === session) {
    const t0 = performance.now();
    try {
      const [s, r, b, l] = c.requestMany([{ id: MSP.STATUS }, { id: MSP.RC }, { id: MSP.BATTERY }, { id: MSP.OUTPUTS_LIVE }]);
      const sample = {
        status: decodeStatus(await s!),
        rc: decodeRc(await r!),
        battery: decodeBattery(await b!),
        live: decodeOutputsLive(await l!),
      };
      if (my !== session) return;
      const locked = (sample.status.flags & STATUS_FLAG.LOCKED) !== 0 || sample.status.outputState === 2;
      if (locked !== boardLocked) {
        boardLocked = locked;
        ui.reboot.disabled = locked || rebootTimer !== null;
        ui.reboot.title = locked ? "Armed – the board refuses a reboot" : "Restart the board (refused while armed or saving)";
      }
      statusView?.update(sample);
      saves.update(sample, t0);
      for (const v of areaViews) v.update(sample);
      if (failures >= POLL_FAIL_LIMIT) notice("");
      failures = 0;
      polls++;
    } catch (error) {
      if (my !== session) return;
      failures++;
      if (failures === POLL_FAIL_LIMIT) {
        notice(`Board not answering (${(error as Error).message}) – still trying.`, "warn");
      }
    }
    const now = performance.now();
    if (now - windowStart >= 1000) {
      rate = (polls * 1000) / (now - windowStart);
      polls = 0;
      windowStart = now;
    }
    const st = c.stats;
    const pc = c.parserCounters;
    setText(
      ui.footer,
      `poll ${rate.toFixed(1)} Hz · round trip ${st.lastRoundTripMs.toFixed(1)} ms · requests ${st.requests} · ` +
        `timeouts ${st.timeouts} · error replies ${st.errorReplies} · CRC errors ${pc.crcErrors}`,
    );
    await new Promise((res) => setTimeout(res, Math.max(0, POLL_MS - (performance.now() - t0))));
  }
}

function samePort(info: SerialPortInfo, ref: SerialPortInfo | null): boolean {
  return !!ref && info.usbVendorId === ref.usbVendorId && info.usbProductId === ref.usbProductId;
}

async function reboot(): Promise<void> {
  const c = client;
  if (!c) return;
  const unsaved = hasUnsavedWork()
    ? "\n\nValues written but not saved (or edits not written) are lost – the board starts with its saved settings."
    : "";
  if (!confirm(`Reboot the board?${unsaved}`)) return;
  ui.reboot.disabled = true;
  try {
    await c.request(MSP.REBOOT);
    // The board resets ~50 ms after the reply; the USB loss + reconnect follow by themselves.
    // It cancels the reset if it got armed or a save started meanwhile.
    rebootTimer = setTimeout(() => {
      rebootTimer = null;
      ui.reboot.disabled = boardLocked;
      if (state === "connected") notice("The board did not reboot (cancelled: armed or a save started meanwhile).", "warn");
      else if (state === "lost") notice("The board did not come back within 10 s after the reboot – check USB / power.", "bad");
    }, 10_000);
    notice("Rebooting…", "info");
  } catch (error) {
    ui.reboot.disabled = boardLocked;
    const msg = error instanceof MspErrorReply ? `board refused: ${error.message.replace(/^0x[0-9a-f]+: /, "")}` : (error as Error).message;
    notice(`Reboot failed: ${msg}`, "bad");
  }
}

function init(): void {
  ui.outputs.replaceChildren(outputsView.root);
  ui.lights.replaceChildren(lightsView.root);
  window.addEventListener("hashchange", showPages);
  window.addEventListener("beforeunload", (event) => {
    if (hasUnsavedWork()) event.preventDefault();
  });
  setState("disconnected");
  if (!webSerialSupported()) {
    ui.connect.disabled = true;
    notice(
      window.isSecureContext
        ? "This browser has no Web Serial. Use Chrome or Edge (desktop)."
        : "Web Serial needs a secure context: open the configurator via https:// or http://localhost.",
      "bad",
    );
    return;
  }

  ui.reboot.addEventListener("click", () => void reboot());
  ui.connect.addEventListener("click", async () => {
    if (state === "connected" || state === "connecting") {
      await disconnect();
      notice("");
      return;
    }
    let port: SerialPort;
    try {
      port = await SerialLink.pick(ui.showAll.checked);
    } catch {
      return; // picker cancelled
    }
    await connect(port);
  });

  // Board unplugged / reset (USB re-enumerates)
  navigator.serial.addEventListener("disconnect", (event) => {
    if (link && event.target === link.port) lost(session, "USB disconnected");
  });
  // Board back: reconnect without the picker (permission already granted)
  navigator.serial.addEventListener("connect", (event) => {
    const port = event.target as SerialPort;
    if (state === "lost" && samePort(port.getInfo(), lastPortInfo)) {
      setTimeout(() => {
        if (state === "lost") void connect(port);
      }, 300); // let the CDC stack come up
    }
  });
}

init();
