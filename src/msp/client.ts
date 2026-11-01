/**
 * \author Toximik
 * \file client.ts
 * \brief Transport independent MSP request / reply client.
 *
 * The firmware answers requests in order, all requests of one write in the
 * same task run (cdc_port, 10 ms) – so polls are sent together with
 * requestMany(). A reply is matched to the oldest pending request with the
 * same ID. Bytes outside frames are CLI text (banner, prompt) and go to the
 * text listener.
 */

import { encodeV2, MspStreamParser, type MspFrame } from "./codec.ts";
import { MSP_ERRORS } from "./protocol.ts";

export interface MspTransport {
  write(data: Uint8Array): Promise<void>;
}

/** Error reply "$X!" from the board */
export class MspErrorReply extends Error {
  constructor(
    readonly id: number,
    readonly code: number,
  ) {
    super(`0x${id.toString(16).padStart(4, "0")}: ${MSP_ERRORS[code] ?? `error ${code}`}`);
    this.name = "MspErrorReply";
  }
}

export class MspTimeout extends Error {
  constructor(readonly id: number) {
    super(`no reply to 0x${id.toString(16).padStart(4, "0")}`);
    this.name = "MspTimeout";
  }
}

export interface MspRequest {
  id: number;
  payload?: Uint8Array;
}

interface Pending {
  id: number;
  resolve: (payload: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sentAt: number;
}

export interface ClientStats {
  requests: number;
  replies: number;
  errorReplies: number;
  timeouts: number;
  /** Round trip of the last reply [ms] */
  lastRoundTripMs: number;
}

export class MspClient {
  readonly stats: ClientStats = { requests: 0, replies: 0, errorReplies: 0, timeouts: 0, lastRoundTripMs: 0 };
  private readonly parser: MspStreamParser;
  private pending: Pending[] = [];
  private closed = false;

  constructor(
    private readonly transport: MspTransport,
    private readonly onText: (text: string) => void = () => {},
    private readonly timeoutMs = 500,
  ) {
    this.parser = new MspStreamParser(
      (frame) => this.onFrame(frame),
      (bytes) => this.onText(new TextDecoder().decode(bytes)),
    );
  }

  get parserCounters() {
    return this.parser.counters;
  }

  /** Bytes received from the transport */
  receive(chunk: Uint8Array): void {
    this.parser.push(chunk);
  }

  request(id: number, payload?: Uint8Array): Promise<Uint8Array> {
    return this.requestMany([{ id, payload }])[0]!;
  }

  /** All frames in one write: the board answers them in the same task run */
  requestMany(requests: MspRequest[]): Promise<Uint8Array>[] {
    if (this.closed) {
      return requests.map(() => Promise.reject(new Error("port closed")));
    }
    const frames = requests.map((q) => encodeV2(q.id, q.payload));
    const total = frames.reduce((n, f) => n + f.length, 0);
    const data = new Uint8Array(total);
    let at = 0;
    for (const f of frames) {
      data.set(f, at);
      at += f.length;
    }
    const now = performance.now();
    const batch: Pending[] = [];
    const promises = requests.map(
      (q) =>
        new Promise<Uint8Array>((resolve, reject) => {
          const entry: Pending = {
            id: q.id,
            resolve,
            reject,
            sentAt: now,
            timer: setTimeout(() => this.expire(entry), this.timeoutMs),
          };
          batch.push(entry);
          this.pending.push(entry);
        }),
    );
    this.stats.requests += requests.length;
    this.transport.write(data).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const p of batch.filter((e) => this.pending.includes(e))) {
        this.settle(p);
        p.reject(err);
      }
    });
    return promises;
  }

  /** Rejects everything pending; later requests fail at once */
  close(reason = "port closed"): void {
    this.closed = true;
    for (const p of [...this.pending]) {
      this.settle(p);
      p.reject(new Error(reason));
    }
  }

  private onFrame(frame: MspFrame): void {
    if (frame.type === "<") {
      return; // not a reply
    }
    const p = this.pending.find((e) => e.id === frame.id);
    if (!p) {
      return; // late reply after a timeout
    }
    this.settle(p);
    this.stats.lastRoundTripMs = performance.now() - p.sentAt;
    if (frame.type === "!") {
      this.stats.errorReplies++;
      p.reject(new MspErrorReply(frame.id, frame.payload[0] ?? 0));
    } else {
      this.stats.replies++;
      p.resolve(frame.payload);
    }
  }

  private expire(p: Pending): void {
    this.settle(p);
    this.stats.timeouts++;
    if (this.pending.length === 0) {
      this.parser.reset(); // a broken partial frame must not block the next replies
    }
    p.reject(new MspTimeout(p.id));
  }

  private settle(p: Pending): void {
    clearTimeout(p.timer);
    this.pending = this.pending.filter((e) => e !== p);
  }
}
