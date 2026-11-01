/**
 * \author Toximik
 * \file logs.ts
 * \brief Flight logger on the board over MSP (API 1.3, firmware
 *        Docs/PHASE3_LOGGER_PLAN.md section 11): LOG_INFO, LOG_LIST, page
 *        download (LOG_READ), LOG_ERASE, LOG_CONTROL.
 *
 * LOG_READ: one 2048 B page per request; the board queues up to 8 reads and
 * answers in request order (~1 MB/s). Every reply names its session and page,
 * so a reply that arrives after its request timed out is still used.
 */

import { MspErrorReply, type MspClient } from "./client.ts";
import { MspReader, MspWriter } from "./codec.ts";
import { PAGE_SIZE } from "./logformat.ts";
import { MSP } from "./protocol.ts";

export const LOGGER_STATES = ["scanning", "idle", "logging", "closing", "erasing", "checking", "no chip"] as const;
export const LOGGER_ENDS = ["-", "stopped", "chip full", "program error"] as const;
export const LOGGER_REC = ["off", "REC", "REC FULL", "REC ERR"] as const;
export const LOGGER_STATE = { SCAN: 0, IDLE: 1, LOGGING: 2, CLOSING: 3, ERASING: 4, CHECKING: 5, NO_CHIP: 6 } as const;

export interface LogInfo {
  state: number;
  lastEnd: number;
  rec: number;
  startPending: boolean;
  switchOn: boolean;
  scanDone: boolean;
  session: number;
  pages: number;
  blocks: number;
  freeBlocks: number;
  badBlocks: number;
  corruptBlocks: number;
  sessions: number;
  nextSession: number;
  imuDropped: number;
  mainDropped: number;
  pageSize: number;
  pagesPerBlock: number;
  switchChannel: number;
}

export function decodeLogInfo(d: Uint8Array): LogInfo {
  const r = new MspReader(d);
  const state = r.u8();
  const lastEnd = r.u8();
  const rec = r.u8();
  const flags = r.u8();
  return {
    state,
    lastEnd,
    rec,
    startPending: (flags & 1) !== 0,
    switchOn: (flags & 2) !== 0,
    scanDone: (flags & 4) !== 0,
    session: r.u32(),
    pages: r.u32(),
    blocks: r.u16(),
    freeBlocks: r.u16(),
    badBlocks: r.u16(),
    corruptBlocks: r.u16(),
    sessions: r.u8(),
    nextSession: r.u32(),
    imuDropped: r.u32(),
    mainDropped: r.u32(),
    pageSize: r.u16(),
    pagesPerBlock: r.u8(),
    switchChannel: r.u8(),
  };
}

export interface LogSession {
  number: number;
  /** Page number of the first page still on the chip (0 unless the start is missing) */
  firstPage: number;
  /** Page number of the last page + 1 */
  pages: number;
  startUs: number;
  endUs: number;
  blocks: number;
  closed: boolean;
}

/** Pages on the chip */
export const sessionPages = (s: LogSession) => s.pages - s.firstPage;
/** Length from the page time stamps [s] */
export const sessionSeconds = (s: LogSession) => ((s.endUs - s.startUs) >>> 0) / 1e6;

export function decodeLogList(d: Uint8Array): { total: number; first: number; sessions: LogSession[] } {
  const r = new MspReader(d);
  const total = r.u8();
  const first = r.u8();
  const count = r.u8();
  const sessions: LogSession[] = [];
  for (let i = 0; i < count; i++) {
    sessions.push({
      number: r.u32(),
      firstPage: r.u32(),
      pages: r.u32(),
      startUs: r.u32(),
      endUs: r.u32(),
      blocks: r.u16(),
      closed: (r.u8() & 1) !== 0,
    });
  }
  return { total, first, sessions };
}

export function encodeLogRead(session: number, page: number): Uint8Array {
  return new MspWriter().u32(session).u32(page).bytes();
}

