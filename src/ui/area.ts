/**
 * \author Toximik
 * \file area.ts
 * \brief Common part of the settings pages (outputs, lights): read / edit /
 *        validate / write / save one MSP settings area, locked while the
 *        board is armed (the board refuses every write then anyway, error 4).
 *
 * Write = the area's SET message, applied by the board at once (RAM), then
 * read back and compared. Save = MSP SAVE, which stores ALL areas; its result
 * comes from the STATUS poll (saving flag, last save result) and is shared by
 * every page through one SaveTracker.
 */

import { h, setText } from "../dom.ts";
import { MspErrorReply, type MspClient } from "../msp/client.ts";
import { STATUS_FLAG } from "../msp/payloads.ts";
import { MSP } from "../msp/protocol.ts";
import type { StatusSample } from "./status.ts";

export type Tone = "" | "ok" | "warn" | "bad";

/** Codec + rules of one settings area */
export interface AreaSpec<T, F extends string> {
  /** Lower case, for messages ("outputs") */
  name: string;
  getId: number;
  setId: number;
  decode(d: Uint8Array): T;
  encode(c: T): Uint8Array;
  clone(c: T): T;
  same(a: T, b: T): boolean;
  validate(c: T): { field: F; message: string }[];
}

/** A form control bound to one field of the edited configuration */
interface Binding<T> {
  el: HTMLInputElement | HTMLSelectElement;
  get(c: T): number | boolean;
  set(c: T, v: number | boolean): void;
}

export function errorText(error: unknown): string {
  return error instanceof MspErrorReply ? `board refused: ${error.message.replace(/^0x[0-9a-f]+: /, "")}` : (error as Error).message;
}

export const channelOptions = (withNone: boolean, max = 16): [number, string][] => [
  ...(withNone ? ([[0, "none"]] as [number, string][]) : []),
  ...Array.from({ length: max }, (_, i): [number, string] => [i + 1, `CH${i + 1}`]),
];

export function isLocked(sample: StatusSample): boolean {
  return (sample.status.flags & STATUS_FLAG.LOCKED) !== 0 || sample.status.outputState === 2;
}

type SaveEvent = "started" | "ok" | "failed" | "refused";

/** One SAVE at a time for all pages; result from the status poll */
export class SaveTracker {
  /** performance.now() of the accepted SAVE reply, null = no save pending */
  private acceptedAt: number | null = null;
  private readonly listeners = new Set<(e: SaveEvent, detail?: string) => void>();

  get pending(): boolean {
    return this.acceptedAt !== null;
  }

  listen(fn: (e: SaveEvent, detail?: string) => void): void {
    this.listeners.add(fn);
  }

  private emit(e: SaveEvent, detail?: string): void {
    for (const fn of this.listeners) fn(e, detail);
  }

  /** Sends SAVE; throws when the board refuses it */
  async save(client: MspClient): Promise<void> {
    try {
      await client.request(MSP.SAVE);
    } catch (error) {
      this.emit("refused", errorText(error));
      throw error;
    }
    this.acceptedAt = performance.now();
    this.emit("started");
  }

  /** Poll sample; sentAt = performance.now() when the poll was sent */
  update(sample: StatusSample, sentAt: number): void {
    if (this.acceptedAt === null || sentAt <= this.acceptedAt) return;
    const s = sample.status;
    const saving = (s.flags & STATUS_FLAG.SAVING) !== 0 || s.lastSave === 1;
    if (saving) return;
    this.acceptedAt = null;
    this.emit(s.lastSave === 2 ? "ok" : "failed");
  }

  reset(): void {
    this.acceptedAt = null;
  }
}

export abstract class AreaView<T, F extends string> {
  readonly root: HTMLElement;

  protected client: MspClient | null = null;
  protected board: T | null = null;
  protected edit: T | null = null;
  protected locked = false;
  private loadError = "";
  private busy = "";
  private writtenUnsaved = false;

  private readonly bindings = new Map<F, Binding<T>>();
  protected readonly fieldset = h("fieldset", { class: "plain" });
  private readonly syncText = h("div", { class: "sync" });
  private readonly message = h("div", { class: "msg" });
  private readonly problems = h("ul", { class: "problems" });
  private readonly lockBanner = h("div", { class: "notice", "data-tone": "warn" }, "Armed – settings are locked. Disarm to edit, write or save.");
  private readonly btn = {
    reload: h("button", { class: "secondary" }, "Read from board"),
    discard: h("button", { class: "secondary", title: "Drop the edits that are not written" }, "Discard edits"),
    write: h("button", { title: "Send to the board – applied at once, not stored" }, "Write"),
    save: h("button", { title: "Store all settings on the board (survive a reboot)" }, "Save"),
  };

