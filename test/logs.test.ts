/**
 * \author Toximik
 * \file logs.test.ts
 * \brief Log download: LOG_INFO / LOG_LIST / LOG_READ layouts (same bytes as
 *        the firmware's Test_Msp.cpp), the page decoder against a session
 *        recorded on the board (fixture, reference = Tools/log.py decode),
 *        the zip writer and the download against a fake board.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MspClient } from "../src/msp/client.ts";
import { crc8DvbS2, encodeV2, MspStreamParser } from "../src/msp/codec.ts";
import { checkPage, crc32, decodeSession, PAGE_SIZE } from "../src/msp/logformat.ts";
import { decodeLogInfo, decodeLogList, decodeLogPage, downloadSession, encodeLogRead, type LogSession } from "../src/msp/logs.ts";
import { MSP } from "../src/msp/protocol.ts";
import { makeZip } from "../src/zip.ts";

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/session_20.bin", import.meta.url)));

/** Reply frame without the 256 B limit of encodeV2 (as MSP_EncodeLarge) */
function largeReply(id: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(9 + payload.length);
  f.set([0x24, 0x58, 0x3e, 0, id & 0xff, id >> 8, payload.length & 0xff, payload.length >> 8]);
  f.set(payload, 8);
  f[f.length - 1] = crc8DvbS2(f, 3, f.length - 1);
  return f;
}

describe("log MSP payloads", () => {
  it("LOG_INFO layout (Ut_Msp_LogInfo_WireLayout)", () => {
    const bytes = Uint8Array.from([2, 1, 1, 0x05, 0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55, 0x00, 0x04, 0x84, 0x03, 3, 0, 1, 0, 7,
      0xcc, 0xbb, 0xaa, 0x99, 5, 0, 0, 0, 6, 0, 0, 0, 0x00, 0x08, 64, 8]);
    expect(decodeLogInfo(bytes)).toEqual({
      state: 2, lastEnd: 1, rec: 1, startPending: true, switchOn: false, scanDone: true, session: 0x11223344, pages: 0x55667788,
      blocks: 1024, freeBlocks: 900, badBlocks: 3, corruptBlocks: 1, sessions: 7, nextSession: 0x99aabbcc, imuDropped: 5,
      mainDropped: 6, pageSize: 2048, pagesPerBlock: 64, switchChannel: 8,
    });
  });

  it("LOG_LIST entry (Ut_Msp_LogList_Layout)", () => {
    const entry = [101, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0xe8, 0x03, 0, 0, 0xd0, 0x07, 0, 0, 1, 0, 0];
    const l = decodeLogList(Uint8Array.from([20, 4, 1, ...entry]));
    expect(l).toEqual({
      total: 20,
      first: 4,
      sessions: [{ number: 101, firstPage: 0, pages: 10, startUs: 1000, endUs: 2000, blocks: 1, closed: false }],
    });
  });

  it("LOG_READ request and reply", () => {
    expect(Array.from(encodeLogRead(0x01020304, 0x05060708))).toEqual([4, 3, 2, 1, 8, 7, 6, 5]);
    const reply = new Uint8Array(9 + PAGE_SIZE);
    reply.set([4, 3, 2, 1, 0x0d, 0x0c, 0x0b, 0x0a, 1]);
    reply[9] = 0x5a;
    const p = decodeLogPage(reply);
    expect([p.session, p.page, p.ok, p.data.length, p.data[0]]).toEqual([0x01020304, 0x0a0b0c0d, false, PAGE_SIZE, 0x5a]);
    expect(() => decodeLogPage(reply.subarray(1))).toThrow(RangeError);
  });

  it("parser takes a 2057 B reply", () => {
    const frames: number[] = [];
    const parser = new MspStreamParser((f) => frames.push(f.payload.length));
    const frame = largeReply(MSP.LOG_READ, new Uint8Array(9 + PAGE_SIZE).fill(7));
    parser.push(frame.subarray(0, 1000));
    parser.push(frame.subarray(1000));
    expect(frames).toEqual([9 + PAGE_SIZE]);
  });
});

