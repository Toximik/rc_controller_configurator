/**
 * \author Toximik
 * \file lights.ts
 * \brief Lights page: read / edit / write / save the LIGHTS_CONFIG area
 *        (PHASE2_MSP_PLAN.md step 5b). Common editor logic in area.ts.
 *
 * Functions per light output, user defined modes, mode input (switch or
 * momentary button), turn signal / throttle rules. Live: light on/off,
 * current mode, hazard, driving state, mode / steering channel values.
 */

import { h, setText } from "../dom.ts";
import {
  cloneLights,
  DEADBAND_MAX_US,
  DEADBAND_MIN_US,
  decodeLights,
  encodeLights,
  FN,
  FN_MODE,
  LIGHT_FLAG,
  LIGHT_MODES,
  LIGHT_OUTPUTS,
  MODE_FUNCTIONS,
  OUTPUT_FUNCTIONS,
  sameLights,
  STEER_MAX_US,
  STEER_MIN_US,
  validateLights,
  type LightFlagName,
  type LightsConfig,
  type LightsField,
} from "../msp/lights.ts";
import { DRIVE_STATES } from "../msp/payloads.ts";
import { MSP } from "../msp/protocol.ts";
import { AreaView, channelOptions, type SaveTracker } from "./area.ts";
import type { StatusSample } from "./status.ts";

/** BspLights pins of LIGHT1..8 */
const LIGHT_PINS = ["PB0", "PB1", "PB2", "PC10", "PC1", "PC5", "PA0", "PA1"] as const;

const bit = (mask: number, b: number) => (mask & b) !== 0;
const withBit = (mask: number, b: number, on: boolean) => (on ? mask | b : mask & ~b);

function modeSummary(mask: number): string {
  if ((mask & FN_MODE) === 0) return "all off (also brake / reverse / turn signals)";
  const hazard = bit(mask, FN.LEFT) && bit(mask, FN.RIGHT);
  const names = MODE_FUNCTIONS.filter((f) => bit(mask, FN[f.fn]) && !(hazard && (f.fn === "LEFT" || f.fn === "RIGHT"))).map((f) => f.label.toLowerCase());
  if (hazard) names.push("hazard");
  return names.join(" + ");
}

export class LightsView extends AreaView<LightsConfig, LightsField> {
  private readonly lightRows: { row: HTMLElement; dot: HTMLElement }[] = [];
  private readonly modeRows: { row: HTMLElement; name: HTMLElement; tag: HTMLElement; summary: HTMLElement }[] = [];
  private readonly buttonHazard: HTMLInputElement;
  private readonly live_ = {
    modeUs: h("span", { class: "live-val" }),
    mode: h("span", { class: "live-val" }),
    steerUs: h("span", { class: "live-val" }),
    drive: h("span", { class: "live-val" }),
    hazard: h("span", { class: "live-val" }),
    test: h("div", { class: "notice", "data-tone": "warn" }, "Bench test active on the board (CLI 'light test') – the light logic is ignored until 'light auto'."),
  };

