/**
 * \author Toximik
 * \file outputs.ts
 * \brief Outputs page: read / edit / write / save the OUTPUTS_CONFIG area
 *        (PHASE2_MSP_PLAN.md section 6). Editing is disabled while the board
 *        is armed (the board refuses every write then anyway, error 4).
 *
 * Write = MSP SET_OUTPUTS, applied by the board at once (RAM), then read back.
 * Save = MSP SAVE (stores all settings areas); the result comes from the
 * STATUS poll (saving flag, last save result).
 */

import { h, setText } from "../dom.ts";
import { MspErrorReply, type MspClient } from "../msp/client.ts";
import {
  cloneOutputs,
  decodeOutputs,
  encodeOutputs,
  FAILSAFE,
  FAILSAFE_NAMES,
  GROUP_TIMERS,
  OUTPUT_COUNT,
  OUTPUT_GROUP_OF,
  OUTPUT_GROUPS,
  PULSE_MAX_US,
  PULSE_MIN_US,
  RATE_MAX_HZ,
  RATE_MIN_HZ,
  RC_CHANNEL_MAX,
  sameOutputs,
  validateOutputs,
  type OutputConfig,
  type OutputsConfig,
  type OutputsField,
} from "../msp/outputs.ts";
import { MSP } from "../msp/protocol.ts";
import { STATUS_FLAG } from "../msp/payloads.ts";
import type { StatusSample } from "./status.ts";

type Tone = "" | "ok" | "warn" | "bad";

/** A form control bound to one field of the edited configuration */
interface Binding {
  el: HTMLInputElement | HTMLSelectElement;
  get(c: OutputsConfig): number | boolean;
  set(c: OutputsConfig, v: number | boolean): void;
}

function options(el: HTMLSelectElement, list: [number, string][]): HTMLSelectElement {
  el.append(...list.map(([v, t]) => h("option", { value: String(v) }, t)));
  return el;
}

const channelOptions = (withNone: boolean): [number, string][] => [
  ...(withNone ? ([[0, "none"]] as [number, string][]) : []),
  ...Array.from({ length: RC_CHANNEL_MAX }, (_, i): [number, string] => [i + 1, `CH${i + 1}`]),
];

function errorText(error: unknown): string {
  return error instanceof MspErrorReply ? `board refused: ${error.message.replace(/^0x[0-9a-f]+: /, "")}` : (error as Error).message;
}

export class OutputsView {
  readonly root = h("div", { class: "page outputs" });

  private client: MspClient | null = null;
  private board: OutputsConfig | null = null;
  private edit: OutputsConfig | null = null;
  private loadError = "";
  private busy = "";
  private locked = false;
  private writtenUnsaved = false;
  /** Set while a SAVE was accepted and its result is not seen yet: time of the reply */
  private saveAcceptedAt: number | null = null;

  private readonly bindings = new Map<OutputsField, Binding>();
  private readonly fieldset = h("fieldset", { class: "plain" });
  private readonly syncText = h("div", { class: "sync" });
  private readonly message = h("div", { class: "msg" });
  private readonly problems = h("ul", { class: "problems" });
  private readonly lockBanner = h("div", { class: "notice", "data-tone": "warn" }, "Armed – settings are locked. Disarm to edit, write or save.");
  private readonly btn = {
    reload: h("button", { class: "secondary", title: "Read the outputs area from the board" }, "Read from board"),
    discard: h("button", { class: "secondary", title: "Drop the edits that are not written" }, "Discard edits"),
    write: h("button", { title: "Send to the board – applied at once, not stored" }, "Write"),
    save: h("button", { title: "Store all settings on the board (survive a reboot)" }, "Save"),
  };
  private readonly rows: { label: HTMLElement; input: HTMLElement; pulse: HTMLElement; fsUs: HTMLInputElement; row: HTMLElement }[] = [];

  constructor() {
    this.btn.reload.addEventListener("click", () => void this.reload(true));
    this.btn.discard.addEventListener("click", () => this.discard());
    this.btn.write.addEventListener("click", () => void this.write());
    this.btn.save.addEventListener("click", () => void this.save());

    const table = h(
      "table",
      { class: "out-table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...["Output", "Source", "Reverse", "Min [µs]", "Center [µs]", "Max [µs]", "RC loss", "Fixed [µs]", "Input", "Pulse"].map((t) => h("th", {}, t)),
        ),
      ),
    );
    const tbody = h("tbody");
    for (let i = 0; i < OUTPUT_COUNT; i++) tbody.append(this.buildRow(i));
    table.append(tbody);

