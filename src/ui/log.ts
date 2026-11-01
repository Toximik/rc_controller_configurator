/**
 * \author Toximik
 * \file log.ts
 * \brief Logger page: read / edit / write / save the LOG_CONFIG area
 *        (common editor logic in area.ts) and the logs on the board
 *        (LogsPanel: list, download, erase).
 *
 * One setting: the RC channel whose switch starts / stops a log session.
 */

import { h } from "../dom.ts";
import { cloneLog, decodeLog, encodeLog, sameLog, validateLog, type LogConfig, type LogField } from "../msp/log.ts";
import type { MspClient } from "../msp/client.ts";
import { MSP } from "../msp/protocol.ts";
import { AreaView, channelOptions, type SaveTracker } from "./area.ts";
import { LogsPanel } from "./logs.ts";
import type { StatusSample } from "./status.ts";

export class LogView extends AreaView<LogConfig, LogField> {
  private readonly logs = new LogsPanel();

  constructor(saves: SaveTracker) {
    super(
      {
        name: "log",
        getId: MSP.LOG_CONFIG,
        setId: MSP.SET_LOG_CONFIG,
        decode: decodeLog,
        encode: encodeLog,
        clone: cloneLog,
        same: sameLog,
        validate: validateLog,
      },
      saves,
      "log-page",
    );

    const channel = this.select(
      "switchChannel",
      channelOptions(true),
      (c) => c.switchChannel,
      (c, v) => (c.switchChannel = v),
    );
    const row = (label: string, ...control: Node[]) => [h("dt", {}, label), h("dd", {}, ...control)];

    this.mount(
      h(
        "div",
        { class: "grid grid-roomy" },
        h(
          "section",
          { class: "card" },
          h("h2", {}, "Log switch"),
          h("dl", { class: "fields form" }, ...row("Channel", channel)),
          h(
            "p",
            { class: "hint" },
            "A log session starts when the channel goes above 1700 µs and stops when it goes below 1300 µs (edges with hysteresis). " +
              "None = logging only from the CLI / MSP. While the RC link is lost the session continues. " +
              "While logging the radio's flight-mode telemetry shows \" REC\" (e.g. \"ARMED REC\"), or \" REC FULL\" / \" REC ERR\" " +
              "when the switch is on but the chip is full / a program error ended the session. " +
              "The board status LED blinks fast (5 Hz) while logging.",
          ),
        ),
      ),
    );
    this.root.append(this.logs.root);
  }

  override attach(client: MspClient): void {
    super.attach(client);
    this.logs.attach(client);
  }

  override detach(): void {
    super.detach();
    this.logs.detach();
  }

  override update(sample: StatusSample): void {
    super.update(sample);
    this.logs.update(sample);
  }

  protected fieldName(field: LogField): string {
    return field === "switchChannel" ? "Log switch channel" : field;
  }

  protected live(_sample: StatusSample, _c: LogConfig | null): void {}
}
