/**
 * \author Toximik
 * \file lights.ts
 * \brief LIGHTS_CONFIG settings area (MSP 0x4014 get / 0x4015 set):
 *        model, decoder, encoder and the firmware's validation rules.
 *
 * Layout version 2 (37 B), Application/AppMsp/MspPayload.hpp:
 * version, 8 x functions (u16), 6 x mode functions (u16), mode channel,
 * mode count, steering channel, flags, steering threshold (u16),
 * throttle dead band (u16).
 * Rules mirror LIGHTS_CONFIG::isValid() in Application/AppSettings/LightConfig.hpp
 * – the board checks again and answers "invalid value" (error 3) without
 * changing anything.
 */

import { MspReader, MspWriter } from "./codec.ts";
import { AreaVersionError } from "./outputs.ts";

export const LIGHTS_VERSION = 2;
export const LIGHTS_SIZE = 37;

export const LIGHT_OUTPUTS = 8;
export const LIGHT_MODES = 6;
export const RC_CHANNEL_MAX = 16;
export const STEER_MIN_US = 50;
export const STEER_MAX_US = 450;
export const DEADBAND_MIN_US = 10;
export const DEADBAND_MAX_US = 200;

/** LIGHT_FUNCTION bits */
export const FN = {
  DAY: 0x0001,
  HEAD: 0x0002,
  BAR: 0x0004,
  TAIL: 0x0008,
  BRAKE: 0x0010,
  REVERSE: 0x0020,
  LEFT: 0x0040,
  RIGHT: 0x0080,
  ROCK: 0x0100,
} as const;
export type FnName = keyof typeof FN;
export const FN_ALL = 0x01ff;
/** Functions a mode may contain (brake / reverse follow the throttle) */
export const FN_MODE = FN.DAY | FN.HEAD | FN.BAR | FN.TAIL | FN.LEFT | FN.RIGHT | FN.ROCK;

/** Function columns of a light output, with a short explanation */
export const OUTPUT_FUNCTIONS: { fn: FnName; label: string; hint: string }[] = [
  { fn: "DAY", label: "Day", hint: "daytime running light (mode)" },
  { fn: "HEAD", label: "Head", hint: "head light (mode)" },
  { fn: "BAR", label: "Bar", hint: "light bar / high beam (mode)" },
  { fn: "TAIL", label: "Tail", hint: "tail / position light (mode)" },
  { fn: "ROCK", label: "Rock", hint: "rock lights under the body (mode)" },
  { fn: "BRAKE", label: "Brake", hint: "automatic: throttle neutral or braking" },
  { fn: "REVERSE", label: "Reverse", hint: "automatic: reversing" },
  { fn: "LEFT", label: "Left", hint: "turn signal left (standing + steering left), hazard; blinks" },
  { fn: "RIGHT", label: "Right", hint: "turn signal right, hazard; blinks" },
];

/** Function columns of a mode (left + right = hazard) */
export const MODE_FUNCTIONS = OUTPUT_FUNCTIONS.filter((f) => (FN[f.fn] & FN_MODE) !== 0);

/** LIGHTS_CONFIG flags */
export const LIGHT_FLAG = {
  STEER_REVERSE: 0x01,
  THROTTLE_REVERSE: 0x02,
  DIRECT_REVERSE: 0x04,
  MODE_BUTTON: 0x08,
  BUTTON_HAZARD: 0x10,
} as const;
export type LightFlagName = keyof typeof LIGHT_FLAG;
export const LIGHT_FLAGS_ALL = 0x1f;

export interface LightsConfig {
  /** LIGHT_FUNCTION bits per output LIGHT1..8 */
  functions: number[];
  /** Mode function bits per mode 1..6 (mode 1 = "off" of the button's long press) */
  modes: number[];
  /** Mode switch / button channel 1..16, 0 = none (mode 1) */
  modeChannel: number;
  /** Modes in use 1..6: switch positions / button cycle */
  modeCount: number;
  /** Steering channel 1..16 for the turn signals, 0 = none */
  steerChannel: number;
  flags: number;
  /** Turn signal above this steering deviation [µs] */
  steerThresholdUs: number;
  /** Throttle neutral within ± this deviation [µs] */
  throttleDeadbandUs: number;
}

