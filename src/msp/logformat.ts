/**
 * \author Toximik
 * \file logformat.ts
 * \brief Flight log decoder: NAND log pages of one session -> CSV per record
 *        type + summary. TypeScript twin of the firmware's Tools/log.py
 *        (decode) – same CSV text, so files from both tools are identical.
 *
 * Page (2048 B, Application/AppLog/LogFormat.hpp): header 20 B (magic "RCLG",
 * version, flags, first record offset, session, page number, time), records
 * up to byte 2044, CRC-32 over bytes 0..2043. Records may continue in the next
 * page; after a lost page the reader resyncs at the header's first record.
 * Time stamps (u32 us) are unwrapped (wrap after 71 min).
 */

export const PAGE_SIZE = 2048;
const HEADER_SIZE = 20;
const CRC_OFFSET = PAGE_SIZE - 4;
const MAGIC = [0x52, 0x43, 0x4c, 0x47]; // "RCLG"
const VERSION = 1;
const NO_RECORD = 0xffff;
const FLAG_LAST = 0x02;
const RECORD_MAX = 1024;

const REC_SESSION = 0x81;
const REC_PADDING = 0xff;

type Field = "B" | "b" | "H" | "h" | "I";
const FIELD_SIZE: Record<Field, number> = { B: 1, b: 1, H: 2, h: 2, I: 4 };

interface FixedType {
  name: string;
  fields: Field[];
  columns: string[];
}

const rep = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

/** Fixed size records: type -> layout after type + time (log.py FIXED) */
const FIXED: Record<number, FixedType> = {
  1: { name: "imu", fields: rep(6, "h"), columns: ["ax", "ay", "az", "gx", "gy", "gz"] },
  2: { name: "rc", fields: rep(16, "H"), columns: Array.from({ length: 16 }, (_, n) => `ch${n + 1}`) },
  3: {
    name: "outputs",
    fields: [...rep<Field>(9, "H"), "B", "B"],
    columns: [...Array.from({ length: 9 }, (_, n) => `out${n + 1}`), "flags", "state"],
  },
  4: {
    name: "status",
    fields: ["H", "h", "h", "B", "b", "B", "B", "B", "B", "B", "B", "H", "H", "B"],
    columns: ["battery_mv", "mcu_temp_dc", "imu_temp_raw", "lq", "rssi_dbm", "light_mode", "light_mask", "drive", "out_state",
      "cpu_load", "flags", "imu_faults", "dropped", "reserved"],
  },
  5: { name: "event", fields: ["B", "B", "H", "I"], columns: ["code", "arg8", "arg16", "arg32"] },
};
const SIZES: Record<number, number> = Object.fromEntries(
  Object.entries(FIXED).map(([t, f]) => [t, 5 + f.fields.reduce((n, x) => n + FIELD_SIZE[x], 0)]),
);

export const EVENTS: Record<number, string> = {
  1: "arm", 2: "disarm", 3: "state", 4: "light_mode", 5: "imu_fault", 6: "failsafe", 7: "log_start", 8: "log_stop", 9: "dropped",
};
const TAGS: Record<number, string> = { 1: "firmware", 2: "board_uid", 3: "imu", 4: "uptime", 5: "general", 6: "outputs", 7: "lights", 8: "log" };

/* --------------------------------------------------------------- CRC-32 */

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (zlib / IEEE), as the firmware's Crc32 middleware */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ----------------------------------------------------------------- pages */