  constructor(
    protected readonly spec: AreaSpec<T, F>,
    private readonly saves: SaveTracker,
    pageClass: string,
  ) {
    this.root = h("div", { class: `page ${pageClass}` });
    this.btn.reload.title = `Read the ${spec.name} area from the board`;
    this.btn.reload.addEventListener("click", () => void this.reload(true));
    this.btn.discard.addEventListener("click", () => this.discard());
    this.btn.write.addEventListener("click", () => void this.write());
    this.btn.save.addEventListener("click", () => void this.save());
    saves.listen((e, detail) => this.onSave(e, detail));
  }

  /** Called at the end of the subclass constructor with the form content */
  protected mount(...content: Node[]): void {
    this.fieldset.append(...content);
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

  /** Readable name of a field for the problem list */
  protected abstract fieldName(field: F): string;
  /** Live values from the poll (edited configuration, may be null) */
  protected abstract live(sample: StatusSample, c: T | null): void;
  /** Dynamic form state (enable / tags) after every change */
  protected refreshForm(_c: T): void {}

  /** Unsaved edits or written-but-not-saved values (leave-page warning) */
  get hasUnsavedWork(): boolean {
    return this.dirty || this.writtenUnsaved;
  }

  get dirty(): boolean {
    return !!this.board && !!this.edit && !this.spec.same(this.board, this.edit);
  }

  /* ------------------------------------------------------------ connection */

  attach(client: MspClient): void {
    this.client = client;
    void this.reload(false);
  }

  detach(): void {
    this.client = null;
    this.busy = "";
    this.refresh();
  }

  /** Poll sample; the save result comes through the SaveTracker */
  update(sample: StatusSample): void {
    const locked = isLocked(sample);
    if (locked !== this.locked) {
      this.locked = locked;
      this.refresh();
    }
    this.live(sample, this.edit);
  }

  /* --------------------------------------------------------------- actions */

  private async reload(userAction: boolean): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (userAction && this.dirty && !confirm(`Drop the edits that are not written and read the ${this.spec.name} from the board?`)) return;
    this.busy = "reading";
    this.refresh();
    try {
      const cfg = this.spec.decode(await client.request(this.spec.getId));
      if (client !== this.client) return;
      // Keep edits over a reconnect (reboot, replug); a user reload replaces them
      let keepEdits = !userAction && this.dirty;
      if (!userAction && this.writtenUnsaved && this.board && !this.spec.same(cfg, this.board)) {
        // Rebooted before Save: the written values are gone – offer them again as edits
        this.edit = this.spec.clone(this.board);
        keepEdits = true;
        this.writtenUnsaved = false;
        this.say("The board lost the written values (reboot before Save) – they are kept here as edits: Write and Save again.", "warn");
      }
      this.board = cfg;
      this.loadError = "";
      if (!keepEdits) this.edit = this.spec.clone(cfg);
      this.fill();
      if (userAction) this.say("Read from the board.", "ok");
    } catch (error) {
      if (client !== this.client) return;
      this.loadError = `Reading the ${this.spec.name} failed: ${errorText(error)}`;
    } finally {
      if (client === this.client) this.busy = "";
      this.refresh();
    }
  }

  private discard(): void {
    if (!this.board) return;
    this.edit = this.spec.clone(this.board);
    this.fill();
    this.say("");
    this.refresh();
  }

