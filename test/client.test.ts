/**
 * \author Toximik
 * \file client.test.ts
 * \brief MSP client against a fake board: batching, matching, error replies,
 *        timeouts, CLI text, connect handshake checks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeV2, MspStreamParser } from "../src/msp/codec.ts";
import { MspClient, MspErrorReply, MspTimeout } from "../src/msp/client.ts";
import { IncompatibleBoard, readIdentity } from "../src/msp/identity.ts";
import { MSP } from "../src/msp/protocol.ts";

type Handler = (payload: Uint8Array) => { error?: number; reply?: number[] } | null;

/** Fake board: parses requests, answers each frame (null = no answer), prefixes CLI text once */
function fakeBoard(handlers: Record<number, Handler>, banner = "") {
  const writes: number[] = [];
  let client!: MspClient;
  let pendingBanner = banner;
  const transport = {
    write: async (data: Uint8Array) => {
      writes.push(data.length);
      const out: number[] = [...new TextEncoder().encode(pendingBanner)];
      pendingBanner = "";
      const parser = new MspStreamParser((f) => {
        const h = handlers[f.id];
        const r = h ? h(f.payload) : { error: 1 };
        if (!r) return;
        out.push(...(r.error !== undefined ? encodeV2(f.id, Uint8Array.of(r.error), "!") : encodeV2(f.id, Uint8Array.from(r.reply ?? []), ">")));
      });
      parser.push(data);
      queueMicrotask(() => client.receive(Uint8Array.from(out)));
    },
  };
  let text = "";
  client = new MspClient(transport, (t) => (text += t), 100);
  return { client, writes, text: () => text };
}

const ascii = (s: string) => s.split("").map((c) => c.charCodeAt(0));
const pstr = (s: string) => [s.length, ...ascii(s)];

const identityHandlers = (variant = "RCCT", major = 1, minor = 1): Record<number, Handler> => ({
  [MSP.FC_VARIANT]: () => ({ reply: ascii(variant) }),
  [MSP.API_VERSION]: () => ({ reply: [0, major, minor] }),
  [MSP.FC_VERSION]: () => ({ reply: [0, 2, 0] }),
  [MSP.BOARD_INFO]: () => ({ reply: [...ascii("MAIN"), 0x00, 0x01, 0, 1, ...pstr("RCCT"), ...pstr("MAIN V1.0"), ...pstr(""), 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0] }),
  [MSP.BUILD_INFO]: () => ({ reply: [...ascii("Nov  1 2026"), ...ascii("12:34:56"), 0, 0, 0, 0, 0, 0, 0] }),
});

afterEach(() => vi.useRealTimers());

describe("MspClient", () => {
  it("sends a batch in one write and resolves each reply", async () => {
    const b = fakeBoard({ [MSP.STATUS]: () => ({ reply: [1] }), [MSP.RC]: () => ({ reply: [2] }) });
    const [s, r] = b.client.requestMany([{ id: MSP.STATUS }, { id: MSP.RC }]);
    expect(Array.from(await s!)).toEqual([1]);
    expect(Array.from(await r!)).toEqual([2]);
    expect(b.writes).toHaveLength(1);
    expect(b.client.stats.replies).toBe(2);
  });

  it("rejects an error reply with its code", async () => {
    const b = fakeBoard({ [MSP.SET_GENERAL]: () => ({ error: 4 }) });
    const err = await b.client.request(MSP.SET_GENERAL, Uint8Array.of(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MspErrorReply);
    expect((err as MspErrorReply).code).toBe(4);
    expect((err as Error).message).toContain("locked");
  });

  it("times out without a reply, later requests still work", async () => {
    vi.useFakeTimers();
    const b = fakeBoard({ [MSP.STATUS]: () => null, [MSP.RC]: () => ({ reply: [5] }) });
    const lost = b.client.request(MSP.STATUS).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(150);
    expect(await lost).toBeInstanceOf(MspTimeout);
    const ok = b.client.request(MSP.RC);
    await vi.advanceTimersByTimeAsync(1);
    expect(Array.from(await ok)).toEqual([5]);
    expect(b.client.stats.timeouts).toBe(1);
  });

  it("passes CLI text to the text listener", async () => {
    const b = fakeBoard({ [MSP.RC]: () => ({ reply: [] }) }, "RC_Controller CLI\r\n> ");
    await b.client.request(MSP.RC);
    expect(b.text()).toBe("RC_Controller CLI\r\n> ");
  });

  it("rejects pending and new requests after close", async () => {
    const b = fakeBoard({ [MSP.STATUS]: () => null });
    const p = b.client.request(MSP.STATUS).catch((e: unknown) => (e as Error).message);
    b.client.close("unplugged");
    expect(await p).toBe("unplugged");
    expect(await b.client.request(MSP.RC).catch((e: unknown) => (e as Error).message)).toBe("port closed");
  });
});

describe("connect handshake", () => {
  it("reads the identity", async () => {
    const b = fakeBoard(identityHandlers());
    const id = await readIdentity(b.client, 1);
    expect(id).toMatchObject({ variant: "RCCT", firmware: "0.2.0", api: { major: 1, minor: 1 }, newerMinor: false });
    expect(id.board).toMatchObject({ boardId: "MAIN", hardwareRevision: 0x0100, boardName: "MAIN V1.0", uid: "00000001 00000002 00000003" });
    expect(id.build).toEqual({ date: "Nov  1 2026", time: "12:34:56", git: "" });
  });

  it("flags a newer API minor", async () => {
    const b = fakeBoard(identityHandlers("RCCT", 1, 5));
    expect((await readIdentity(b.client, 1)).newerMinor).toBe(true);
  });

  it("refuses another firmware", async () => {
    const b = fakeBoard(identityHandlers("BTFL"));
    await expect(readIdentity(b.client, 1)).rejects.toBeInstanceOf(IncompatibleBoard);
  });

  it("refuses another API major", async () => {
    const b = fakeBoard(identityHandlers("RCCT", 2, 0));
    await expect(readIdentity(b.client, 1)).rejects.toThrow(/update the configurator/);
  });
});
