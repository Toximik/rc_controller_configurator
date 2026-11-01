/**
 * \author Toximik
 * \file logs.ts
 * \brief Logger page, part "Logs on the board": logger state, session list,
 *        download (raw pages .bin or CSV .zip decoded in the browser), start /
 *        stop, erase all. Firmware API 1.3 (Docs/PHASE3_LOGGER_PLAN.md
 *        section 11).
 *
 * The board refuses download, erase, start and stop while armed, and the
 * download / erase while a session is written; the buttons follow the status
 * poll and LOG_INFO (read every second while connected).
 */

import { h, setText } from "../dom.ts";
import { MspErrorReply, type MspClient } from "../msp/client.ts";
import { decodeSession } from "../msp/logformat.ts";
import {
  downloadSession,
  LOGGER_ENDS,
  LOGGER_REC,
  LOGGER_STATE,
  LOGGER_STATES,
  readLogInfo,
  readLogSessions,
  sessionPages,
  sessionSeconds,
  type LogInfo,
  type LogSession,
} from "../msp/logs.ts";
import { MSP } from "../msp/protocol.ts";
import { makeZip } from "../zip.ts";
import { isLocked } from "./area.ts";
import type { StatusSample } from "./status.ts";

const INFO_PERIOD_MS = 1000;
const MB = 1e6;

type Format = "bin" | "csv";