  private async write(): Promise<void> {
    const client = this.client;
    if (!client || !this.edit || this.spec.validate(this.edit).length) return;
    const sent = this.spec.clone(this.edit);
    this.busy = "writing";
    this.refresh();
    try {
      await client.request(this.spec.setId, this.spec.encode(sent));
      const back = this.spec.decode(await client.request(this.spec.getId));
      if (client !== this.client) return;
      this.board = back;
      if (this.spec.same(back, sent)) {
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
      await this.saves.save(client);
    } catch {
      // reported through onSave("refused")
    } finally {
      if (client === this.client) this.busy = "";
      this.refresh();
    }
  }

  private onSave(e: SaveEvent, detail?: string): void {
    if (e === "started") this.say("Saving…");
    else if (e === "ok") {
      // SAVE stores every area: values written on any page are saved now
      this.writtenUnsaved = false;
      this.say("Saved on the board.", "ok");
    } else if (e === "failed") this.say("Save FAILED on the board (see CLI 'settings').", "bad");
    else this.say(`Save refused: ${detail ?? ""}`, "bad");
    this.refresh();
  }

  /* ------------------------------------------------------------------ form */

  protected number(field: F, min: number, max: number, get: (c: T) => number, set: (c: T, v: number) => void): HTMLInputElement {
    const el = h("input", { type: "number", min: String(min), max: String(max), step: "1", inputmode: "numeric" });
    this.bind(field, { el, get, set: (c, v) => set(c, v as number) });
    return el;
  }

  protected select(field: F, list: [number, string][], get: (c: T) => number, set: (c: T, v: number) => void): HTMLSelectElement {
    const el = h("select");
    el.append(...list.map(([v, t]) => h("option", { value: String(v) }, t)));
    this.bind(field, { el, get, set: (c, v) => set(c, v as number) });
    return el;
  }

  protected checkbox(field: F, get: (c: T) => boolean, set: (c: T, v: boolean) => void, title = ""): HTMLInputElement {
    const el = h("input", { type: "checkbox" });
    if (title) el.setAttribute("aria-label", title);
    this.bind(field, { el, get, set: (c, v) => set(c, v as boolean) });
    return el;
  }

  private bind(field: F, b: Binding<T>): void {
    this.bindings.set(field, b);
    const isCheck = b.el instanceof HTMLInputElement && b.el.type === "checkbox";
    const handler = () => {
      if (!this.edit) return;
      const el = b.el;
      // Empty / partial number input = NaN: shown as invalid, Write stays disabled
      const v = isCheck ? (el as HTMLInputElement).checked : el.value.trim() === "" ? NaN : Number(el.value);
      b.set(this.edit, v);
      this.refresh();
    };
    b.el.addEventListener(b.el instanceof HTMLSelectElement || isCheck ? "change" : "input", handler);
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

  protected say(text: string, tone: Tone = ""): void {
    setText(this.message, text);
    this.message.dataset["tone"] = tone;
  }

  /** Enable state, change / problem marks, sync text */
  protected refresh(): void {
    const c = this.edit;
    const connected = !!this.client;
    const problems = c ? this.spec.validate(c) : [];
    const bad = new Map<F, string>();
    for (const p of problems) if (!bad.has(p.field)) bad.set(p.field, p.message);

    for (const [field, b] of this.bindings) {
      const changed = !!c && !!this.board && b.get(c) !== b.get(this.board) && !(Number.isNaN(b.get(c)) && Number.isNaN(b.get(this.board)));
      const msg = bad.get(field);
      b.el.classList.toggle("changed", changed);
      b.el.classList.toggle("invalid", !!msg);
      const was = this.board ? b.get(this.board) : "";
      b.el.title = msg ?? (changed && this.board ? `board: ${typeof was === "boolean" ? (was ? "on" : "off") : String(was)}` : "");
    }

    if (c) this.refreshForm(c);

    const dirty = this.dirty;
    const ready = connected && !!c && !this.busy && !this.locked;
    this.fieldset.disabled = !ready;
    this.lockBanner.hidden = !(connected && this.locked);
    this.btn.reload.disabled = !connected || !!this.busy;
    this.btn.discard.disabled = !dirty || !!this.busy;
    this.btn.write.disabled = !ready || !dirty || problems.length > 0;
    this.btn.save.disabled = !ready || this.saves.pending;

    this.problems.replaceChildren(
      ...[...new Set(problems.map((p) => `${this.fieldName(p.field)}: ${p.message}`))].map((t) => h("li", {}, t)),
    );

    let sync: [string, Tone];
    if (!connected) sync = [c ? "Not connected – edits are kept, read again after connecting." : "Not connected.", "warn"];
    else if (this.loadError) sync = [this.loadError, "bad"];
    else if (!c) sync = [`Reading the ${this.spec.name}…`, ""];
    else if (this.busy) sync = [`${this.busy[0]!.toUpperCase()}${this.busy.slice(1)}…`, ""];
    else if (dirty) sync = [`Edited – not written to the board${problems.length ? ` (${problems.length} problem${problems.length > 1 ? "s" : ""})` : ""}.`, "warn"];
    else if (this.writtenUnsaved) sync = ["Active on the board, not saved – lost on reboot until you Save.", "warn"];
    else sync = ["Same as the board.", "ok"];
    setText(this.syncText, sync[0]);
    this.syncText.dataset["tone"] = sync[1];
  }
}