    const rates = h("div", { class: "rates" });
    for (let g = 0; g < OUTPUT_GROUPS; g++) {
      const members = OUTPUT_GROUP_OF.flatMap((og, i) => (og === g ? [`OUT${i + 1}`] : [])).join(", ");
      const input = this.number(`rate${g}`, RATE_MIN_HZ, RATE_MAX_HZ, (c) => c.ratesHz[g]!, (c, v) => (c.ratesHz[g] = v));
      rates.append(h("label", { class: "rate" }, h("span", { class: "rate-timer" }, GROUP_TIMERS[g]!), h("span", { class: "rate-members" }, members), input, h("span", { class: "unit" }, "Hz")));
    }

    const arm = this.select("arm", channelOptions(false), (c) => c.armChannel, (c, v) => (c.armChannel = v));
    const esc = this.select(
      "esc",
      Array.from({ length: OUTPUT_COUNT }, (_, i): [number, string] => [i + 1, `OUT${i + 1}`]),
      (c) => c.escOutput,
      (c, v) => (c.escOutput = v),
    );

    this.fieldset.append(
      h(
        "div",
        { class: "grid" },
        h(
          "section",
          { class: "card wide" },
          h("h2", {}, "Outputs"),
          h(
            "p",
            { class: "hint" },
            "Channel 1000 / 1500 / 2000 µs → min / center / max (hard limits). Disarmed, the servos follow the sticks with the new values right after Write; the ESC output stays at its center.",
          ),
          h("div", { class: "table-wrap" }, table),
        ),
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Arming"),
          h(
            "dl",
            { class: "fields form" },
            h("dt", {}, "Arm switch"),
            h("dd", {}, arm),
            h("dt", {}, "ESC output"),
            h("dd", {}, esc),
          ),
          h("p", { class: "hint" }, "The ESC output is held at its center while disarmed; arming needs its input near center."),
        ),
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Frame rate per timer"),
          rates,
          h("p", { class: "hint" }, `${RATE_MIN_HZ}–${RATE_MAX_HZ} Hz. Outputs of one timer share the rate; analog servos usually need 50 Hz.`),
        ),
      ),
    );

    const bar = h(
      "section",
      { class: "card toolbar" },
      h("div", { class: "toolbar-text" }, this.syncText, this.message),
      h("div", { class: "buttons" }, this.btn.reload, this.btn.discard, this.btn.write, this.btn.save),
      this.problems,
    );
    this.lockBanner.hidden = true;
    this.root.append(this.lockBanner, bar, this.fieldset);
    this.refresh();
  }

  /** Unsaved edits or written-but-not-saved values (leave-page warning) */
  get hasUnsavedWork(): boolean {
    return this.dirty || this.writtenUnsaved;
  }

  private get dirty(): boolean {
    return !!this.board && !!this.edit && !sameOutputs(this.board, this.edit);
  }

  /* ------------------------------------------------------------ connection */

  attach(client: MspClient): void {
    this.client = client;
    void this.reload(false);
  }

  detach(): void {
    this.client = null;
    this.busy = "";
    this.saveAcceptedAt = null;
    this.refresh();
  }

  /** Poll sample; sentAt = performance.now() when the poll was sent */
  update(sample: StatusSample, sentAt: number): void {
    const s = sample.status;
    const locked = (s.flags & STATUS_FLAG.LOCKED) !== 0 || s.outputState === 2;
    if (locked !== this.locked) {
      this.locked = locked;
      this.refresh();
    }

    if (this.saveAcceptedAt !== null && sentAt > this.saveAcceptedAt) {
      const saving = (s.flags & STATUS_FLAG.SAVING) !== 0 || s.lastSave === 1;
      if (!saving) {
        this.saveAcceptedAt = null;
        if (s.lastSave === 2) {
          this.writtenUnsaved = false;
          this.say("Saved on the board.", "ok");
        } else {
          this.say("Save FAILED on the board (see CLI 'settings').", "bad");
        }
        this.refresh();
      }
    }

    const c = this.edit;
    for (let i = 0; i < OUTPUT_COUNT; i++) {
      const row = this.rows[i]!;
      const src = c?.outputs[i]?.source ?? 0;
      const us = src ? sample.rc.channels[src - 1] : undefined;
      setText(row.input, src ? (sample.rc.linkActive && us ? String(us) : "no link") : "-");
      const p = sample.live.pulses[i] ?? 0;
      setText(row.pulse, p ? String(p) : "off");
    }
  }

  /* --------------------------------------------------------------- actions */

  private async reload(userAction: boolean): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (userAction && this.dirty && !confirm("Drop the edits that are not written and read the outputs from the board?")) return;
    this.busy = "reading";
    this.refresh();
    try {
      const cfg = decodeOutputs(await client.request(MSP.OUTPUTS));
      if (client !== this.client) return;
      // Keep edits over a reconnect (reboot, replug); a user reload replaces them
      let keepEdits = !userAction && this.dirty;
      if (!userAction && this.writtenUnsaved && this.board && !sameOutputs(cfg, this.board)) {
        // Rebooted before Save: the written values are gone – offer them again as edits
        this.edit = cloneOutputs(this.board);
        keepEdits = true;
        this.writtenUnsaved = false;
        this.say("The board lost the written values (reboot before Save) – they are kept here as edits: Write and Save again.", "warn");
      }
      this.board = cfg;
      this.loadError = "";
      if (!keepEdits) this.edit = cloneOutputs(cfg);
      this.fill();
      if (userAction) this.say("Read from the board.", "ok");
    } catch (error) {
      if (client !== this.client) return;
      this.loadError = `Reading the outputs failed: ${errorText(error)}`;
    } finally {
      if (client === this.client) this.busy = "";
      this.refresh();
    }
  }

  private discard(): void {
    if (!this.board) return;
    this.edit = cloneOutputs(this.board);
    this.fill();
    this.say("");
    this.refresh();
  }

  private async write(): Promise<void> {
    const client = this.client;
    if (!client || !this.edit || validateOutputs(this.edit).length) return;
    const sent = cloneOutputs(this.edit);
    this.busy = "writing";
    this.refresh();
    try {
      await client.request(MSP.SET_OUTPUTS, encodeOutputs(sent));
      const back = decodeOutputs(await client.request(MSP.OUTPUTS));
      if (client !== this.client) return;
      this.board = back;
      if (sameOutputs(back, sent)) {
        this.writtenUnsaved = true;
        this.say("Written – active on the board, not saved yet.", "ok");
      } else {
        this.say("Written, but the board reads back other values – check and write again.", "bad");
      }
    } catch (error) {
      if (client !== this.client) return;
      this.say(`Write failed: ${errorText(error)}. Nothing changed on the board.`, "bad");
    } finally {
      if (client === this.client) this.busy = "";
      this.refresh();
    }
  }

  private async save(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.dirty && !confirm("Save stores what is active on the board – your edits are not written yet and are not saved. Save anyway?")) return;
    this.busy = "saving";
    this.refresh();
    try {
      await client.request(MSP.SAVE);
      if (client !== this.client) return;
      this.saveAcceptedAt = performance.now();
      this.say("Saving…");
    } catch (error) {
      if (client !== this.client) return;
      this.say(`Save refused: ${errorText(error)}`, "bad");
    } finally {
      if (client === this.client) this.busy = "";
      this.refresh();
    }
  }

  /* ------------------------------------------------------------------ form */

  private buildRow(i: number): HTMLElement {
    const o = (c: OutputsConfig): OutputConfig => c.outputs[i]!;
    const k = (f: keyof OutputConfig) => `out${i}.${f}` as OutputsField;
    const num = (f: "minUs" | "centerUs" | "maxUs" | "failsafeUs") =>
      this.number(k(f), PULSE_MIN_US, PULSE_MAX_US, (c) => o(c)[f], (c, v) => (o(c)[f] = v));

    const label = h("span", { class: "out-tags" });
    const fsUs = num("failsafeUs");
    const rev = h("input", { type: "checkbox" });
    this.bind(k("reverse"), { el: rev, get: (c) => o(c).reverse, set: (c, v) => (o(c).reverse = v as boolean) });
    const input = h("td", { class: "live" });
    const pulse = h("td", { class: "live" });
    const row = h(
      "tr",
      {},
      h("th", { scope: "row" }, h("span", { class: "out-name" }, `OUT${i + 1}`), label),
      h("td", {}, this.select(k("source"), channelOptions(true), (c) => o(c).source, (c, v) => (o(c).source = v))),
      h("td", { class: "center" }, rev),
      h("td", {}, num("minUs")),
      h("td", {}, num("centerUs")),
      h("td", {}, num("maxUs")),
      h("td", {}, this.select(k("failsafe"), FAILSAFE_NAMES.map((t, v): [number, string] => [v, t]), (c) => o(c).failsafe, (c, v) => (o(c).failsafe = v))),
      h("td", {}, fsUs),
      input,
      pulse,
    );
    this.rows.push({ label, input, pulse, fsUs, row });
    return row;
  }

  private number(field: OutputsField, min: number, max: number, get: (c: OutputsConfig) => number, set: (c: OutputsConfig, v: number) => void): HTMLInputElement {
    const el = h("input", { type: "number", min: String(min), max: String(max), step: "1", inputmode: "numeric" });
    this.bind(field, { el, get, set: (c, v) => set(c, v as number) });
    return el;
  }

  private select(field: OutputsField, list: [number, string][], get: (c: OutputsConfig) => number, set: (c: OutputsConfig, v: number) => void): HTMLSelectElement {
    const el = options(h("select"), list);
    this.bind(field, { el, get, set: (c, v) => set(c, v as number) });
    return el;
  }

  private bind(field: OutputsField, b: Binding): void {
    this.bindings.set(field, b);
    const handler = () => {
      if (!this.edit) return;
      const el = b.el;
      // Empty / partial number input = NaN: shown as invalid, Write stays disabled
      const v = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value.trim() === "" ? NaN : Number(el.value);
      b.set(this.edit, v);
      this.refresh();
    };
    b.el.addEventListener(b.el instanceof HTMLSelectElement || (b.el as HTMLInputElement).type === "checkbox" ? "change" : "input", handler);
  }

  /** Edited configuration → controls (after a read / discard) */
  private fill(): void {
    const c = this.edit;
    if (!c) return;
    for (const b of this.bindings.values()) {
      const v = b.get(c);
      if (typeof v === "boolean") (b.el as HTMLInputElement).checked = v;
      else b.el.value = Number.isNaN(v) ? "" : String(v);
    }
  }

  private say(text: string, tone: Tone = ""): void {
    setText(this.message, text);
    this.message.dataset["tone"] = tone;
  }

  /** Enable state, change / problem marks, sync text */
  private refresh(): void {
    const c = this.edit;
    const connected = !!this.client;
    const problems = c ? validateOutputs(c) : [];
    const bad = new Map<OutputsField, string>();
    for (const p of problems) if (!bad.has(p.field)) bad.set(p.field, p.message);

    for (const [field, b] of this.bindings) {
      const changed = !!c && !!this.board && b.get(c) !== b.get(this.board) && !(Number.isNaN(b.get(c)) && Number.isNaN(b.get(this.board)));
      const msg = bad.get(field);
      b.el.classList.toggle("changed", changed);
      b.el.classList.toggle("invalid", !!msg);
      b.el.title = msg ?? (changed && this.board ? `board: ${String(b.get(this.board))}` : "");
    }

    if (c) {
      this.rows.forEach((r, i) => {
        const o = c.outputs[i]!;
        r.fsUs.disabled = o.failsafe !== FAILSAFE.FIXED;
        const tags = [i + 1 === c.escOutput ? "ESC" : "", `${GROUP_TIMERS[OUTPUT_GROUP_OF[i]!]}`].filter(Boolean).join(" · ");
        setText(r.label, tags);
        r.row.classList.toggle("unused", o.source === 0);
        r.row.classList.toggle("esc", i + 1 === c.escOutput);
      });
    }

    const dirty = this.dirty;
    const ready = connected && !!c && !this.busy && !this.locked;
    this.fieldset.disabled = !ready;
    this.lockBanner.hidden = !(connected && this.locked);
    this.btn.reload.disabled = !connected || !!this.busy;
    this.btn.discard.disabled = !dirty || !!this.busy;
    this.btn.write.disabled = !ready || !dirty || problems.length > 0;
    this.btn.save.disabled = !ready || this.saveAcceptedAt !== null;

    this.problems.replaceChildren(
      ...[...new Set(problems.map((p) => `${this.fieldName(p.field)}: ${p.message}`))].map((t) => h("li", {}, t)),
    );

    let sync: [string, Tone];
    if (!connected) sync = [c ? "Not connected – edits are kept, read again after connecting." : "Not connected.", "warn"];
    else if (this.loadError) sync = [this.loadError, "bad"];
    else if (!c) sync = ["Reading the outputs…", ""];
    else if (this.busy) sync = [`${this.busy[0]!.toUpperCase()}${this.busy.slice(1)}…`, ""];
    else if (dirty) sync = [`Edited – not written to the board${problems.length ? ` (${problems.length} problem${problems.length > 1 ? "s" : ""})` : ""}.`, "warn"];
    else if (this.writtenUnsaved) sync = ["Active on the board, not saved – lost on reboot until you Save.", "warn"];
    else sync = ["Same as the board.", "ok"];
    setText(this.syncText, sync[0]);
    this.syncText.dataset["tone"] = sync[1];
  }

  private fieldName(field: OutputsField): string {
    const m = /^out(\d+)\./.exec(field);
    if (m) return `OUT${Number(m[1]) + 1}`;
    const r = /^rate(\d+)$/.exec(field);
    if (r) return `${GROUP_TIMERS[Number(r[1])]} rate`;
    return field === "arm" ? "Arm switch" : "ESC output";
  }
}
