/**
 * \author Toximik
 * \file status.ts
 * \brief Status page: output state, arm blocks, link, RC channels, outputs,
 *        battery, IMU, settings. Built once, updated in place at the poll rate.
 */

import { h, setText } from "../dom.ts";
import {
  armBlockNames,
  DRIVE_STATES,
  FAILSAFE_SOURCE_NONE,
  LIGHT_COUNT,
  OUTPUT_COUNT,
  OUTPUT_STATES,
  RC_CHANNELS,
  SAVE_RESULTS,
  SETTINGS_STATES,
  STATUS_FLAG,
  type Battery,
  type OutputsLive,
  type RcData,
  type Status,
} from "../msp/payloads.ts";

/** RC bar scale [us] (CRSF 988..2012) */
const BAR_MIN = 988;
const BAR_MAX = 2012;

export interface StatusSample {
  status: Status;
  rc: RcData;
  battery: Battery;
  live: OutputsLive;
}

/** Key / value row */
class Field {
  readonly value = h("dd");
  readonly row: HTMLElement[];
  constructor(label: string) {
    this.row = [h("dt", {}, label), this.value];
  }
  set(text: string, tone: "" | "ok" | "warn" | "bad" = ""): void {
    setText(this.value, text);
    if (this.value.dataset["tone"] !== tone) this.value.dataset["tone"] = tone;
  }
}

function card(title: string, ...body: Node[]): HTMLElement {
  return h("section", { class: "card" }, h("h2", {}, title), ...body);
}

