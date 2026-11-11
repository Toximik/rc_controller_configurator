/**
 * \author Toximik
 * \file beeper.ts
 * \brief BEEPER_CONFIG settings area (MSP 0x401A get / 0x401B set):
 *        model, decoder, encoder and the firmware's validation rules.
 *
 * Layout version 1 (5 B), Application/AppMsp/MspPayload.hpp:
 * version, switch channel (0 = none, 1..16 = RC channel), flags
 * (bit 0 = link beep, bit 1 = lost alarm, bit 2 = arm / disarm beep since
 * API 1.6 - an older firmware refuses it), lost delay in seconds (u16).
 * The board checks again and answers "invalid value" (error 3) without
 * changing anything.
 */

import { MspReader, MspWriter } from "./codec.ts";
import { AreaVersionError } from "./outputs.ts";

export const BEEPER_VERSION = 1;
export const BEEPER_SIZE = 5;

export const BEEPER_CHANNEL_MAX = 16;
export const BEEPER_DELAY_MIN_S = 10;
export const BEEPER_DELAY_MAX_S = 3600;

/** Flag bits */
export const BEEPER_FLAG_LINK = 0x01;
export const BEEPER_FLAG_LOST = 0x02;
export const BEEPER_FLAG_ARM = 0x04;
const BEEPER_FLAGS_MASK = BEEPER_FLAG_LINK | BEEPER_FLAG_LOST | BEEPER_FLAG_ARM;

export interface BeeperConfig {
  /** Beeper switch channel 1..16, 0 = none */
  switchChannel: number;
  /** Flag bits (BEEPER_FLAG_*) */
  flags: number;
  /** RC link lost for longer than this many seconds starts the lost alarm */
  lostDelayS: number;
}

export function decodeBeeper(d: Uint8Array): BeeperConfig {
  const version = d[0] ?? -1;
  if (version !== BEEPER_VERSION || d.length !== BEEPER_SIZE) {
    throw new AreaVersionError("Beeper", version, d.length, BEEPER_VERSION, BEEPER_SIZE);
  }
  const r = new MspReader(d, 1);
  return { switchChannel: r.u8(), flags: r.u8(), lostDelayS: r.u16() };
}

export function encodeBeeper(c: BeeperConfig): Uint8Array {
  return new MspWriter().u8(BEEPER_VERSION).u8(c.switchChannel).u8(c.flags).u16(c.lostDelayS).bytes();
}

export function cloneBeeper(c: BeeperConfig): BeeperConfig {
  return { ...c };
}

export function sameBeeper(a: BeeperConfig, b: BeeperConfig): boolean {
  const x = encodeBeeper(a);
  const y = encodeBeeper(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Field key of a validation problem / form control */
export type BeeperField = "switchChannel" | "linkBeep" | "lostAlarm" | "armBeep" | "lostDelayS";

export interface BeeperProblem {
  field: BeeperField;
  message: string;
}

/** Every rule of the firmware (BeeperConfig.hpp); empty = the board will accept it */
export function validateBeeper(c: BeeperConfig): BeeperProblem[] {
  const p: BeeperProblem[] = [];
  if (!Number.isInteger(c.switchChannel) || c.switchChannel < 0 || c.switchChannel > BEEPER_CHANNEL_MAX) {
    p.push({ field: "switchChannel", message: `beeper switch channel must be none or CH1..CH${BEEPER_CHANNEL_MAX}` });
  }
  if (!Number.isInteger(c.flags) || c.flags < 0 || (c.flags & ~BEEPER_FLAGS_MASK) !== 0) {
    p.push({ field: "linkBeep", message: "unknown beeper flag bits" });
  }
  if (!Number.isInteger(c.lostDelayS) || c.lostDelayS < BEEPER_DELAY_MIN_S || c.lostDelayS > BEEPER_DELAY_MAX_S) {
    p.push({ field: "lostDelayS", message: `lost alarm delay must be ${BEEPER_DELAY_MIN_S}..${BEEPER_DELAY_MAX_S} s` });
  }
  return p;
}
