/**
 * \author Toximik
 * \file beeper.test.ts
 * \brief BEEPER_CONFIG area: wire layout (MspPayload.hpp beeper version 1)
 *        and the firmware's validation rules.
 */

import { describe, expect, it } from "vitest";
import { BEEPER_SIZE, cloneBeeper, decodeBeeper, encodeBeeper, sameBeeper, validateBeeper, type BeeperConfig } from "../src/msp/beeper.ts";
import { AreaVersionError } from "../src/msp/outputs.ts";

/** Firmware default: CH7, link beep + lost alarm, 300 s */
const DEFAULTS: BeeperConfig = { switchChannel: 7, flags: 0x03, lostDelayS: 300 };

describe("BEEPER area", () => {
  it("default wire layout (version 1, 5 B, little-endian delay)", () => {
    const b = encodeBeeper(DEFAULTS);
    expect(b.length).toBe(BEEPER_SIZE);
    expect(Array.from(b)).toEqual([1, 7, 3, 0x2c, 0x01]);
  });

  it("round trip", () => {
    for (const c of [DEFAULTS, { switchChannel: 0, flags: 0, lostDelayS: 10 }, { switchChannel: 16, flags: 2, lostDelayS: 3600 }]) {
      expect(validateBeeper(c)).toEqual([]);
      expect(decodeBeeper(encodeBeeper(c))).toEqual(c);
    }
  });

  it("clone is independent", () => {
    const a = cloneBeeper(DEFAULTS);
    const b = cloneBeeper(a);
    b.lostDelayS = 60;
    expect(sameBeeper(a, DEFAULTS)).toBe(true);
    expect(sameBeeper(a, b)).toBe(false);
  });

  it("refuses another area version or length", () => {
    const b = encodeBeeper(DEFAULTS);
    expect(() => decodeBeeper(b.subarray(0, 4))).toThrow(AreaVersionError);
    expect(() => decodeBeeper(Uint8Array.from([...b, 0]))).toThrow(AreaVersionError);
    expect(() => decodeBeeper(Uint8Array.from([0, ...b.subarray(1)]))).toThrow(AreaVersionError);
    expect(() => decodeBeeper(Uint8Array.from([2, ...b.subarray(1)]))).toThrow(/knows version 1, 5 B/);
  });
});

describe("validation", () => {
  const ok = (patch: Partial<BeeperConfig>) => validateBeeper({ ...DEFAULTS, ...patch }).map((p) => p.field);

  it("channel must be 0..16", () => {
    expect(ok({ switchChannel: 17 })).toEqual(["switchChannel"]);
    expect(ok({ switchChannel: -1 })).toEqual(["switchChannel"]);
    expect(ok({ switchChannel: NaN })).toEqual(["switchChannel"]);
    expect(ok({ switchChannel: 1.5 })).toEqual(["switchChannel"]);
  });

  it("unknown flag bits are refused", () => {
    expect(ok({ flags: 0x04 })).toEqual(["linkBeep"]);
    expect(ok({ flags: 0x83 })).toEqual(["linkBeep"]);
    expect(ok({ flags: -1 })).toEqual(["linkBeep"]);
    expect(ok({ flags: 0 })).toEqual([]);
  });

  it("delay must be 10..3600 s", () => {
    expect(ok({ lostDelayS: 9 })).toEqual(["lostDelayS"]);
    expect(ok({ lostDelayS: 3601 })).toEqual(["lostDelayS"]);
    expect(ok({ lostDelayS: NaN })).toEqual(["lostDelayS"]);
    expect(ok({ lostDelayS: 10 })).toEqual([]);
    expect(ok({ lostDelayS: 3600 })).toEqual([]);
  });
});
