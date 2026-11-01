/**
 * \author Toximik
 * \file outputs.ts
 * \brief Outputs page: read / edit / write / save the OUTPUTS_CONFIG area
 *        (PHASE2_MSP_PLAN.md section 6). Common editor logic in area.ts.
 */

import { h, setText } from "../dom.ts";
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
  sameOutputs,
  validateOutputs,
  type OutputConfig,
  type OutputsConfig,
  type OutputsField,
} from "../msp/outputs.ts";
import { MSP } from "../msp/protocol.ts";
import { AreaView, channelOptions, type SaveTracker } from "./area.ts";
import type { StatusSample } from "./status.ts";

export class OutputsView extends AreaView<OutputsConfig, OutputsField> {
  private readonly rows: { label: HTMLElement; input: HTMLElement; pulse: HTMLElement; fsUs: HTMLInputElement; row: HTMLElement }[] = [];

  constructor(saves: SaveTracker) {
    super(
      {
        name: "outputs",
        getId: MSP.OUTPUTS,
        setId: MSP.SET_OUTPUTS,
        decode: decodeOutputs,
        encode: encodeOutputs,
        clone: cloneOutputs,
        same: sameOutputs,
        validate: validateOutputs,
      },
      saves,
      "outputs",
    );

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

    this.mount(
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
  }

  protected live(sample: StatusSample, c: OutputsConfig | null): void {
    for (let i = 0; i < OUTPUT_COUNT; i++) {
      const row = this.rows[i]!;
      const src = c?.outputs[i]?.source ?? 0;
      const us = src ? sample.rc.channels[src - 1] : undefined;
      setText(row.input, src ? (sample.rc.linkActive && us ? String(us) : "no link") : "-");
      const p = sample.live.pulses[i] ?? 0;
      setText(row.pulse, p ? String(p) : "off");
    }
  }

  private buildRow(i: number): HTMLElement {
    const o = (c: OutputsConfig): OutputConfig => c.outputs[i]!;
    const k = (f: keyof OutputConfig) => `out${i}.${f}` as OutputsField;
    const num = (f: "minUs" | "centerUs" | "maxUs" | "failsafeUs") =>
      this.number(k(f), PULSE_MIN_US, PULSE_MAX_US, (c) => o(c)[f], (c, v) => (o(c)[f] = v));

    const label = h("span", { class: "out-tags" });
    const fsUs = num("failsafeUs");
    const rev = this.checkbox(k("reverse"), (c) => o(c).reverse, (c, v) => (o(c).reverse = v), `OUT${i + 1} reverse`);
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

  protected refreshForm(c: OutputsConfig): void {
    this.rows.forEach((r, i) => {
      const o = c.outputs[i]!;
      r.fsUs.disabled = o.failsafe !== FAILSAFE.FIXED;
      const tags = [i + 1 === c.escOutput ? "ESC" : "", `${GROUP_TIMERS[OUTPUT_GROUP_OF[i]!]}`].filter(Boolean).join(" · ");
      setText(r.label, tags);
      r.row.classList.toggle("unused", o.source === 0);
      r.row.classList.toggle("esc", i + 1 === c.escOutput);
    });
  }

  protected fieldName(field: OutputsField): string {
    const m = /^out(\d+)\./.exec(field);
    if (m) return `OUT${Number(m[1]) + 1}`;
    const r = /^rate(\d+)$/.exec(field);
    if (r) return `${GROUP_TIMERS[Number(r[1])]} rate`;
    return field === "arm" ? "Arm switch" : "ESC output";
  }
}
