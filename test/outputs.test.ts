/**
 * \author Toximik
 * \file outputs.test.ts
 * \brief OUTPUTS_CONFIG area against the firmware host tests (Test_Msp.cpp:
 *        Ut_Msp_Outputs_WireLayout, this_OddOutputs, Ut_Msp_Outputs_RefusedUnchanged)
 *        and the rules of OutputConfig.hpp isValid().
 */

import { describe, expect, it } from "vitest";
import { MspWriter } from "../src/msp/codec.ts";
import {
  AreaVersionError,
  cloneOutputs,
  decodeOutputs,
  encodeOutputs,
  FAILSAFE,
  OUTPUTS_SIZE,
  sameOutputs,
  validateOutputs,
  type OutputConfig,
  type OutputsConfig,
} from "../src/msp/outputs.ts";

const unused: OutputConfig = { source: 0, reverse: false, failsafe: FAILSAFE.HOLD, minUs: 1000, centerUs: 1500, maxUs: 2000, failsafeUs: 1500 };

/** g_csOutputsDefault */
const DEFAULTS: OutputsConfig = {
  outputs: [
    { source: 1, reverse: false, failsafe: FAILSAFE.FIXED, minUs: 1000, centerUs: 1500, maxUs: 2000, failsafeUs: 1500 },
    { source: 2, reverse: false, failsafe: FAILSAFE.FIXED, minUs: 1000, centerUs: 1500, maxUs: 2000, failsafeUs: 1500 },
    ...Array.from({ length: 7 }, () => ({ ...unused })),
  ],
  ratesHz: [50, 50, 50, 50, 50],
  armChannel: 5,
  escOutput: 2,
};

/** this_OddOutputs(): a different value in every field, still valid */
function odd(): OutputsConfig {
  return {
    outputs: Array.from({ length: 9 }, (_, i) => ({
      source: i + 3,
      reverse: (i & 1) !== 0,
      failsafe: i % 3,
      minUs: 900 + i,
      centerUs: 1400 + i * 7,
      maxUs: 2100 - i,
      failsafeUs: 1000 + i * 100,
    })),
    ratesHz: Array.from({ length: 5 }, (_, i) => 50 + i * 61),
    armChannel: 12,
    escOutput: 7,
  };
}

describe("MspWriter", () => {
  it("writes little-endian and grows", () => {
    const w = new MspWriter();
    for (let i = 0; i < 40; i++) w.u16(0x0102).u8(3);
    w.u32(0x04050607);
    const b = w.bytes();
    expect(b.length).toBe(124);
    expect(Array.from(b.subarray(0, 3))).toEqual([2, 1, 3]);
    expect(Array.from(b.subarray(120))).toEqual([7, 6, 5, 4]);
  });

  it("refuses values that do not fit", () => {
    expect(() => new MspWriter().u8(256)).toThrow(RangeError);
    expect(() => new MspWriter().u16(-1)).toThrow(RangeError);
    expect(() => new MspWriter().u16(1.5)).toThrow(RangeError);
  });
});

describe("OUTPUTS area", () => {
  it("default wire layout = Ut_Msp_Outputs_WireLayout", () => {
    const b = encodeOutputs(DEFAULTS);
    expect(b.length).toBe(OUTPUTS_SIZE);
    expect(Array.from(b.subarray(0, 12))).toEqual([1, 1, 0, 1, 0xe8, 0x03, 0xdc, 0x05, 0xd0, 0x07, 0xdc, 0x05]);
    expect(Array.from(b.subarray(1 + 9 * 11))).toEqual([50, 0, 50, 0, 50, 0, 50, 0, 50, 0, 5, 2]);
  });

  it("round trip of every field", () => {
    const c = odd();
    expect(validateOutputs(c)).toEqual([]);
    expect(decodeOutputs(encodeOutputs(c))).toEqual(c);
    expect(sameOutputs(c, odd())).toBe(true);
  });

  it("clone is independent", () => {
    const a = odd();
    const b = cloneOutputs(a);
    b.outputs[3]!.centerUs++;
    b.ratesHz[0] = 51;
    expect(sameOutputs(a, odd())).toBe(true);
    expect(sameOutputs(a, b)).toBe(false);
  });

  it("refuses another area version or length", () => {
    const b = encodeOutputs(DEFAULTS);
    expect(() => decodeOutputs(b.subarray(0, OUTPUTS_SIZE - 1))).toThrow(AreaVersionError);
    expect(() => decodeOutputs(Uint8Array.from([...b, 0]))).toThrow(AreaVersionError);
    const v2 = b.slice();
    v2[0] = 2;
    expect(() => decodeOutputs(v2)).toThrow(AreaVersionError);
    expect(() => decodeOutputs(new Uint8Array(0))).toThrow(AreaVersionError);
  });
});

describe("validation (OutputConfig.hpp isValid)", () => {
  const fields = (c: OutputsConfig) => validateOutputs(c).map((p) => p.field);

  it("defaults are valid", () => {
    expect(validateOutputs(DEFAULTS)).toEqual([]);
  });

  it("min above center (Ut_Msp_Outputs_RefusedUnchanged)", () => {
    const c = cloneOutputs(DEFAULTS);
    c.outputs[0]!.minUs = 0x07ff;
    expect(fields(c)).toEqual(["out0.minUs"]);
  });

  it("max below center, pulse limits, failsafe value", () => {
    const c = cloneOutputs(DEFAULTS);
    c.outputs[1]!.maxUs = 1499;
    c.outputs[2]!.minUs = 499;
    c.outputs[3]!.maxUs = 2501;
    c.outputs[4]!.failsafeUs = 2600;
    c.outputs[5]!.centerUs = NaN; // empty input
    expect(fields(c)).toEqual(expect.arrayContaining(["out1.maxUs", "out2.minUs", "out3.maxUs", "out4.failsafeUs", "out5.centerUs"]));
  });

  it("limits are inclusive", () => {
    const c = cloneOutputs(DEFAULTS);
    Object.assign(c.outputs[0]!, { minUs: 500, centerUs: 500, maxUs: 2500, failsafeUs: 2500 });
    Object.assign(c.outputs[1]!, { minUs: 1500, centerUs: 1500, maxUs: 1500 });
    c.ratesHz = [50, 333, 50, 333, 100];
    c.armChannel = 16;
    c.escOutput = 9;
    c.outputs[8]!.source = 16;
    expect(validateOutputs(c)).toEqual([]);
  });

  it("source, failsafe kind, rates, arm channel, ESC output", () => {
    const c = cloneOutputs(DEFAULTS);
    c.outputs[0]!.source = 17;
    c.outputs[1]!.failsafe = 3;
    c.ratesHz[2] = 49;
    c.ratesHz[4] = 334;
    c.armChannel = 0;
    c.escOutput = 10;
    expect(fields(c)).toEqual(["out0.source", "out1.failsafe", "rate2", "rate4", "arm", "esc"]);
  });
});
