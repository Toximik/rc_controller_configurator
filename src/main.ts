/**
 * \author Toximik
 * \file main.ts
 * \brief Configurator app: connect (port picker, identity / API check),
 *        status poll at 10 Hz, disconnect / board loss / auto reconnect,
 *        pages status and outputs (tabs = URL hash).
 */

import { byId, h, setText } from "./dom.ts";
import { MspClient, MspTimeout } from "./msp/client.ts";
import { IncompatibleBoard, readIdentity, type Identity } from "./msp/identity.ts";
import { decodeBattery, decodeOutputsLive, decodeRc, decodeStatus } from "./msp/payloads.ts";
import { API_MINOR_KNOWN, MSP } from "./msp/protocol.ts";
import { SerialLink, webSerialSupported } from "./serial.ts";
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
  showAll: byId<HTMLInputElement>("show-all"),
  notice: byId("notice"),
  identity: byId("identity"),
  tabs: byId("tabs"),
  status: byId("status"),
  outputs: byId("outputs"),
  footer: byId("footer"),
};

let state: ConnState = "disconnected";
let link: SerialLink | null = null;
let client: MspClient | null = null;
let session = 0; // incremented on every connect / disconnect: stale loops stop
let lastPortInfo: SerialPortInfo | null = null;
let statusView: StatusView | null = null;
const outputsView = new OutputsView();

const PAGES = ["status", "outputs"] as const;
type Page = (typeof PAGES)[number];

function currentPage(): Page {
  const p = location.hash.slice(1);
  return (PAGES as readonly string[]).includes(p) ? (p as Page) : "status";
}

/** Tabs and pages visible only while connected (outputs also while lost: edits stay visible) */
function showPages(): void {
  const page = currentPage();
  const on = state === "connected" || (state === "lost" && outputsView.hasUnsavedWork);
  ui.tabs.hidden = !on;
  ui.status.hidden = !on || page !== "status" || state !== "connected";
  ui.outputs.hidden = !on || page !== "outputs";
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
    showIdentity(id);
    setState("connected");
    statusView ??= new StatusView();
    ui.status.replaceChildren(statusView.root);
    outputsView.attach(client);
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
  outputsView.detach();
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
  outputsView.detach();
  client?.close(reason);
  client = null;
  void link?.close();
  link = null;
  setState("lost");
  notice(`Connection lost (${reason}). Reconnects automatically when the board comes back (reboot, replug).`, "warn");
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
      statusView?.update(sample);
      outputsView.update(sample, t0);
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

function init(): void {
  ui.outputs.replaceChildren(outputsView.root);
  window.addEventListener("hashchange", showPages);
  window.addEventListener("beforeunload", (event) => {
    if (outputsView.hasUnsavedWork) event.preventDefault();
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
