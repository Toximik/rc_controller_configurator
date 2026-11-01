/**
 * \author Toximik
 * \file outputs.ts
 * \brief OUTPUTS_CONFIG settings area (MSP 0x4012 get / 0x4013 set):
 *        model, decoder, encoder and the firmware's validation rules.
 *
 * Layout version 1 (112 B), Application/AppMsp/MspPayload.hpp:
 * version, 9 x { source, flags, failsafe, min, center, max, failsafe_us (u16) },
 * 5 x rate_Hz (u16), arm channel, ESC output.
 * Rules mirror OUTPUT_CONFIG::isValid() / OUTPUTS_CONFIG::isValid() in
 * Application/AppSettings/OutputConfig.hpp – the board checks again and
 * answers "invalid value" (error 3) without changing anything.
 */

import { MspReader, MspWriter } from "./codec.ts";

export const OUTPUTS_VERSION = 1;
export const OUTPUTS_SIZE = 112;

export const OUTPUT_COUNT = 9;
export const OUTPUT_GROUPS = 5;
export const RC_CHANNEL_MAX = 16;
export const PULSE_MIN_US = 500;
export const PULSE_MAX_US = 2500;
export const RATE_MIN_HZ = 50;
export const RATE_MAX_HZ = 333;

/** BspServo timer group of OUT1..OUT9 (outputs of a group share the frame rate) */
export const OUTPUT_GROUP_OF = [0, 1, 2, 2, 3, 3, 3, 3, 4] as const;
/** Timer of each group (BspServo.h) */
export const GROUP_TIMERS = ["TIM4", "TIM1", "TIM8", "TIM3", "TIM12"] as const;

const FLAG_REVERSE = 0x01;

/** OUTPUT_FAILSAFE: what an output does while the RC link is lost */
export const FAILSAFE = { HOLD: 0, FIXED: 1, OFF: 2 } as const;
export const FAILSAFE_NAMES = ["hold last", "fixed", "no pulses"] as const;

export interface OutputConfig {
  /** RC channel 1..16, 0 = none (no pulses) */
  source: number;
  reverse: boolean;
  failsafe: number;
  /** Output at channel 1000 us */
  minUs: number;
  /** Output at channel 1500 us (subtrim, ESC neutral) */
  centerUs: number;
  /** Output at channel 2000 us */
  maxUs: number;
  /** Value for FAILSAFE.FIXED */
  failsafeUs: number;
}

export interface OutputsConfig {
  outputs: OutputConfig[];
  /** Frame rate per timer group [Hz] */
  ratesHz: number[];
  /** Arm switch RC channel 1..16 */
  armChannel: number;
  /** ESC output 1..9: held at its center while disarmed, must be centered to arm */
  escOutput: number;
}

export class AreaVersionError extends Error {
  constructor(area: string, version: number, size: number) {
    super(`${area} area version ${version} (${size} B) is not supported by this configurator (knows version ${OUTPUTS_VERSION}, ${OUTPUTS_SIZE} B) – update the configurator`);
    this.name = "AreaVersionError";
  }
}

export function decodeOutputs(d: Uint8Array): OutputsConfig {
  const version = d[0] ?? -1;
  if (version !== OUTPUTS_VERSION || d.length !== OUTPUTS_SIZE) {
    throw new AreaVersionError("Outputs", version, d.length);
  }
  const r = new MspReader(d, 1);
  const outputs = Array.from({ length: OUTPUT_COUNT }, (): OutputConfig => {
    const source = r.u8();
    const flags = r.u8();
    return { source, reverse: (flags & FLAG_REVERSE) !== 0, failsafe: r.u8(), minUs: r.u16(), centerUs: r.u16(), maxUs: r.u16(), failsafeUs: r.u16() };
  });
  const ratesHz = Array.from({ length: OUTPUT_GROUPS }, () => r.u16());
  return { outputs, ratesHz, armChannel: r.u8(), escOutput: r.u8() };
}

export function encodeOutputs(c: OutputsConfig): Uint8Array {
  const w = new MspWriter().u8(OUTPUTS_VERSION);
  for (const o of c.outputs) {
    w.u8(o.source).u8(o.reverse ? FLAG_REVERSE : 0).u8(o.failsafe).u16(o.minUs).u16(o.centerUs).u16(o.maxUs).u16(o.failsafeUs);
  }
  for (const rate of c.ratesHz) {
    w.u16(rate);
  }
  return w.u8(c.armChannel).u8(c.escOutput).bytes();
}

export function cloneOutputs(c: OutputsConfig): OutputsConfig {
  return { outputs: c.outputs.map((o) => ({ ...o })), ratesHz: [...c.ratesHz], armChannel: c.armChannel, escOutput: c.escOutput };
}

export function sameOutputs(a: OutputsConfig, b: OutputsConfig): boolean {
  const x = encodeOutputs(a);
  const y = encodeOutputs(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Field key of a validation problem: "out<i>.<field>", "rate<g>", "arm", "esc" */
export type OutputsField = `out${number}.${keyof OutputConfig}` | `rate${number}` | "arm" | "esc";

export interface OutputsProblem {
  field: OutputsField;
  message: string;
}

const isInt = (v: number) => Number.isInteger(v);
const inRange = (v: number, lo: number, hi: number) => isInt(v) && v >= lo && v <= hi;

/** Every rule of OutputConfig.hpp isValid(); empty = the board will accept it */
export function validateOutputs(c: OutputsConfig): OutputsProblem[] {
  const p: OutputsProblem[] = [];
  c.outputs.forEach((o, i) => {
    const k = (f: keyof OutputConfig) => `out${i}.${f}` as OutputsField;
    if (!inRange(o.source, 0, RC_CHANNEL_MAX)) p.push({ field: k("source"), message: `source must be none or CH1..CH${RC_CHANNEL_MAX}` });
    if (!inRange(o.failsafe, 0, FAILSAFE.OFF)) p.push({ field: k("failsafe"), message: "unknown failsafe kind" });
    const pulse = (f: "minUs" | "centerUs" | "maxUs" | "failsafeUs", name: string) => {
      if (!inRange(o[f], PULSE_MIN_US, PULSE_MAX_US)) p.push({ field: k(f), message: `${name} must be ${PULSE_MIN_US}..${PULSE_MAX_US} µs` });
    };
    pulse("minUs", "min");
    pulse("centerUs", "center");
    pulse("maxUs", "max");
    pulse("failsafeUs", "failsafe value");
    if (isInt(o.minUs) && isInt(o.centerUs) && o.minUs > o.centerUs) p.push({ field: k("minUs"), message: "min must not be above center" });
    if (isInt(o.centerUs) && isInt(o.maxUs) && o.centerUs > o.maxUs) p.push({ field: k("maxUs"), message: "max must not be below center" });
  });
  c.ratesHz.forEach((r, g) => {
    if (!inRange(r, RATE_MIN_HZ, RATE_MAX_HZ)) p.push({ field: `rate${g}`, message: `frame rate must be ${RATE_MIN_HZ}..${RATE_MAX_HZ} Hz` });
  });
  if (!inRange(c.armChannel, 1, RC_CHANNEL_MAX)) p.push({ field: "arm", message: `arm channel must be CH1..CH${RC_CHANNEL_MAX}` });
  if (!inRange(c.escOutput, 1, OUTPUT_COUNT)) p.push({ field: "esc", message: `ESC output must be OUT1..OUT${OUTPUT_COUNT}` });
  return p;
}

