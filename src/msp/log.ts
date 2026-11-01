/**
 * \author Toximik
 * \file log.ts
 * \brief LOG_CONFIG settings area (MSP 0x4016 get / 0x4017 set):
 *        model, decoder, encoder and the firmware's validation rules.
 *
 * Layout version 1 (2 B), Application/AppMsp/MspPayload.hpp:
 * version, log switch channel (0 = none, 1..16 = RC channel).
 * The board checks again and answers "invalid value" (error 3) without
 * changing anything.
 */

import { MspReader, MspWriter } from "./codec.ts";
import { AreaVersionError } from "./outputs.ts";

export const LOG_VERSION = 1;
export const LOG_SIZE = 2;

export const LOG_CHANNEL_MAX = 16;

export interface LogConfig {
  /** Log switch channel 1..16, 0 = none (logging only from CLI / MSP) */
  switchChannel: number;
}

export function decodeLog(d: Uint8Array): LogConfig {
  const version = d[0] ?? -1;
  if (version !== LOG_VERSION || d.length !== LOG_SIZE) {
    throw new AreaVersionError("Log", version, d.length, LOG_VERSION, LOG_SIZE);
  }
  const r = new MspReader(d, 1);
  return { switchChannel: r.u8() };
}

export function encodeLog(c: LogConfig): Uint8Array {
  return new MspWriter().u8(LOG_VERSION).u8(c.switchChannel).bytes();
}

export function cloneLog(c: LogConfig): LogConfig {
  return { ...c };
}

export function sameLog(a: LogConfig, b: LogConfig): boolean {
  const x = encodeLog(a);
  const y = encodeLog(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Field key of a validation problem / form control */
export type LogField = "switchChannel";

export interface LogProblem {
  field: LogField;
  message: string;
}

/** Every rule of the firmware (LogConfig.hpp); empty = the board will accept it */
export function validateLog(c: LogConfig): LogProblem[] {
  const p: LogProblem[] = [];
  if (!Number.isInteger(c.switchChannel) || c.switchChannel < 0 || c.switchChannel > LOG_CHANNEL_MAX) {
    p.push({ field: "switchChannel", message: `log switch channel must be none or CH1..CH${LOG_CHANNEL_MAX}` });
  }
  return p;
}
