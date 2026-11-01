/**
 * \author Toximik
 * \file payloads.ts
 * \brief Decoders of the identity and live data payloads. Layouts from
 *        Application/AppMsp/MspPayload.hpp (firmware API 1.1).
 *
 * Live data carry no version byte: the firmware only appends fields, so a
 * decoder reads the fields it knows and ignores any rest.
 */

import { MspReader } from "./codec.ts";

/* ---------------------------------------------------------------- identity */

export interface ApiVersion {
  protocol: number;
  major: number;
  minor: number;
}

export function decodeApiVersion(d: Uint8Array): ApiVersion {
  const r = new MspReader(d);
  return { protocol: r.u8(), major: r.u8(), minor: r.u8() };
}

export function decodeFcVariant(d: Uint8Array): string {
  return new MspReader(d).text(4);
}

export function decodeFcVersion(d: Uint8Array): string {
  const r = new MspReader(d);
  return `${r.u8()}.${r.u8()}.${r.u8()}`;
}

export interface BoardInfo {
  boardId: string;
  hardwareRevision: number;
  target: string;
  boardName: string;
  manufacturer: string;
  /** MCU UID, 3 x u32 as hex */
  uid: string;
}

export function decodeBoardInfo(d: Uint8Array): BoardInfo {
  const r = new MspReader(d);
  const boardId = r.text(4);
  const hardwareRevision = r.u16();
  r.u8(); // OSD chip type
  r.u8(); // capabilities
  const target = r.pstring();
  const boardName = r.pstring();
  const manufacturer = r.pstring();
  const uid = r.remaining >= 12 ? [r.u32(), r.u32(), r.u32()].map((w) => w.toString(16).toUpperCase().padStart(8, "0")).join(" ") : "";
  return { boardId, hardwareRevision, target, boardName, manufacturer, uid };
}

export interface BuildInfo {
  date: string;
  time: string;
  git: string;
}

export function decodeBuildInfo(d: Uint8Array): BuildInfo {
  const r = new MspReader(d);
  return { date: r.text(11), time: r.text(8), git: r.remaining >= 7 ? r.text(7) : "" };
}

/* ------------------------------------------------------------------ STATUS */

export const OUTPUT_STATES = ["BOOT", "DISARMED", "ARMED", "RC_LOST", "FAILSAFE", "TEST"] as const;

/** OUTPUT_LOGIC::ARM_BLOCK bits, index = bit */
export const ARM_BLOCKS = ["no RC link", "failsafe tripped", "ESC not centered", "saving", "output hardware", "arm switch on (switch off first)", "bench test"] as const;

export const STATUS_FLAG = {
  OUTPUT_ENABLE: 0x0001,
  FAILSAFE_TRIPPED: 0x0002,
  IMU_OK: 0x0004,
  LINK_ACTIVE: 0x0008,
  CRASH_RECORD: 0x0010,
  SAVING: 0x0020,
  LOCKED: 0x0040,
  LIGHTS_REPAIRED: 0x0080,
  LOG_REPAIRED: 0x0100,
} as const;

export const SETTINGS_STATES = ["no EDATA", "skipped", "defaults", "loaded"] as const;
export const SAVE_RESULTS = ["none since boot", "running", "OK", "FAILED"] as const;

/** BSPFAILSAFE_SOURCE_NONE */
export const FAILSAFE_SOURCE_NONE = 0xff;

export interface Status {
  uptimeMs: number;
  outputState: number;
  armBlock: number;
  flags: number;
  failsafeSource: number;
  failsafeTrips: number;
  armCount: number;
  rcLostCount: number;
  imuSamplesPerSecond: number;
  imuFaults: number;
  rcFramesPerSecond: number;
  linkLostCount: number;
  linkQuality: number;
  /** Uplink RSSI antenna 1 / 2 [-dBm] */
  rssi1: number;
  rssi2: number;
  snr: number;
  rfProfile: number;
  settingsState: number;
  settingsLayout: number;
  repairedOutputs: number;
  loadPermille: number;
  lastSave: number;
  /** Mode text as sent to the radio ("ARMED !IMU") */
  mode: string;
}

export function decodeStatus(d: Uint8Array): Status {
  const r = new MspReader(d);
  return {
    uptimeMs: r.u32(),
    outputState: r.u8(),
    armBlock: r.u8(),
    flags: r.u16(),
    failsafeSource: r.u8(),
    failsafeTrips: r.u32(),
    armCount: r.u32(),
    rcLostCount: r.u32(),
    imuSamplesPerSecond: r.u16(),
    imuFaults: r.u32(),
    rcFramesPerSecond: r.u16(),
    linkLostCount: r.u32(),
    linkQuality: r.u8(),
    rssi1: r.u8(),
    rssi2: r.u8(),
    snr: r.i8(),
    rfProfile: r.u8(),
    settingsState: r.u8(),
    settingsLayout: r.u16(),
    repairedOutputs: r.u16(),
    loadPermille: r.u16(),
    lastSave: r.u8(),
    mode: r.pstring(),
  };
}

export function armBlockNames(bits: number): string[] {
  return ARM_BLOCKS.filter((_, i) => bits & (1 << i));
}

/* ---------------------------------------------------------------------- RC */

export const RC_CHANNELS = 16;

export interface RcData {
  linkActive: boolean;
  /** CH1..CH16 [us] */
  channels: number[];
}

export function decodeRc(d: Uint8Array): RcData {
  const r = new MspReader(d);
  const linkActive = r.u8() !== 0;
  const channels = Array.from({ length: RC_CHANNELS }, () => r.u16());
  return { linkActive, channels };
}

/* ----------------------------------------------------------------- BATTERY */

export interface Battery {
  ready: boolean;
  batteryMv: number;
  vddaMv: number;
  /** MCU temperature [degC] */
  temperatureC: number;
}

export function decodeBattery(d: Uint8Array): Battery {
  const r = new MspReader(d);
  return { ready: r.u8() !== 0, batteryMv: r.u16(), vddaMv: r.u16(), temperatureC: r.i16() / 10 };
}

/* ------------------------------------------------------------ OUTPUTS_LIVE */

export const OUTPUT_COUNT = 9;
export const LIGHT_COUNT = 8;
export const DRIVE_STATES = ["neutral", "forward", "brake", "reverse"] as const;

export interface OutputsLive {
  /** OUT1..OUT9 [us], 0 = no pulses */
  pulses: number[];
  outputEnable: boolean;
  lightTest: boolean;
  /** Bit n = LIGHT(n+1) on */
  lightMask: number;
  /** 0-based mode index (mode 1 = 0) */
  lightMode: number;
  hazardOn: boolean;
  hazardByButton: boolean;
  drive: number;
}

export function decodeOutputsLive(d: Uint8Array): OutputsLive {
  const r = new MspReader(d);
  const pulses = Array.from({ length: OUTPUT_COUNT }, () => r.u16());
  const flags = r.u8();
  const lightMask = r.u8();
  const lightMode = r.u8();
  const hazard = r.u8();
  const drive = r.u8();
  return {
    pulses,
    outputEnable: (flags & 0x01) !== 0,
    lightTest: (flags & 0x02) !== 0,
    lightMask,
    lightMode,
    hazardOn: (hazard & 0x01) !== 0,
    hazardByButton: (hazard & 0x02) !== 0,
    drive,
  };
}