  constructor(saves: SaveTracker) {
    super(
      {
        name: "lights",
        getId: MSP.LIGHTS,
        setId: MSP.SET_LIGHTS,
        decode: decodeLights,
        encode: encodeLights,
        clone: cloneLights,
        same: sameLights,
        validate: validateLights,
      },
      saves,
      "lights-page",
    );

    /* ---- light outputs: functions per output */
    const outHead = h(
      "tr",
      {},
      h("th", {}, "Output"),
      ...OUTPUT_FUNCTIONS.map((f) => h("th", { class: "center", title: f.hint }, f.label)),
      h("th", { class: "center" }, "Now"),
    );
    const outBody = h("tbody");
    for (let i = 0; i < LIGHT_OUTPUTS; i++) {
      const dot = h("span", { class: "light" }, String(i + 1));
      const row = h(
        "tr",
        {},
        h("th", { scope: "row" }, h("span", { class: "out-name" }, `LIGHT${i + 1}`), h("span", { class: "out-tags" }, LIGHT_PINS[i]!)),
        ...OUTPUT_FUNCTIONS.map((f) =>
          h(
            "td",
            { class: "center" },
            this.checkbox(
              `light${i}.${f.fn}`,
              (c) => bit(c.functions[i]!, FN[f.fn]),
              (c, v) => (c.functions[i] = withBit(c.functions[i]!, FN[f.fn], v)),
              `LIGHT${i + 1} ${f.label}`,
            ),
          ),
        ),
        h("td", { class: "center" }, dot),
      );
      outBody.append(row);
      this.lightRows.push({ row, dot });
    }

    /* ---- modes: steady functions per mode */
    const modeHead = h(
      "tr",
      {},
      h("th", {}, "Mode"),
      ...MODE_FUNCTIONS.map((f) => h("th", { class: "center", title: f.hint }, f.label)),
      h("th", {}, "Result"),
    );
    const modeBody = h("tbody");
    for (let m = 0; m < LIGHT_MODES; m++) {
      const name = h("span", { class: "out-name" }, `Mode ${m + 1}`);
      const tag = h("span", { class: "out-tags" });
      const summary = h("td", { class: "summary" });
      const row = h(
        "tr",
        {},
        h("th", { scope: "row" }, name, tag),
        ...MODE_FUNCTIONS.map((f) =>
          h(
            "td",
            { class: "center" },
            this.checkbox(
              `mode${m}.${f.fn}`,
              (c) => bit(c.modes[m]!, FN[f.fn]),
              (c, v) => (c.modes[m] = withBit(c.modes[m]!, FN[f.fn], v)),
              `Mode ${m + 1} ${f.label}`,
            ),
          ),
        ),
        summary,
      );
      modeBody.append(row);
      this.modeRows.push({ row, name, tag, summary });
    }

    /* ---- mode input */
    const flag = (name: LightFlagName, title: string) =>
      this.checkbox(`flag.${name}`, (c) => bit(c.flags, LIGHT_FLAG[name]), (c, v) => (c.flags = withBit(c.flags, LIGHT_FLAG[name], v)), title);
    const modeChannel = this.select("modeChannel", channelOptions(true), (c) => c.modeChannel, (c, v) => (c.modeChannel = v));
    const inputKind = this.select(
      "flag.MODE_BUTTON",
      [
        [0, "switch (position = mode)"],
        [1, "momentary button"],
      ],
      (c) => (bit(c.flags, LIGHT_FLAG.MODE_BUTTON) ? 1 : 0),
      (c, v) => (c.flags = withBit(c.flags, LIGHT_FLAG.MODE_BUTTON, v === 1)),
    );
    const modeCount = this.select(
      "modeCount",
      Array.from({ length: LIGHT_MODES }, (_, i): [number, string] => [i + 1, String(i + 1)]),
      (c) => c.modeCount,
      (c, v) => (c.modeCount = v),
    );
    this.buttonHazard = flag("BUTTON_HAZARD", "Double press toggles the hazard lights");

    /* ---- driving */
    const steerChannel = this.select("steerChannel", channelOptions(true), (c) => c.steerChannel, (c, v) => (c.steerChannel = v));
    const steerUs = this.number("steerThresholdUs", STEER_MIN_US, STEER_MAX_US, (c) => c.steerThresholdUs, (c, v) => (c.steerThresholdUs = v));
    const deadband = this.number("throttleDeadbandUs", DEADBAND_MIN_US, DEADBAND_MAX_US, (c) => c.throttleDeadbandUs, (c, v) => (c.throttleDeadbandUs = v));

    const row = (label: string, ...control: Node[]) => [h("dt", {}, label), h("dd", {}, ...control)];
    const unit = (u: string) => h("span", { class: "unit" }, u);

    this.live_.test.hidden = true;
    this.mount(
      this.live_.test,
      h(
        "div",
        { class: "grid" },
        h(
          "section",
          { class: "card wide" },
          h("h2", {}, "Light outputs"),
          h(
            "p",
            { class: "hint" },
            "An output is on when any of its functions is on. Day / head / bar / tail / rock come from the light mode; brake, reverse and turn signals follow the throttle and steering (while armed); left + right also blink as hazard.",
          ),
          h("div", { class: "table-wrap" }, h("table", { class: "out-table fn-table" }, h("thead", {}, outHead), outBody)),
        ),
        h(
          "section",
          { class: "card wide" },
          h("h2", {}, "Modes"),
          h(
            "p",
            { class: "hint" },
            "Each mode is a set of steady functions. Left + right = hazard. Mode 1 is also the \"off\" of the button's long press. A mode without functions switches brake, reverse and turn signals off too.",
          ),
          h("div", { class: "table-wrap" }, h("table", { class: "out-table fn-table" }, h("thead", {}, modeHead), modeBody)),
        ),
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Mode input"),
          h(
            "dl",
            { class: "fields form" },
            ...row("Channel", modeChannel),
            ...row("Kind", inputKind),
            ...row("Modes in use", modeCount),
            ...row("Double press = hazard", this.buttonHazard),
            ...row("Channel now", this.live_.modeUs),
            ...row("Current mode", this.live_.mode),
          ),
          h(
            "p",
            { class: "hint" },
            "Switch: the positions are spread over 1000–2000 µs (nearest wins), position n = mode n. " +
              "Button (pressed > 1700 µs): short press = next mode, long press (1 s) = mode 1 + hazard off, double press = hazard on / off (then a short press acts 0.4 s after the release). " +
              "No channel = mode 1. The mode is kept in RAM only (after a reset: mode 1).",
          ),
        ),
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Turn signals and throttle"),
          h(
            "dl",
            { class: "fields form" },
            ...row("Steering channel", steerChannel),
            ...row("Steering reversed", flag("STEER_REVERSE", "Steering right = channel below 1500 µs")),
            ...row("Turn signal beyond", steerUs, unit("µs")),
            ...row("Steering now", this.live_.steerUs),
            ...row("Throttle reversed", flag("THROTTLE_REVERSE", "Forward = throttle channel below 1500 µs")),
            ...row("Direct reverse (crawler ESC)", flag("DIRECT_REVERSE", "Stick back = reverse at once, no brake step")),
            ...row("Throttle dead band", h("span", {}, "± "), deadband, unit("µs")),
            ...row("Drive state", this.live_.drive),
            ...row("Hazard", this.live_.hazard),
          ),
          h(
            "p",
            { class: "hint" },
            "Throttle = source channel of the ESC output (Outputs page), counted only while armed. Turn signals only while standing (neutral / braking), off below 3/4 of the threshold. " +
              "Without direct reverse: stick back after forward = brake, back to neutral and back again = reverse. RC loss / failsafe: hazard + brake in any mode.",
          ),
        ),
      ),
    );
  }

  protected live(sample: StatusSample, c: LightsConfig | null): void {
    const live = sample.live;
    this.lightRows.forEach((r, i) => {
      const on = (live.lightMask & (1 << i)) !== 0;
      r.dot.dataset["on"] = on ? "1" : "";
      r.dot.title = on ? "on" : "off";
    });
    this.modeRows.forEach((r, m) => r.row.classList.toggle("current", m === live.lightMode));
    this.live_.test.hidden = !live.lightTest;

    const chan = (ch: number) => {
      if (!ch) return "-";
      const us = sample.rc.channels[ch - 1];
      return sample.rc.linkActive && us ? `CH${ch} ${us} µs` : `CH${ch} no link`;
    };
    setText(this.live_.modeUs, chan(c?.modeChannel ?? 0));
    setText(this.live_.mode, `mode ${live.lightMode + 1}${live.lightTest ? " (bench test)" : ""}`);
    setText(this.live_.steerUs, chan(c?.steerChannel ?? 0));
    setText(this.live_.drive, `${DRIVE_STATES[live.drive] ?? String(live.drive)}${sample.status.outputState === 2 ? "" : " (disarmed: throttle ignored)"}`);
    setText(this.live_.hazard, live.hazardOn ? (live.hazardByButton ? "on (button)" : "on") : "off");
    this.live_.hazard.dataset["tone"] = live.hazardOn ? "warn" : "";
  }

  protected refreshForm(c: LightsConfig): void {
    const button = bit(c.flags, LIGHT_FLAG.MODE_BUTTON);
    this.buttonHazard.disabled = !button || c.modeChannel === 0;
    this.lightRows.forEach((r, i) => r.row.classList.toggle("unused", (c.functions[i] ?? 0) === 0));
    this.modeRows.forEach((r, m) => {
      const spare = m >= c.modeCount;
      r.row.classList.toggle("unused", spare);
      const tags = [spare ? "spare" : "", m === 0 && button ? "long press" : ""].filter(Boolean).join(" · ");
      setText(r.tag, tags);
      setText(r.summary, modeSummary(c.modes[m] ?? 0));
    });
  }

  protected fieldName(field: LightsField): string {
    const l = /^light(\d+)/.exec(field);
    if (l) return `LIGHT${Number(l[1]) + 1}`;
    const m = /^mode(\d+)/.exec(field);
    if (m) return `Mode ${Number(m[1]) + 1}`;
    const names: Record<string, string> = {
      modeChannel: "Mode channel",
      modeCount: "Modes in use",
      steerChannel: "Steering channel",
      steerThresholdUs: "Turn signal threshold",
      throttleDeadbandUs: "Throttle dead band",
      flags: "Options",
    };
    return names[field] ?? field.replace(/^flag\./, "");
  }
}