function fields(list: Field[]): HTMLElement {
  return h("dl", { class: "fields" }, ...list.flatMap((f) => f.row));
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export class StatusView {
  readonly root = h("div", { class: "grid" });

  private readonly stateBadge = h("div", { class: "state" });
  private readonly modeText = h("div", { class: "mode" });
  private readonly blocks = h("ul", { class: "blocks" });
  private readonly f = {
    outEnable: new Field("Servo/ESC outputs"),
    failsafe: new Field("Failsafe"),
    arms: new Field("Arms / RC lost"),

    link: new Field("Link"),
    lq: new Field("Link quality"),
    rssi: new Field("RSSI ant 1 / 2"),
    snr: new Field("SNR / RF profile"),
    rcRate: new Field("RC frames"),
    linkLost: new Field("Link lost"),

    battery: new Field("Battery"),
    vdda: new Field("VDDA"),
    temp: new Field("MCU temperature"),

    imu: new Field("IMU"),
    imuFaults: new Field("IMU faults"),

    settings: new Field("Settings"),
    lastSave: new Field("Last save"),
    lock: new Field("Write lock"),
    repaired: new Field("Repaired"),

    uptime: new Field("Uptime"),
    load: new Field("CPU load (tasks)"),
    crash: new Field("Crash record"),

    lightMode: new Field("Light mode"),
    hazard: new Field("Hazard"),
    drive: new Field("Drive"),
  };
  private readonly rcBars: { fill: HTMLElement; value: HTMLElement }[] = [];
  private readonly pulses: HTMLElement[] = [];
  private readonly lights: HTMLElement[] = [];

  constructor() {
    const f = this.f;

    const rcList = h("div", { class: "bars" });
    for (let i = 0; i < RC_CHANNELS; i++) {
      const fill = h("div", { class: "fill" });
      const value = h("span", { class: "val" });
      rcList.append(h("div", { class: "bar" }, h("span", { class: "lbl" }, `CH${i + 1}`), h("div", { class: "track" }, h("div", { class: "mid" }), fill), value));
      this.rcBars.push({ fill, value });
    }

    const pulseList = h("div", { class: "pulses" });
    for (let i = 0; i < OUTPUT_COUNT; i++) {
      const v = h("span", { class: "num" });
      pulseList.append(h("div", { class: "pulse" }, h("span", { class: "lbl" }, `OUT${i + 1}`), v));
      this.pulses.push(v);
    }
    const lightList = h("div", { class: "lights" });
    for (let i = 0; i < LIGHT_COUNT; i++) {
      const dot = h("span", { class: "light", title: `LIGHT${i + 1}` }, String(i + 1));
      lightList.append(dot);
      this.lights.push(dot);
    }

    this.root.append(
      card("State", this.stateBadge, this.modeText, this.blocks, fields([f.outEnable, f.failsafe, f.arms])),
      card("RC link", fields([f.link, f.lq, f.rssi, f.snr, f.rcRate, f.linkLost])),
      h("section", { class: "card wide" }, h("h2", {}, "RC channels [µs]"), rcList),
      card("Outputs [µs]", pulseList, h("h3", {}, "Lights"), lightList, fields([f.lightMode, f.hazard, f.drive])),
      card("Power", fields([f.battery, f.vdda, f.temp])),
      card("System", fields([f.uptime, f.load, f.imu, f.imuFaults, f.crash])),
      card("Settings", fields([f.settings, f.lastSave, f.lock, f.repaired])),
    );
  }

  update({ status: s, rc, battery: b, live }: StatusSample): void {
    const f = this.f;
    const state = OUTPUT_STATES[s.outputState] ?? `state ${s.outputState}`;
    setText(this.stateBadge, state);
    this.stateBadge.dataset["state"] = state;
    setText(this.modeText, s.mode && s.mode !== state ? s.mode : "");

    const blocks = armBlockNames(s.armBlock);
    const blockText = s.outputState === 2 ? ["armed"] : blocks.length ? blocks.map((b) => `blocked: ${b}`) : ["ready to arm"];
    if (this.blocks.dataset["key"] !== blockText.join("|")) {
      this.blocks.dataset["key"] = blockText.join("|");
      this.blocks.replaceChildren(...blockText.map((t) => h("li", { "data-tone": t.startsWith("blocked") ? "warn" : "ok" }, t)));
    }

    const flag = (bit: number) => (s.flags & bit) !== 0;
    f.outEnable.set(flag(STATUS_FLAG.OUTPUT_ENABLE) ? "enabled" : "off (buffers disabled)", flag(STATUS_FLAG.OUTPUT_ENABLE) ? "warn" : "");
    f.failsafe.set(
      flag(STATUS_FLAG.FAILSAFE_TRIPPED)
        ? `TRIPPED (source ${s.failsafeSource})`
        : s.failsafeTrips
          ? `ok, ${s.failsafeTrips} trips (last source ${s.failsafeSource === FAILSAFE_SOURCE_NONE ? "-" : s.failsafeSource})`
          : "ok",
      flag(STATUS_FLAG.FAILSAFE_TRIPPED) ? "bad" : "ok",
    );
    f.arms.set(`${s.armCount} / ${s.rcLostCount}`);

    const linkUp = flag(STATUS_FLAG.LINK_ACTIVE);
    f.link.set(linkUp ? "active" : "no link", linkUp ? "ok" : "bad");
    f.lq.set(linkUp ? `${s.linkQuality} %` : "-", linkUp ? (s.linkQuality >= 70 ? "ok" : "warn") : "");
    f.rssi.set(linkUp ? `-${s.rssi1} / -${s.rssi2} dBm` : "-");
    f.snr.set(linkUp ? `${s.snr} dB / ${s.rfProfile}` : "-");
    f.rcRate.set(`${s.rcFramesPerSecond} /s`);
    f.linkLost.set(`${s.linkLostCount}×`);

    for (let i = 0; i < RC_CHANNELS; i++) {
      const us = rc.channels[i] ?? 0;
      const bar = this.rcBars[i]!;
      const lo = Math.min(Math.max(us, BAR_MIN), BAR_MAX);
      const mid = (BAR_MIN + BAR_MAX) / 2;
      const left = ((Math.min(lo, mid) - BAR_MIN) / (BAR_MAX - BAR_MIN)) * 100;
      const width = (Math.abs(lo - mid) / (BAR_MAX - BAR_MIN)) * 100;
      bar.fill.style.left = `${left}%`;
      bar.fill.style.width = `${width}%`;
      bar.fill.dataset["off"] = rc.linkActive ? "" : "1";
      setText(bar.value, us ? String(us) : "-");
    }

    live.pulses.forEach((p, i) => setText(this.pulses[i]!, p ? String(p) : "off"));
    this.lights.forEach((el, i) => {
      const on = (live.lightMask & (1 << i)) !== 0 ? "1" : "";
      if (el.dataset["on"] !== on) el.dataset["on"] = on;
    });
    f.lightMode.set(`mode ${live.lightMode + 1}${live.lightTest ? " (bench test)" : ""}`, live.lightTest ? "warn" : "");
    f.hazard.set(live.hazardOn ? (live.hazardByButton ? "on (button)" : "on") : "off", live.hazardOn ? "warn" : "");
    f.drive.set(DRIVE_STATES[live.drive] ?? String(live.drive));

    f.battery.set(b.ready ? `${(b.batteryMv / 1000).toFixed(2)} V` : "not ready");
    f.vdda.set(b.ready ? `${b.vddaMv} mV` : "-");
    f.temp.set(b.ready ? `${b.temperatureC.toFixed(1)} °C` : "-");

    f.uptime.set(fmtUptime(s.uptimeMs));
    f.load.set(`${(s.loadPermille / 10).toFixed(1)} %`);
    const imuOk = flag(STATUS_FLAG.IMU_OK);
    f.imu.set(imuOk ? `ok, ${s.imuSamplesPerSecond} samples/s` : "FAULT (degraded)", imuOk ? "ok" : "bad");
    f.imuFaults.set(String(s.imuFaults), s.imuFaults ? "warn" : "");
    f.crash.set(flag(STATUS_FLAG.CRASH_RECORD) ? "present (CLI 'crash')" : "none", flag(STATUS_FLAG.CRASH_RECORD) ? "warn" : "");

    f.settings.set(`${SETTINGS_STATES[s.settingsState] ?? s.settingsState}, layout ${s.settingsLayout}`, s.settingsState === 3 ? "ok" : "warn");
    f.lastSave.set(flag(STATUS_FLAG.SAVING) ? "saving…" : (SAVE_RESULTS[s.lastSave] ?? String(s.lastSave)), s.lastSave === 3 ? "bad" : "");
    f.lock.set(flag(STATUS_FLAG.LOCKED) ? "locked (armed)" : "unlocked", flag(STATUS_FLAG.LOCKED) ? "warn" : "");
    const repaired = [s.repairedOutputs ? `outputs 0x${s.repairedOutputs.toString(16).padStart(4, "0")}` : "", flag(STATUS_FLAG.LIGHTS_REPAIRED) ? "lights" : ""].filter(Boolean);
    f.repaired.set(repaired.length ? `${repaired.join(", ")} → defaults` : "none", repaired.length ? "warn" : "");
  }
}