export interface LogPage {
  session: number;
  page: number;
  /** false = NAND read error on the board (data not valid) */
  ok: boolean;
  data: Uint8Array;
}

export function decodeLogPage(d: Uint8Array): LogPage {
  if (d.length !== 9 + PAGE_SIZE) throw new RangeError(`LOG_READ reply ${d.length} B, expected ${9 + PAGE_SIZE} B`);
  const r = new MspReader(d);
  return { session: r.u32(), page: r.u32(), ok: r.u8() === 0, data: d.slice(9) };
}

export async function readLogInfo(c: MspClient): Promise<LogInfo> {
  return decodeLogInfo(await c.request(MSP.LOG_INFO));
}

/** All sessions on the chip, oldest first (empty while the board scans) */
export async function readLogSessions(c: MspClient): Promise<LogSession[]> {
  const out: LogSession[] = [];
  for (;;) {
    const l = decodeLogList(await c.request(MSP.LOG_LIST, Uint8Array.of(out.length)));
    out.push(...l.sessions);
    if (l.sessions.length === 0 || out.length >= l.total) return out;
  }
}

export interface DownloadProgress {
  done: number;
  total: number;
  bytesPerS: number;
}

export interface DownloadResult {
  /** Pages in page order, a page not received = 0xFF (the decoder counts it as lost) */
  data: Uint8Array;
  pages: number;
  missing: number;
  readErrors: number;
  seconds: number;
}

/** Requests in flight = the board's read queue (LOGGER::g_cnReadQueue) */
const WINDOW = 8;
const RETRIES = 3;

/**
 * Downloads one session. Refusals (armed, logging started meanwhile) end it with
 * the MspErrorReply; signal.aborted ends it after the requests in flight.
 */
export async function downloadSession(
  c: MspClient,
  s: LogSession,
  onProgress: (p: DownloadProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const total = sessionPages(s);
  const got = new Map<number, Uint8Array>();
  const bad = new Set<number>();
  const tries = new Map<number, number>();
  const t0 = performance.now();
  let lastReport = 0;
  let failure: unknown = null;

  for (let round = 0; round < RETRIES && failure === null; round++) {
    const todo: number[] = [];
    for (let p = s.firstPage; p < s.pages; p++) if (!got.has(p) && !bad.has(p)) todo.push(p);
    if (todo.length === 0) break;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && failure === null && !signal?.aborted) {
        const page = todo[next++]!;
        tries.set(page, (tries.get(page) ?? 0) + 1);
        try {
          const reply = decodeLogPage(await c.request(MSP.LOG_READ, encodeLogRead(s.number, page)));
          if (reply.session === s.number) {
            if (reply.ok) got.set(reply.page, reply.data);
            else bad.add(reply.page);
          }
        } catch (error) {
          if (error instanceof MspErrorReply) failure = error; // refused: no point going on
          // timeout: asked again in the next round
        }
        const now = performance.now();
        if (now - lastReport > 200) {
          lastReport = now;
          const done = got.size + bad.size;
          onProgress({ done, total, bytesPerS: (done * PAGE_SIZE * 1000) / (now - t0) });
        }
      }
    };
    await Promise.all(Array.from({ length: WINDOW }, worker));
    if (signal?.aborted) throw new DOMException("download cancelled", "AbortError");
  }
  if (failure !== null) throw failure;

  const data = new Uint8Array(total * PAGE_SIZE).fill(0xff);
  let missing = 0;
  for (let p = s.firstPage; p < s.pages; p++) {
    const page = got.get(p);
    if (page) data.set(page, (p - s.firstPage) * PAGE_SIZE);
    else missing++;
  }
  const seconds = (performance.now() - t0) / 1000;
  onProgress({ done: total, total, bytesPerS: (total * PAGE_SIZE) / Math.max(seconds, 1e-3) });
  return { data, pages: total, missing, readErrors: bad.size, seconds };
}