function save(name: string, data: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function errorText(error: unknown): string {
  if (error instanceof MspErrorReply) return `board refused: ${error.message.replace(/^0x[0-9a-f]+: /, "")}`;
  return (error as Error).message;
}

export class LogsPanel {
  readonly root: HTMLElement;
  private client: MspClient | null = null;
  private generation = 0;
  private info: LogInfo | null = null;
  private sessions: LogSession[] = [];
  private locked = false;
  private busy = "";
  private abort: AbortController | null = null;
  private unsupported = false;

  private readonly stateText = h("div", { class: "logs-state" });
  private readonly chipText = h("div", { class: "logs-chip" });
  private readonly message = h("div", { class: "msg" });
  private readonly tbody = h("tbody");
  private readonly empty = h("p", { class: "hint" }, "No sessions on the chip.");
  private readonly btn = {
    refresh: h("button", { class: "secondary", title: "Read the session list again" }, "Refresh"),
    start: h("button", { class: "secondary", title: "Start a log session (as the log switch)" }, "Start logging"),
    stop: h("button", { class: "secondary", title: "Stop the log session" }, "Stop logging"),
    erase: h("button", { class: "secondary danger", title: "Erase all sessions on the chip" }, "Erase all"),
    cancel: h("button", { class: "secondary", title: "Stop the download" }, "Cancel"),
  };

  constructor() {
    this.btn.refresh.addEventListener("click", () => void this.reload());
    this.btn.start.addEventListener("click", () => void this.control(true));
    this.btn.stop.addEventListener("click", () => void this.control(false));
    this.btn.erase.addEventListener("click", () => void this.erase());
    this.btn.cancel.addEventListener("click", () => this.abort?.abort());
    this.btn.cancel.hidden = true;

    this.root = h(
      "section",
      { class: "card logs" },
      h("h2", {}, "Logs on the board"),
      h("div", { class: "logs-head" }, h("div", {}, this.stateText, this.chipText), h(
        "div",
        { class: "buttons" },
        this.btn.refresh,
        this.btn.start,
        this.btn.stop,
        this.btn.erase,
      )),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "out-table logs-table" },
          h(
            "thead",
            {},
            h("tr", {}, h("th", {}, "Session"), h("th", {}, "Length"), h("th", {}, "Size"), h("th", {}, "Pages"), h("th", {}, "Note"), h("th", {}, "Download")),
          ),
          this.tbody,
        ),
      ),
      this.empty,
      h("div", { class: "logs-progress" }, this.message, this.btn.cancel),
      h(
        "p",
        { class: "hint" },
        "CSV (.zip): one CSV per record type (imu, rc, outputs, status, event, session) + summary.txt, decoded in the browser – " +
          "the same files as Tools/log.py download. Raw (.bin): the NAND pages as stored, for Tools/log.py decode. " +
          "Time stamps in µs since the board started. IMU values raw (scales in session.csv). " +
          "Download, erase, start and stop are refused while armed; download and erase also while a session is written.",
      ),
    );
    this.refresh();
  }

  attach(client: MspClient): void {
    this.client = client;
    this.unsupported = false;
    const my = ++this.generation;
    void this.reload();
    void this.infoLoop(my, client);
  }

  detach(): void {
    this.generation++;
    this.abort?.abort();
    this.client = null;
    this.busy = "";
    this.refresh();
  }

  update(sample: StatusSample): void {
    const locked = isLocked(sample);
    if (locked !== this.locked) {
      this.locked = locked;
      this.refresh();
    }
  }

  /* ------------------------------------------------------------------ data */

  private async infoLoop(my: number, c: MspClient): Promise<void> {
    while (my === this.generation && !this.unsupported) {
      if (!this.busy) {
        try {
          const before = this.info;
          this.info = await readLogInfo(c);
          if (my !== this.generation) return;
          // Session ended / erase or scan finished: new list
          if (before && (before.sessions !== this.info.sessions || before.state !== this.info.state) && this.info.scanDone) {
            this.sessions = await readLogSessions(c);
          }
          this.refresh();
        } catch (error) {
          if (error instanceof MspErrorReply && error.code === 1) {
            this.unsupported = true;
            this.refresh();
          }
        }
      }
      await new Promise((res) => setTimeout(res, INFO_PERIOD_MS));
    }
  }

  private async reload(): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      this.info = await readLogInfo(c);
      this.sessions = this.info.scanDone ? await readLogSessions(c) : [];
      this.say("");
    } catch (error) {
      if (error instanceof MspErrorReply && error.code === 1) this.unsupported = true;
      else this.say(`Reading the logger failed: ${errorText(error)}`, "bad");
    }
    this.refresh();
  }

  /* --------------------------------------------------------------- actions */

  private async download(s: LogSession, format: Format): Promise<void> {
    const c = this.client;
    if (!c || this.busy) return;
    this.busy = "download";
    this.abort = new AbortController();
    this.btn.cancel.hidden = false;
    this.refresh();
    const sizeMb = (sessionPages(s) * 2048) / MB;
    try {
      const r = await downloadSession(
        c,
        s,
        (p) => this.say(`Session ${s.number}: ${p.done} / ${p.total} pages (${((p.done * 2048) / MB).toFixed(1)} / ${sizeMb.toFixed(1)} MB), ${(p.bytesPerS / 1024).toFixed(0)} KB/s`),
        this.abort.signal,
      );
      const base = `session_${s.number}`;
      let note = "";
      if (format === "bin") {
        save(`${base}.bin`, r.data, "application/octet-stream");
      } else {
        this.say(`Session ${s.number}: decoding…`);
        await new Promise((res) => setTimeout(res, 0));
        const d = decodeSession(r.data);
        const enc = new TextEncoder();
        const files = [{ name: `${base}/summary.txt`, data: enc.encode(d.summary) }];
        for (const [name, text] of d.csv) files.push({ name: `${base}/${name}.csv`, data: enc.encode(text) });
        save(`${base}.zip`, makeZip(files), "application/zip");
        note = `, ${d.records} records, lost pages ${d.lostPages}, broken records ${d.broken}`;
      }
      const problems = r.missing || r.readErrors ? ` – not received ${r.missing}, read errors ${r.readErrors}` : "";
      this.say(
        `Session ${s.number}: ${(r.pages * 2048 / MB).toFixed(1)} MB in ${r.seconds.toFixed(1)} s (${(r.pages * 2048 / 1024 / r.seconds).toFixed(0)} KB/s)${note}${problems}`,
        problems ? "warn" : "ok",
      );
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      this.say(cancelled ? "Download cancelled." : `Download failed: ${errorText(error)}`, cancelled ? "" : "bad");
    } finally {
      this.busy = "";
      this.abort = null;
      this.btn.cancel.hidden = true;
      this.refresh();
    }
  }

  private async control(start: boolean): Promise<void> {
    const c = this.client;
    if (!c || this.busy) return;
    try {
      await c.request(MSP.LOG_CONTROL, Uint8Array.of(start ? 1 : 0));
      this.say(start ? "Logging started." : "Logging stopped.", "ok");
      this.info = await readLogInfo(c);
    } catch (error) {
      this.say(`${start ? "Start" : "Stop"} failed: ${errorText(error)}`, "bad");
    }
    this.refresh();
  }

  private async erase(): Promise<void> {
    const c = this.client;
    if (!c || this.busy) return;
    if (!confirm(`Erase all ${this.sessions.length} sessions on the board's log chip? This cannot be undone.`)) return;
    this.busy = "erase";
    this.refresh();
    try {
      await c.request(MSP.LOG_ERASE);
      this.say("Erasing…");
      const t0 = performance.now();
      do {
        await new Promise((res) => setTimeout(res, 300));
        this.info = await readLogInfo(c);
        this.refresh();
      } while (this.info.state === LOGGER_STATE.ERASING || this.info.state === LOGGER_STATE.SCAN);
      this.sessions = await readLogSessions(c);
      this.say(`Erased in ${((performance.now() - t0) / 1000).toFixed(1)} s.`, "ok");
    } catch (error) {
      this.say(`Erase failed: ${errorText(error)}`, "bad");
    } finally {
      this.busy = "";
      this.refresh();
    }
  }

  /* -------------------------------------------------------------------- UI */

  private say(text: string, tone: "" | "ok" | "warn" | "bad" = ""): void {
    setText(this.message, text);
    this.message.dataset["tone"] = tone;
  }

  private refresh(): void {
    const i = this.info;
    const connected = !!this.client;
    if (this.unsupported) {
      setText(this.stateText, "The firmware has no log download (needs API 1.3) – update the firmware.");
      setText(this.chipText, "");
    } else if (i) {
      const state = LOGGER_STATES[i.state] ?? `state ${i.state}`;
      const writing = i.state === LOGGER_STATE.LOGGING || i.state === LOGGER_STATE.CLOSING
        ? ` – session ${i.session}, ${((i.pages * i.pageSize) / MB).toFixed(1)} MB` : "";
      const rec = i.rec !== 0 ? ` · ${LOGGER_REC[i.rec] ?? i.rec}` : "";
      const end = i.lastEnd !== 0 ? ` · last session end: ${LOGGER_ENDS[i.lastEnd] ?? i.lastEnd}` : "";
      setText(this.stateText, `Logger ${state}${writing}${rec}${end}${i.startPending ? " · start pending" : ""}`);
      const chunk = i.pagesPerBlock * i.pageSize;
      const bad = i.badBlocks ? `, ${i.badBlocks} bad blocks` : "";
      setText(
        this.chipText,
        `Chip ${((i.blocks * chunk) / MB).toFixed(0)} MB, free ${((i.freeBlocks * chunk) / MB).toFixed(1)} MB${bad} · ` +
          `${i.sessions} sessions · log switch ${i.switchChannel ? `CH${i.switchChannel}` : "none"}`,
      );
    } else {
      setText(this.stateText, connected ? "Reading…" : "Not connected.");
      setText(this.chipText, "");
    }

    const idle = !!i && i.state === LOGGER_STATE.IDLE;
    const logging = !!i && (i.state === LOGGER_STATE.LOGGING || i.state === LOGGER_STATE.CLOSING);
    const can = connected && !this.unsupported && !this.locked && !this.busy;
    const why = this.locked ? "Armed – the board refuses this" : this.busy ? "Busy" : !idle ? "Logger not idle" : "";
    this.btn.refresh.disabled = !connected || this.unsupported || !!this.busy;
    this.btn.start.disabled = !can || logging || !i || i.state === LOGGER_STATE.NO_CHIP;
    this.btn.stop.disabled = !can || !(logging || i?.startPending);
    this.btn.erase.disabled = !can || !idle || this.sessions.length === 0;
    this.btn.erase.title = this.btn.erase.disabled && why ? why : "Erase all sessions on the chip";

    const rows = [...this.sessions].reverse().map((s) => {
      const bin = h("button", { class: "secondary small", title: "Raw NAND pages (Tools/log.py decode)" }, ".bin");
      const csv = h("button", { class: "small", title: "CSV per record type + summary, zipped" }, "CSV .zip");
      for (const b of [bin, csv]) {
        b.disabled = !can || !idle;
        if (b.disabled && why) b.title = why;
      }
      bin.addEventListener("click", () => void this.download(s, "bin"));
      csv.addEventListener("click", () => void this.download(s, "csv"));
      const notes = [s.closed ? "" : "not closed (reset / power cut)", s.firstPage ? "start missing" : ""].filter(Boolean).join(", ");
      return h(
        "tr",
        {},
        h("td", {}, String(s.number)),
        h("td", {}, `${sessionSeconds(s).toFixed(1)} s`),
        h("td", {}, `${((sessionPages(s) * 2048) / MB).toFixed(1)} MB`),
        h("td", {}, String(sessionPages(s))),
        h("td", { class: "logs-note" }, notes || "-"),
        h("td", { class: "logs-dl" }, csv, bin),
      );
    });
    this.tbody.replaceChildren(...rows);
    this.empty.hidden = this.sessions.length > 0 || !i || !i.scanDone;
  }
}
