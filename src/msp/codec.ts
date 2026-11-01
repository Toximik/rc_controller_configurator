/**
 * \author Toximik
 * \file codec.ts
 * \brief MSP v2 codec: CRC-8 DVB-S2, request encoder, reply stream parser,
 *        little-endian payload reader. TypeScript twin of the firmware
 *        Application/AppMsp/MspCodec (frame vectors shared with its host tests).
 *
 * Frame: '$' 'X' type flag id(u16 LE) size(u16 LE) payload crc8,
 * CRC over flag..payload. The USB port is shared with the CLI, so the reply
 * stream also carries CLI text (banner, prompt): the parser skips every byte
 * outside a frame and hands it to an optional text sink.
 */

/** Largest payload the firmware accepts / sends (PHASE2_MSP_PLAN.md section 2) */
export const MSP_MAX_PAYLOAD = 256;
/** Largest reply payload accepted: LOG_READ carries a 2048 B NAND page (2057 B, PHASE3_LOGGER_PLAN.md section 11) */
export const MSP_MAX_REPLY_PAYLOAD = 4096;

/** Header '$' 'X' type flag id(2) size(2) */
const HEADER_SIZE = 8;

export type MspType = "<" | ">" | "!";

export interface MspFrame {
  type: MspType;
  flag: number;
  id: number;
  payload: Uint8Array;
}

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let crc = v;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
    t[v] = crc;
  }
  return t;
})();

export function crc8DvbS2(data: ArrayLike<number>, start = 0, end = data.length, crc = 0): number {
  for (let i = start; i < end; i++) {
    crc = CRC8_TABLE[crc ^ data[i]!]!;
  }
  return crc;
}

/** Encodes one MSP v2 frame (request by default) */
export function encodeV2(id: number, payload: Uint8Array = new Uint8Array(0), type: MspType = "<", flag = 0): Uint8Array {
  if (payload.length > MSP_MAX_PAYLOAD) {
    throw new RangeError(`MSP payload ${payload.length} B > ${MSP_MAX_PAYLOAD} B`);
  }
  const frame = new Uint8Array(HEADER_SIZE + payload.length + 1);
  frame[0] = 0x24; // '$'
  frame[1] = 0x58; // 'X'
  frame[2] = type.charCodeAt(0);
  frame[3] = flag & 0xff;
  frame[4] = id & 0xff;
  frame[5] = (id >> 8) & 0xff;
  frame[6] = payload.length & 0xff;
  frame[7] = (payload.length >> 8) & 0xff;
  frame.set(payload, HEADER_SIZE);
  frame[frame.length - 1] = crc8DvbS2(frame, 3, frame.length - 1);
  return frame;
}

export interface ParserCounters {
  frames: number;
  crcErrors: number;
  /** '$X' with an unknown type or an oversized length: resynced */
  syntaxErrors: number;
}

/**
 * Stream parser for replies on the shared port. push() accepts any chunk
 * split; complete frames go to onFrame, all other bytes to onText.
 * A bad frame drops only its '$' and the scan restarts after it, so a frame
 * following garbage is still found.
 */
export class MspStreamParser {
  readonly counters: ParserCounters = { frames: 0, crcErrors: 0, syntaxErrors: 0 };
  private buf = new Uint8Array(0);

  constructor(
    private readonly onFrame: (frame: MspFrame) => void,
    private readonly onText: (bytes: Uint8Array) => void = () => {},
  ) {}

  push(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf, 0);
    joined.set(chunk, this.buf.length);
    let pos = 0;
    let textStart = 0;

    while (pos < joined.length) {
      if (joined[pos] !== 0x24) {
        pos++;
        continue;
      }
      // '$' found: need '$' 'X' + header to decide
      const avail = joined.length - pos;
      if (avail >= 2 && joined[pos + 1] !== 0x58) {
        pos++; // a '$' in CLI text
        continue;
      }
      if (avail < HEADER_SIZE) {
        break; // keep the partial header
      }
      const type = String.fromCharCode(joined[pos + 2]!);
      const size = joined[pos + 6]! | (joined[pos + 7]! << 8);
      if ((type !== ">" && type !== "!" && type !== "<") || size > MSP_MAX_REPLY_PAYLOAD) {
        this.counters.syntaxErrors++;
        pos++;
        continue;
      }
      if (avail < HEADER_SIZE + size + 1) {
        break; // keep the partial frame
      }
      const crc = crc8DvbS2(joined, pos + 3, pos + HEADER_SIZE + size);
      if (crc !== joined[pos + HEADER_SIZE + size]) {
        this.counters.crcErrors++;
        pos++;
        continue;
      }
      if (pos > textStart) {
        this.onText(joined.slice(textStart, pos));
      }
      this.counters.frames++;
      this.onFrame({
        type: type as MspType,
        flag: joined[pos + 3]!,
        id: joined[pos + 4]! | (joined[pos + 5]! << 8),
        payload: joined.slice(pos + HEADER_SIZE, pos + HEADER_SIZE + size),
      });
      pos += HEADER_SIZE + size + 1;
      textStart = pos;
    }

    // Everything before a kept partial frame is text
    const keepFrom = pos < joined.length ? pos : joined.length;
    if (keepFrom > textStart) {
      this.onText(joined.slice(textStart, keepFrom));
    }
    this.buf = joined.slice(keepFrom);
  }

  /** Drops a kept partial frame (e.g. after a request timeout) */
  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

/** Little-endian payload reader; reading past the end throws (short payload = protocol error) */
export class MspReader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array, offset = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = offset;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private need(n: number): number {
    if (this.pos + n > this.data.length) {
      throw new RangeError(`MSP payload too short: need ${this.pos + n} B, have ${this.data.length} B`);
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  i8(): number {
    return this.view.getInt8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  bytes(n: number): Uint8Array {
    const at = this.need(n);
    return this.data.slice(at, at + n);
  }
  /** Fixed size ASCII field, ends at the first zero */
  text(n: number): string {
    const raw = this.bytes(n);
    const zero = raw.indexOf(0);
    return ascii(zero < 0 ? raw : raw.subarray(0, zero));
  }
  /** Length byte + characters (Betaflight pstring) */
  pstring(): string {
    return ascii(this.bytes(this.u8()));
  }
}

/** Little-endian payload writer (grows as needed); values out of range throw (encoder bug, not user input) */
export class MspWriter {
  private buf = new Uint8Array(64);
  private len = 0;

  get length(): number {
    return this.len;
  }

  private put(n: number, value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`MSP field value ${value} outside ${min}..${max}`);
    }
    if (this.len + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
      next.set(this.buf);
      this.buf = next;
    }
    for (let i = 0; i < n; i++) {
      this.buf[this.len++] = (value >>> (8 * i)) & 0xff;
    }
  }

  u8(value: number): this {
    this.put(1, value, 0, 0xff);
    return this;
  }
  u16(value: number): this {
    this.put(2, value, 0, 0xffff);
    return this;
  }
  u32(value: number): this {
    this.put(4, value, 0, 0xffffffff);
    return this;
  }

  /** Copy of the written bytes */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