export function decodeLights(d: Uint8Array): LightsConfig {
  const version = d[0] ?? -1;
  if (version !== LIGHTS_VERSION || d.length !== LIGHTS_SIZE) {
    throw new AreaVersionError("Lights", version, d.length, LIGHTS_VERSION, LIGHTS_SIZE);
  }
  const r = new MspReader(d, 1);
  const functions = Array.from({ length: LIGHT_OUTPUTS }, () => r.u16());
  const modes = Array.from({ length: LIGHT_MODES }, () => r.u16());
  return {
    functions,
    modes,
    modeChannel: r.u8(),
    modeCount: r.u8(),
    steerChannel: r.u8(),
    flags: r.u8(),
    steerThresholdUs: r.u16(),
    throttleDeadbandUs: r.u16(),
  };
}

export function encodeLights(c: LightsConfig): Uint8Array {
  const w = new MspWriter().u8(LIGHTS_VERSION);
  for (const f of c.functions) w.u16(f);
  for (const m of c.modes) w.u16(m);
  return w.u8(c.modeChannel).u8(c.modeCount).u8(c.steerChannel).u8(c.flags).u16(c.steerThresholdUs).u16(c.throttleDeadbandUs).bytes();
}

export function cloneLights(c: LightsConfig): LightsConfig {
  return { ...c, functions: [...c.functions], modes: [...c.modes] };
}

export function sameLights(a: LightsConfig, b: LightsConfig): boolean {
  const x = encodeLights(a);
  const y = encodeLights(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Field key of a validation problem / form control */
export type LightsField =
  | `light${number}.${FnName}`
  | `light${number}`
  | `mode${number}.${FnName}`
  | `mode${number}`
  | `flag.${LightFlagName}`
  | "flags"
  | "modeChannel"
  | "modeCount"
  | "steerChannel"
  | "steerThresholdUs"
  | "throttleDeadbandUs";

export interface LightsProblem {
  field: LightsField;
  message: string;
}

const isInt = (v: number) => Number.isInteger(v);
const inRange = (v: number, lo: number, hi: number) => isInt(v) && v >= lo && v <= hi;

/** Every rule of LightConfig.hpp isValid(); empty = the board will accept it */
export function validateLights(c: LightsConfig): LightsProblem[] {
  const p: LightsProblem[] = [];
  c.functions.forEach((f, i) => {
    if (!inRange(f, 0, 0xffff) || (f & ~FN_ALL) !== 0) p.push({ field: `light${i}`, message: "unknown function bits" });
  });
  c.modes.forEach((m, i) => {
    if (!inRange(m, 0, 0xffff) || (m & ~FN_MODE) !== 0) p.push({ field: `mode${i}`, message: "a mode may only contain day, head, bar, tail, rock, left, right" });
  });
  if (!inRange(c.modeChannel, 0, RC_CHANNEL_MAX)) p.push({ field: "modeChannel", message: `mode channel must be none or CH1..CH${RC_CHANNEL_MAX}` });
  if (!inRange(c.modeCount, 1, LIGHT_MODES)) p.push({ field: "modeCount", message: `modes in use must be 1..${LIGHT_MODES}` });
  if (!inRange(c.steerChannel, 0, RC_CHANNEL_MAX)) p.push({ field: "steerChannel", message: `steering channel must be none or CH1..CH${RC_CHANNEL_MAX}` });
  if (!inRange(c.flags, 0, 0xff) || (c.flags & ~LIGHT_FLAGS_ALL) !== 0) p.push({ field: "flags", message: "unknown option bits" });
  if (!inRange(c.steerThresholdUs, STEER_MIN_US, STEER_MAX_US)) p.push({ field: "steerThresholdUs", message: `turn signal threshold must be ${STEER_MIN_US}..${STEER_MAX_US} µs` });
  if (!inRange(c.throttleDeadbandUs, DEADBAND_MIN_US, DEADBAND_MAX_US)) p.push({ field: "throttleDeadbandUs", message: `throttle dead band must be ${DEADBAND_MIN_US}..${DEADBAND_MAX_US} µs` });
  return p;
}

/** Names of the functions in a bit mask, in column order ("-" for none) */
export function functionNames(mask: number): string {
  const names = OUTPUT_FUNCTIONS.filter((f) => (mask & FN[f.fn]) !== 0).map((f) => f.label.toLowerCase());
  return names.length ? names.join(" + ") : "-";
}