const u16 = (d: Uint8Array, at: number) => d[at]! | (d[at + 1]! << 8);
const u32 = (d: Uint8Array, at: number) => (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0;

export interface PageHeader {
  flags: number;
  first: number;
  session: number;
  page: number;
  timeUs: number;
}

export function isErased(page: Uint8Array): boolean {
  for (let i = 0; i < HEADER_SIZE; i++) if (page[i] !== 0xff) return false;
  return true;
}

/** Header of a page with a valid CRC, null otherwise */
export function checkPage(page: Uint8Array): PageHeader | null {
  if (page.length !== PAGE_SIZE || MAGIC.some((b, i) => page[i] !== b) || page[4] !== VERSION) return null;
  const first = u16(page, 6);
  if (first !== NO_RECORD && !(first >= HEADER_SIZE && first < CRC_OFFSET)) return null;
  if (crc32(page, 0, CRC_OFFSET) !== u32(page, CRC_OFFSET)) return null;
  return { flags: page[5]!, first, session: u32(page, 8), page: u32(page, 12), timeUs: u32(page, 16) };
}

function recordSize(part: number[]): number | null {
  const type = part[0]!;
  if (type in SIZES) return SIZES[type]!;
  if (type >= 0x80 && type < 0xff) {
    if (part.length < 7) return null;
    const size = 7 + (part[5]! | (part[6]! << 8));
    return size <= RECORD_MAX ? size : 0;
  }
  return 0;
}

/** Same logic as LOG_RECORD_READER / log.py RecordReader: records of the pages of one session, in order */
export class RecordReader {
  session: number | null = null;
  lostPages = 0;
  broken = 0;
  closed = false;
  private expected = 0;
  private part: number[] = [];
  private synced = false;

  /** Records completed by this page; null = page unreadable */
  page(page: Uint8Array | null): Uint8Array[] {
    const header = page ? checkPage(page) : null;
    if (header && this.session !== null && (header.session !== this.session || header.page < this.expected)) return [];
    const lost = header === null ? 1 : this.session !== null ? header.page - this.expected : 0;
    if (lost) {
      this.lostPages += lost;
      if (this.part.length) this.broken++;
      this.part = [];
      this.synced = false;
    }
    if (header === null || page === null) {
      this.expected++;
      return [];
    }
    if (this.session === null) {
      this.session = header.session;
      this.synced = header.page === 0;
    }
    this.expected = header.page + 1;
    this.closed ||= (header.flags & FLAG_LAST) !== 0;

    let pos: number;
    if (this.synced) {
      pos = HEADER_SIZE;
    } else if (header.first !== NO_RECORD) {
      pos = header.first;
      this.synced = true;
    } else {
      return [];
    }
    const out: Uint8Array[] = [];
    while (pos < CRC_OFFSET) {
      if (!this.part.length && page[pos] === REC_PADDING) break;
      let size = this.part.length ? recordSize(this.part) : null;
      while (size === null && pos < CRC_OFFSET) {
        this.part.push(page[pos++]!);
        size = recordSize(this.part);
      }
      if (size === null) break;
      if (size === 0) {
        this.broken++;
        this.part = [];
        this.synced = false;
        break;
      }
      const take = Math.min(size - this.part.length, CRC_OFFSET - pos);
      for (let i = 0; i < take; i++) this.part.push(page[pos + i]!);
      pos += take;
      if (this.part.length === size) {
        out.push(Uint8Array.from(this.part));
        this.part = [];
      }
    }
    return out;
  }
}

/* --------------------------------------------------------------- records */

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
const latin = (d: Uint8Array) => String.fromCharCode(...d);

/** Values as log.py prints them (Python str()) */
type Value = number | string;

export function decodeRecord(rec: Uint8Array): { name: string; timeUs: number; values: [string, Value][] } {
  const type = rec[0]!;
  const timeUs = u32(rec, 1);
  const fixed = FIXED[type];
  if (fixed) {
    const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    let at = 5;
    const values: [string, Value][] = fixed.fields.map((f, i) => {
      const v = f === "B" ? view.getUint8(at) : f === "b" ? view.getInt8(at) : f === "H" ? view.getUint16(at, true)
        : f === "h" ? view.getInt16(at, true) : view.getUint32(at, true);
      at += FIELD_SIZE[f];
      return [fixed.columns[i]!, v];
    });
    return { name: fixed.name, timeUs, values };
  }
  if (type === REC_SESSION) {
    const values: [string, Value][] = [];
    const set = (k: string, v: Value) => {
      const i = values.findIndex(([n]) => n === k);
      if (i >= 0) values[i] = [k, v];
      else values.push([k, v]);
    };
    let pos = 7;
    while (pos + 3 <= rec.length) {
      const tag = rec[pos]!;
      const length = u16(rec, pos + 1);
      const data = rec.subarray(pos + 3, pos + 3 + length);
      pos += 3 + length;
      const name = TAGS[tag] ?? `tag${tag}`;
      if (tag === 1) set(name, latin(data));
      else if (tag === 3 && length >= 10) {
        set("imu_odr_hz", u16(data, 0));
        set("accel_ug_lsb", u32(data, 2));
        set("gyro_udps_lsb", u32(data, 6));
      } else if (tag === 4 && length >= 4) set("uptime_ms", u32(data, 0));
      else set(name, hex(data));
    }
    return { name: "session", timeUs, values };
  }
  return { name: `type${type.toString(16).padStart(2, "0")}`, timeUs, values: [["hex", hex(rec.subarray(5))]] };
}

/* ---------------------------------------------------------------- decode */

export interface TypeSummary {
  name: string;
  count: number;
  ratePerS: number;
  maxGapUs: number;
}

export interface DecodedSession {
  session: number | null;
  records: number;
  lostPages: number;
  broken: number;
  closed: boolean;
  /** CSV text per record type ("imu" -> "time_us,ax,..."), in order of first appearance */
  csv: Map<string, string>;
  types: TypeSummary[];
  /** Same text as log.py decode prints */
  summary: string;
}

/** Pages of one session (concatenated, 0xFF page = not read) -> CSV per record type */
export function decodeSession(data: Uint8Array): DecodedSession {
  const reader = new RecordReader();
  const csv = new Map<string, string[]>();
  const stats = new Map<string, { count: number; first: number; last: number; maxGap: number }>();
  let high = 0;
  let last: number | null = null;
  let records = 0;
  for (let at = 0; at + PAGE_SIZE <= data.length; at += PAGE_SIZE) {
    const page = data.subarray(at, at + PAGE_SIZE);
    for (const rec of reader.page(isErased(page) ? null : page)) {
      records++;
      const { name, timeUs: t32, values } = decodeRecord(rec);
      if (last !== null && t32 < last && last - t32 > 0x80000000) high += 2 ** 32;
      last = t32;
      const timeUs = high + t32;
      let lines = csv.get(name);
      if (!lines) {
        lines = [`time_us,${values.map(([k]) => k).join(",")}\n`];
        csv.set(name, lines);
      }
      const shown = name === "event" ? values.map(([k, v]): Value => (k === "code" ? `${v} ${EVENTS[v as number] ?? "?"}` : v)) : values.map(([, v]) => v);
      lines.push(`${timeUs},${shown.join(",")}\n`);
      const s = stats.get(name);
      if (!s) stats.set(name, { count: 1, first: timeUs, last: timeUs, maxGap: 0 });
      else {
        s.maxGap = Math.max(s.maxGap, timeUs - s.last);
        s.last = timeUs;
        s.count++;
      }
    }
  }
  const types: TypeSummary[] = [...stats].map(([name, s]) => {
    const span = s.count > 1 ? (s.last - s.first) / 1e6 : 0;
    return { name, count: s.count, ratePerS: span > 0 ? (s.count - 1) / span : 0, maxGapUs: s.maxGap };
  });
  const lines = [
    `session ${reader.session ?? "None"}: ${records} records, lost pages ${reader.lostPages}, broken records ${reader.broken}, ` +
      `${reader.closed ? "closed" : "not closed"}`,
    ...types.map((t) => `  ${t.name.padEnd(8)} ${String(t.count).padStart(7)}  ${t.ratePerS.toFixed(1).padStart(8)} /s  max gap ${t.maxGapUs} us`),
  ];
  return {
    session: reader.session,
    records,
    lostPages: reader.lostPages,
    broken: reader.broken,
    closed: reader.closed,
    csv: new Map([...csv].map(([k, v]) => [k, v.join("")])),
    types,
    summary: lines.join("\n") + "\n",
  };
}
