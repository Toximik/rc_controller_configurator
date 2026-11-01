/**
 * \author Toximik
 * \file log.test.ts
 * \brief LOG_CONFIG area: wire layout (MspPayload.hpp log version 1) and
 *        the firmware's validation rules.
 */

import { describe, expect, it } from "vitest";
import { cloneLog, decodeLog, encodeLog, LOG_SIZE, sameLog, validateLog, type LogConfig } from "../src/msp/log.ts";
import { AreaVersionError } from "../src/msp/outputs.ts";

/** Firmware default: log switch on CH8 */
const DEFAULTS: LogConfig = { switchChannel: 8 };

describe("LOG area", () => {
  it("default wire layout (version 1, 2 B)", () => {
    const b = encodeLog(DEFAULTS);
    expect(b.length).toBe(LOG_SIZE);
    expect(Array.from(b)).toEqual([1, 8]);
  });

  it("round trip of every channel", () => {
    for (let ch = 0; ch <= 16; ch++) {
      const c = { switchChannel: ch };
      expect(validateLog(c)).toEqual([]);
      expect(decodeLog(encodeLog(c))).toEqual(c);
    }
  });

  it("clone is independent", () => {
    const a = cloneLog(DEFAULTS);
    const b = cloneLog(a);
    b.switchChannel = 0;
    expect(sameLog(a, DEFAULTS)).toBe(true);
    expect(sameLog(a, b)).toBe(false);
  });

  it("refuses another area version or length", () => {
    const b = encodeLog(DEFAULTS);
    expect(() => decodeLog(b.subarray(0, 1))).toThrow(AreaVersionError);
    expect(() => decodeLog(Uint8Array.from([...b, 0]))).toThrow(AreaVersionError);
    expect(() => decodeLog(Uint8Array.from([0, 8]))).toThrow(AreaVersionError);
    expect(() => decodeLog(Uint8Array.from([2, 8]))).toThrow(/knows version 1, 2 B/);
  });
});

describe("validation", () => {
  it("channel must be 0..16", () => {
    expect(validateLog({ switchChannel: 17 }).map((p) => p.field)).toEqual(["switchChannel"]);
    expect(validateLog({ switchChannel: -1 }).length).toBe(1);
    expect(validateLog({ switchChannel: NaN }).length).toBe(1);
    expect(validateLog({ switchChannel: 1.5 }).length).toBe(1);
  });
});
