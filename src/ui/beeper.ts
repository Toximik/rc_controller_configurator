/**
 * \author Toximik
 * \file beeper.ts
 * \brief Beeper page: read / edit / write / save the BEEPER_CONFIG area
 *        (common editor logic in area.ts).
 *
 * Settings: the RC channel of the beeper switch, the link beep, the lost
 * alarm and its delay.
 */

import { h } from "../dom.ts";
import {
  BEEPER_DELAY_MAX_S,
  BEEPER_DELAY_MIN_S,
  BEEPER_FLAG_LINK,
  BEEPER_FLAG_LOST,
  cloneBeeper,
  decodeBeeper,
  encodeBeeper,
  sameBeeper,
  validateBeeper,
  type BeeperConfig,
  type BeeperField,
} from "../msp/beeper.ts";
import { MSP } from "../msp/protocol.ts";
import { AreaView, channelOptions, type SaveTracker } from "./area.ts";
import type { StatusSample } from "./status.ts";

const bit = (mask: number, b: number) => (mask & b) !== 0;
const withBit = (mask: number, b: number, on: boolean) => (on ? mask | b : mask & ~b);

const FIELD_NAMES: Record<BeeperField, string> = {
  switchChannel: "Beeper switch channel",
  linkBeep: "Beeper flags",
  lostAlarm: "Lost alarm",
  lostDelayS: "Lost alarm delay",
};

export class BeeperView extends AreaView<BeeperConfig, BeeperField> {
  constructor(saves: SaveTracker) {
    super(
      {
        name: "beeper",
        getId: MSP.BEEPER_CONFIG,
        setId: MSP.SET_BEEPER_CONFIG,
        decode: decodeBeeper,
        encode: encodeBeeper,
        clone: cloneBeeper,
        same: sameBeeper,
        validate: validateBeeper,
      },
      saves,
      "beeper-page",
    );

    const channel = this.select(
      "switchChannel",
      channelOptions(true),
      (c) => c.switchChannel,
      (c, v) => (c.switchChannel = v),
    );
    const link = this.checkbox("linkBeep", (c) => bit(c.flags, BEEPER_FLAG_LINK), (c, v) => (c.flags = withBit(c.flags, BEEPER_FLAG_LINK, v)), "Link beep");
    const lost = this.checkbox("lostAlarm", (c) => bit(c.flags, BEEPER_FLAG_LOST), (c, v) => (c.flags = withBit(c.flags, BEEPER_FLAG_LOST, v)), "Lost alarm");
    const delay = this.number("lostDelayS", BEEPER_DELAY_MIN_S, BEEPER_DELAY_MAX_S, (c) => c.lostDelayS, (c, v) => (c.lostDelayS = v));
    const row = (label: string, ...control: Node[]) => [h("dt", {}, label), h("dd", {}, ...control)];

    this.mount(
      h(
        "div",
        { class: "grid grid-roomy" },
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Beeper"),
          h(
            "dl",
            { class: "fields form" },
            ...row("Channel", channel),
            ...row("Link beep", link),
            ...row("Lost alarm", lost),
            ...row("Lost alarm delay", delay, document.createTextNode(" s")),
          ),
          h(
            "p",
            { class: "hint" },
            "The beeper is the active buzzer on the board. Switch on the radio: on above 1700 µs, off below 1300 µs; it beeps continuously while the switch is on " +
              "(locator / horn). While the RC link is lost the last switch position is kept. None = no switch. " +
              "Link beep: two short beeps every time the RC link is established (first link after power-on and every re-link after an RC loss). " +
              "Lost alarm: when the RC link has been lost for longer than the delay (10..3600 s), a 0.5 s beep every 2 s until the link comes back; " +
              "never before the first link after power-on. " +
              "Like every settings page: locked while armed (Write and Save are refused). The CLI ('beep ...') may change it while armed.",
          ),
        ),
      ),
    );
  }

  protected fieldName(field: BeeperField): string {
    return FIELD_NAMES[field];
  }

  protected live(_sample: StatusSample, _c: BeeperConfig | null): void {}
}
