/**
 * \author Toximik
 * \file codec.test.ts
 * \brief MSP codec tests. Frame vectors shared with the firmware host tests
 *        (Application/AppMsp/Tests/UnitTests/Test_Msp.cpp).
 */

import { describe, expect, it } from "vitest";
import { crc8DvbS2, encodeV2, MspReader, MspStreamParser, type MspFrame } from "../src/msp/codec.ts";

/** MSP v2 request MSP_IDENT (id 100, no payload), INAV wiki "MSP V2" = Test_Msp.cpp g_carr_byIdentV2 */
const IDENT_V2 = [0x24, 0x58, 0x3c, 0x00, 0x64, 0x00, 0x00, 0x00, 0x8f];

function collect() {
  const frames: MspFrame[] = [];
  let text = "";
  const parser = new MspStreamParser(
    (f) => frames.push(f),
    (b) => (text += new TextDecoder().decode(b)),
  );
  return { parser, frames, text: () => text };
}

const reply = (id: number, payload: number[] = [], type: "<" | ">" | "!" = ">") => encodeV2(id, Uint8Array.from(payload), type);

describe("crc / encoder", () => {
  it("encodes the INAV reference frame", () => {
    expect(Array.from(encodeV2(100))).toEqual(IDENT_V2);
  });

  it("CRC-8 DVB-S2 of the empty input is 0", () => {
    expect(crc8DvbS2([])).toBe(0);
  });

  it("encodes the payload length and the CRC over flag..payload", () => {
    const f = encodeV2(0x4011, Uint8Array.from([1, 2, 3]));
    expect(Array.from(f.subarray(0, 8))).toEqual([0x24, 0x58, 0x3c, 0, 0x11, 0x40, 3, 0]);
    expect(f[f.length - 1]).toBe(crc8DvbS2(f, 3, f.length - 1));
  });

  it("refuses an oversized payload", () => {
    expect(() => encodeV2(1, new Uint8Array(257))).toThrow(RangeError);
  });
});

describe("stream parser", () => {
  it("finds a frame fed byte by byte", () => {
    const c = collect();
    for (const b of reply(0x4002, [1, 2, 3])) c.parser.push(Uint8Array.of(b));
    expect(c.frames).toHaveLength(1);
    expect(c.frames[0]).toMatchObject({ type: ">", id: 0x4002 });
    expect(Array.from(c.frames[0]!.payload)).toEqual([1, 2, 3]);
  });

  it("separates CLI text before, between and after frames", () => {
    const c = collect();
    const enc = new TextEncoder();
    const parts = [enc.encode("banner\r\n> "), reply(2, [0x52, 0x43, 0x43, 0x54]), enc.encode("cost $5 "), reply(1, [0, 1, 1]), enc.encode("tail")];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    // arbitrary chunking
    for (let i = 0; i < all.length; i += 5) c.parser.push(all.subarray(i, i + 5));
    expect(c.frames.map((f) => f.id)).toEqual([2, 1]);
    expect(c.text()).toBe("banner\r\n> cost $5 tail");
  });

  it("resyncs after a CRC error and finds the next frame", () => {
    const c = collect();
    const bad = reply(0x4000, [9, 9]);
    bad[bad.length - 1]! ^= 0xff;
    c.parser.push(Uint8Array.from([...bad, ...reply(0x4001, [7])]));
    expect(c.parser.counters.crcErrors).toBe(1);
    expect(c.frames.map((f) => f.id)).toEqual([0x4001]);
  });

  it("rejects an oversized length as syntax error and resyncs", () => {
    const c = collect();
    c.parser.push(Uint8Array.from([0x24, 0x58, 0x3e, 0, 0, 0x40, 0x01, 0x02, ...reply(3, [0, 2, 0])]));
    expect(c.parser.counters.syntaxErrors).toBe(1);
    expect(c.frames.map((f) => f.id)).toEqual([3]);
  });

  it("passes error replies with their code", () => {
    const c = collect();
    c.parser.push(reply(0x4011, [4], "!"));
    expect(c.frames[0]).toMatchObject({ type: "!", id: 0x4011 });
    expect(c.frames[0]!.payload[0]).toBe(4);
  });

  it("keeps a partial frame until reset", () => {
    const c = collect();
    const f = reply(0x4000, [1, 2, 3, 4]);
    c.parser.push(f.subarray(0, 6));
    c.parser.reset();
    c.parser.push(reply(1, [0, 1, 1]));
    expect(c.frames.map((x) => x.id)).toEqual([1]);
  });
});

describe("reader", () => {
  it("reads little-endian fields and strings", () => {
    const r = new MspReader(Uint8Array.from([0x34, 0x12, 0xfd, 0x83, 0xff, 3, 0x61, 0x62, 0x63, 0x78, 0, 0x79]));
    expect(r.u16()).toBe(0x1234);
    expect(r.i8()).toBe(-3);
    expect(r.i16()).toBe(-125);
    expect(r.pstring()).toBe("abc");
    expect(r.text(3)).toBe("x");
    expect(r.remaining).toBe(0);
  });

  it("throws past the end", () => {
    expect(() => new MspReader(Uint8Array.of(1)).u16()).toThrow(RangeError);
  });
});
