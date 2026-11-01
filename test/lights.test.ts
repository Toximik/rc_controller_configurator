/**
 * \author Toximik
 * \file lights.test.ts
 * \brief LIGHTS_CONFIG area against the firmware host tests (Test_Msp.cpp:
 *        Ut_Msp_Lights_RoundTrip, Ut_Msp_Lights_RefusedUnchanged) and the
 *        rules of LightConfig.hpp isValid().
 */

import { describe, expect, it } from "vitest";
import { AreaVersionError } from "../src/msp/outputs.ts";
import {
  cloneLights,
  decodeLights,
  encodeLights,
  FN,
  FN_ALL,
  FN_MODE,
  LIGHT_FLAGS_ALL,
  LIGHTS_SIZE,
  MODE_FUNCTIONS,
  sameLights,
  validateLights,
  type LightsConfig,
} from "../src/msp/lights.ts";

/** g_csLightsDefault */
const DEFAULTS: LightsConfig = {
  functions: [FN.ROCK, FN.DAY, FN.BRAKE, FN.REVERSE, FN.LEFT, FN.RIGHT, FN.HEAD | FN.TAIL, FN.BAR],
  modes: [0, FN.DAY, FN.HEAD | FN.TAIL, FN.HEAD | FN.TAIL | FN.BAR, FN.DAY | FN.HEAD | FN.BAR | FN.TAIL | FN.ROCK, FN.DAY | FN.LEFT | FN.RIGHT],
  modeChannel: 4,
  modeCount: 4,
  steerChannel: 1,
  flags: 0x08 | 0x10,
  steerThresholdUs: 200,
  throttleDeadbandUs: 50,
};

/** Ut_Msp_Lights_RoundTrip: sOdd */
function odd(): LightsConfig {
  const c = cloneLights(DEFAULTS);
  c.functions = c.functions.map((_, i) => FN_ALL >> i);
  c.modes[0] = FN_MODE;
  c.modes[5] = FN.ROCK | FN.LEFT;
  Object.assign(c, { modeChannel: 9, modeCount: 6, steerChannel: 4, flags: LIGHT_FLAGS_ALL, steerThresholdUs: 333, throttleDeadbandUs: 77 });
  return c;
}

describe("LIGHTS area", () => {
  it("default wire layout (MspPayload.hpp lights version 2)", () => {
    const b = encodeLights(DEFAULTS);
    expect(b.length).toBe(LIGHTS_SIZE);
    // version, LIGHT1 rock 0x0100, LIGHT2 day 0x0001
    expect(Array.from(b.subarray(0, 5))).toEqual([2, 0x00, 0x01, 0x01, 0x00]);
    // mode 1 = none, mode 2 = day
    expect(Array.from(b.subarray(17, 21))).toEqual([0, 0, 1, 0]);
    // mode channel 4, count 4, steering CH1, flags 0x18, threshold 200, dead band 50
    expect(Array.from(b.subarray(29))).toEqual([4, 4, 1, 0x18, 200, 0, 50, 0]);
  });

  it("round trip of every field (Ut_Msp_Lights_RoundTrip)", () => {
    const c = odd();
    expect(validateLights(c)).toEqual([]);
    expect(decodeLights(encodeLights(c))).toEqual(c);
    expect(sameLights(c, odd())).toBe(true);
  });

  it("clone is independent", () => {
    const a = odd();
    const b = cloneLights(a);
    b.functions[2] = 0;
    b.modes[1] = 0;
    expect(sameLights(a, odd())).toBe(true);
    expect(sameLights(a, b)).toBe(false);
  });

  it("refuses another area version or length (Ut_Msp_Lights_RefusedUnchanged)", () => {
    const b = encodeLights(DEFAULTS);
    expect(() => decodeLights(b.subarray(0, LIGHTS_SIZE - 1))).toThrow(AreaVersionError);
    expect(() => decodeLights(Uint8Array.from([...b, 0]))).toThrow(AreaVersionError);
    const v0 = b.slice();
    v0[0] = 0;
    expect(() => decodeLights(v0)).toThrow(AreaVersionError);
    const v1 = b.slice();
    v1[0] = 1;
    expect(() => decodeLights(v1)).toThrow(/knows version 2, 37 B/);
  });
});

describe("validation (LightConfig.hpp isValid)", () => {
  const fields = (c: LightsConfig) => validateLights(c).map((p) => p.field);

  it("defaults are valid", () => {
    expect(validateLights(DEFAULTS)).toEqual([]);
  });

  it("brake is no mode function (Ut_Msp_Lights_RefusedUnchanged)", () => {
    const c = cloneLights(DEFAULTS);
    c.modes[0] = FN.BRAKE;
    c.modes[3] = FN.DAY | FN.REVERSE;
    expect(fields(c)).toEqual(["mode0", "mode3"]);
  });

  it("unknown function and option bits", () => {
    const c = cloneLights(DEFAULTS);
    c.functions[7] = 0x0200;
    c.flags = 0x20;
    expect(fields(c)).toEqual(["light7", "flags"]);
  });

  it("limits are inclusive", () => {
    const c = cloneLights(DEFAULTS);
    Object.assign(c, { modeChannel: 16, modeCount: 6, steerChannel: 16, steerThresholdUs: 450, throttleDeadbandUs: 200 });
    expect(validateLights(c)).toEqual([]);
    Object.assign(c, { modeChannel: 0, modeCount: 1, steerChannel: 0, steerThresholdUs: 50, throttleDeadbandUs: 10 });
    expect(validateLights(c)).toEqual([]);
  });

  it("channels, mode count, threshold, dead band", () => {
    const c = cloneLights(DEFAULTS);
    Object.assign(c, { modeChannel: 17, modeCount: 0, steerChannel: 17, steerThresholdUs: 49, throttleDeadbandUs: 201 });
    expect(fields(c)).toEqual(["modeChannel", "modeCount", "steerChannel", "steerThresholdUs", "throttleDeadbandUs"]);
    Object.assign(c, { modeChannel: 1, modeCount: 7, steerChannel: 1, steerThresholdUs: 451, throttleDeadbandUs: NaN });
    expect(fields(c)).toEqual(["modeCount", "steerThresholdUs", "throttleDeadbandUs"]);
  });

  it("mode columns are exactly the mode functions", () => {
    expect(MODE_FUNCTIONS.reduce((m, f) => m | FN[f.fn], 0)).toBe(FN_MODE);
  });
});