describe("log page decoder (session 20 recorded on the board)", () => {
  it("CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("pages valid, same result as Tools/log.py decode", () => {
    expect(fixture.length).toBe(45 * PAGE_SIZE);
    expect(checkPage(fixture.subarray(0, PAGE_SIZE))).toMatchObject({ session: 20, page: 0, flags: 1 });
    const d = decodeSession(fixture);
    expect(d.summary).toBe(
      "session 20: 4495 records, lost pages 0, broken records 0, closed\n" +
        "  session        1       0.0 /s  max gap 0 us\n" +
        "  event          2       2.4 /s  max gap 412009 us\n" +
        "  rc           599     247.9 /s  max gap 8015 us\n" +
        "  imu         3754    1555.8 /s  max gap 654 us\n" +
        "  outputs      115      51.3 /s  max gap 372000 us\n" +
        "  status        24      10.0 /s  max gap 100017 us\n",
    );
    expect(d.csv.get("event")).toBe("time_us,code,arg8,arg16,arg32\n135977444,7 log_start,2,0,20\n136389453,8 log_stop,2,0,20\n");
    expect(d.csv.get("imu")!.split("\n").slice(0, 2)).toEqual(["time_us,ax,ay,az,gx,gy,gz", "133976771,-2748,531,-2554,-6,3,4"]);
  });

  it("a page not received (0xFF) is a lost page, the rest resyncs", () => {
    const damaged = fixture.slice();
    damaged.fill(0xff, 10 * PAGE_SIZE, 11 * PAGE_SIZE);
    const d = decodeSession(damaged);
    expect(d.lostPages).toBe(1);
    expect(d.broken).toBeLessThanOrEqual(1);
    expect(d.records).toBeGreaterThan(4495 - 130);
    expect(d.closed).toBe(true);
  });
});

describe("zip writer", () => {
  it("stored entries with local headers, central directory and end record", () => {
    const a = new TextEncoder().encode("hello\n");
    const z = makeZip([{ name: "s/a.csv", data: a }, { name: "s/b.txt", data: new Uint8Array(0) }], new Date(2026, 10, 1, 12, 0, 0));
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(14, true)).toBe(crc32(a));
    expect(new TextDecoder().decode(z.subarray(30 + 7, 30 + 7 + 6))).toBe("hello\n");
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const central = v.getUint32(end + 16, true);
    expect(v.getUint32(central, true)).toBe(0x02014b50);
    expect(central + v.getUint32(end + 12, true)).toBe(end);
  });
});

describe("download", () => {
  /** Fake board with session 20 from the fixture; drops the reply to `dropPage` once */
  function board(dropPage: number, refuse = false) {
    let client!: MspClient;
    let dropped = false;
    let reads = 0;
    const transport = {
      write: async (data: Uint8Array) => {
        const out: Uint8Array[] = [];
        new MspStreamParser((f) => {
          if (f.id !== MSP.LOG_READ) return;
          reads++;
          if (refuse) {
            out.push(encodeV2(f.id, Uint8Array.of(4), "!"));
            return;
          }
          const v = new DataView(f.payload.buffer, f.payload.byteOffset);
          const page = v.getUint32(4, true);
          if (page === dropPage && !dropped) {
            dropped = true;
            return;
          }
          const reply = new Uint8Array(9 + PAGE_SIZE);
          reply.set(f.payload.subarray(0, 8));
          reply.set(fixture.subarray(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), 9);
          out.push(largeReply(f.id, reply));
        }).push(data);
        queueMicrotask(() => out.forEach((o) => client.receive(o)));
      },
    };
    client = new MspClient(transport, () => {}, 50);
    return { client, reads: () => reads };
  }
  const session: LogSession = { number: 20, firstPage: 0, pages: 45, startUs: 0, endUs: 1, blocks: 1, closed: true };

  it("all pages in order, a lost reply asked again", async () => {
    const b = board(17);
    const r = await downloadSession(b.client, session);
    expect(r.missing).toBe(0);
    expect(r.readErrors).toBe(0);
    expect(r.data).toEqual(fixture);
    expect(b.reads()).toBe(46);
  });

  it("a refusal (armed) ends the download with the error", async () => {
    await expect(downloadSession(board(-1, true).client, session)).rejects.toThrow(/locked/);
  });
});
