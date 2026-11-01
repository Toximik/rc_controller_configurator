/**
 * \author Toximik
 * \file payloads.test.ts
 * \brief Live data decoders against the wire bytes of the firmware host tests
 *        (Test_Msp.cpp: Ut_Msp_Status_WireLayout, Ut_Msp_LiveData_Sizes).
 */

import { describe, expect, it } from "vitest";
import { armBlockNames, decodeBattery, decodeOutputsLive, decodeRc, decodeStatus } from "../src/msp/payloads.ts";

describe("STATUS", () => {
  // Ut_Msp_Status_WireLayout: { 0x01020304, 2, 0x24, 0x0105, 0, 7, 3, 1, 1556, 2, 235, 4, 99, 45, 47, -3, 7, 3, 3, 0x8001, 12, 2, "ARMED !IMU" }
  const wire = Uint8Array.from([
    0x04, 0x03, 0x02, 0x01, 2, 0x24, 0x05, 0x01, 0, 7, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0x14, 0x06, 2, 0, 0, 0, 0xeb, 0, 4, 0, 0, 0,
    // offset 33: LQ, RSSI 1/2, SNR, RF, settings state, layout, repaired, load, last save, mode text
    99, 45, 47, 0xfd, 7, 3, 3, 0, 0x01, 0x80, 12, 0, 2, 10, ..."ARMED !IMU".split("").map((ch) => ch.charCodeAt(0)),
  ]);

  it("has the firmware size: 46 B fixed + mode text", () => {
    expect(wire.length).toBe(46 + 1 + 10);
  });

  it("decodes every field", () => {
    expect(decodeStatus(wire)).toEqual({
      uptimeMs: 0x01020304,
      outputState: 2,
      armBlock: 0x24,
      flags: 0x0105,
      failsafeSource: 0,
      failsafeTrips: 7,
      armCount: 3,
      rcLostCount: 1,
      imuSamplesPerSecond: 1556,
      imuFaults: 2,
      rcFramesPerSecond: 235,
      linkLostCount: 4,
      linkQuality: 99,
      rssi1: 45,
      rssi2: 47,
      snr: -3,
      rfProfile: 7,
      settingsState: 3,
      settingsLayout: 3,
      repairedOutputs: 0x8001,
      loadPermille: 12,
      lastSave: 2,
      mode: "ARMED !IMU",
    });
  });

  it("ignores appended fields (newer API minor)", () => {
    const longer = Uint8Array.from([...wire, 0xaa, 0xbb]);
    expect(decodeStatus(longer).mode).toBe("ARMED !IMU");
  });

  it("throws on a short payload", () => {
    expect(() => decodeStatus(wire.subarray(0, 40))).toThrow(RangeError);
  });

  it("names the arm block bits", () => {
    expect(armBlockNames(0x24)).toEqual(["ESC not centered", "arm switch on (switch off first)"]);
  });
});

describe("RC / BATTERY / OUTPUTS_LIVE", () => {
  it("RC: link + 16 channels", () => {
    const d = new Uint8Array(33);
    d[0] = 1;
    d[1] = 0xdc;
    d[2] = 0x05;
    d[31] = 0xdb;
    d[32] = 0x07;
    const rc = decodeRc(d);
    expect(rc.linkActive).toBe(true);
    expect(rc.channels).toHaveLength(16);
    expect(rc.channels[0]).toBe(1500);
    expect(rc.channels[15]).toBe(2011);
  });

  it("BATTERY", () => {
    expect(decodeBattery(Uint8Array.from([1, 0x58, 0x2a, 0xe4, 0x0c, 0x83, 0xff]))).toEqual({
      ready: true,
      batteryMv: 10840,
      vddaMv: 3300,
      temperatureC: -12.5,
    });
  });

  it("OUTPUTS_LIVE", () => {
    const d = new Uint8Array(23);
    d[16] = 0xd2; // OUT9 = 1234 us
    d[17] = 0x04;
    d[18] = 0x01; // OUT_ENABLE
    d[19] = 0b101;
    d[20] = 2;
    d[21] = 0x03;
    d[22] = 3;
    expect(decodeOutputsLive(d)).toEqual({
      pulses: [0, 0, 0, 0, 0, 0, 0, 0, 1234],
      outputEnable: true,
      lightTest: false,
      lightMask: 0b101,
      lightMode: 2,
      hazardOn: true,
      hazardByButton: true,
      drive: 3,
    });
  });
});
