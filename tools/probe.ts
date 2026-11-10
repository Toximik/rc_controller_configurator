/**
 * \author Toximik
 * \file probe.ts
 * \brief Runs the configurator's MSP client (connect handshake + status poll)
 *        against the board from Node, without a browser (macOS / Linux tty).
 *
 * usage: npm run probe -- /dev/cu.usbmodem1101 [seconds]
 *        npm run probe -- /dev/cu.usbmodem1101 outputs|lights|log|beeper
 *
 * "outputs": OUTPUTS area through the configurator's encoder / decoder:
 * read, write back unchanged, change OUT9 only when it has no source (no
 * pulses – nothing moves), invalid write refused + unchanged, original
 * restored. Nothing is saved.
 *
 * "lights": LIGHTS area the same way; the edit changes only a spare mode
 * (beyond the modes in use) and the turn signal threshold (armed only).
 *
 * "beeper": BEEPER area the same way; the edit changes only the lost alarm
 * delay (switch channel and flags stay as on the board - no sound).
 *
 * "logs [n] [out.zip]": logger info + session list, downloads session n
 * (default: the last) through the configurator's download + decoder, writes
 * the CSV zip as the Logs page does (default /tmp/session_<n>.zip). Read only.
 */

import { execFileSync } from "node:child_process";
import { constants, openSync, write, writeFileSync } from "node:fs";
import { ReadStream } from "node:tty";
import { MspClient } from "../src/msp/client.ts";
import { readIdentity } from "../src/msp/identity.ts";
import { armBlockNames, decodeBattery, decodeOutputsLive, decodeRc, decodeStatus, OUTPUT_STATES } from "../src/msp/payloads.ts";
import { MspErrorReply } from "../src/msp/client.ts";
import { cloneOutputs, decodeOutputs, encodeOutputs, sameOutputs, validateOutputs, FAILSAFE_NAMES } from "../src/msp/outputs.ts";
import { cloneLights, decodeLights, encodeLights, FN, functionNames, LIGHT_MODES, sameLights, validateLights } from "../src/msp/lights.ts";
import { cloneLog, decodeLog, encodeLog, sameLog, validateLog } from "../src/msp/log.ts";
import { cloneBeeper, decodeBeeper, encodeBeeper, sameBeeper, validateBeeper } from "../src/msp/beeper.ts";
import { API_MINOR_KNOWN, MSP } from "../src/msp/protocol.ts";
import { decodeSession } from "../src/msp/logformat.ts";
import { downloadSession, LOGGER_STATES, readLogInfo, readLogSessions, sessionPages, sessionSeconds } from "../src/msp/logs.ts";
import { makeZip } from "../src/zip.ts";

const path = process.argv[2];
const mode = ["outputs", "lights", "log", "logs", "beeper"].includes(process.argv[3] ?? "") ? process.argv[3]! : "poll";
const seconds = Number(mode === "poll" ? (process.argv[3] ?? "3") : "0");
if (!path) {
  console.log("usage: npm run probe -- /dev/cu.usbmodemXXXX [seconds | outputs | lights | log | beeper | logs [n] [out.zip]]");
  process.exit(1);
}

// Non-blocking tty stream (libuv poll): a blocking threadpool read would keep the process from exiting
const fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
execFileSync("stty", [process.platform === "darwin" ? "-f" : "-F", path, "raw", "-echo", "clocal"]);
const stream = new ReadStream(fd);

let cliText = "";
const client = new MspClient(
  { write: (data) => new Promise((resolve, reject) => write(fd, data, (err) => (err ? reject(err) : resolve()))) },
  (t) => (cliText += t),
);
stream.on("data", (chunk) => client.receive(chunk as Buffer));

await new Promise((r) => setTimeout(r, 300)); // banner
const id = await readIdentity(client, API_MINOR_KNOWN);
console.log(`connected: ${id.variant} firmware ${id.firmware}, API ${id.api.major}.${id.api.minor}, ${id.board.boardName}, UID ${id.board.uid}, built ${id.build.date} ${id.build.time}`);

if (mode === "logs") {
  const info = await readLogInfo(client);
  console.log(`logger ${LOGGER_STATES[info.state]}, ${info.sessions} sessions, free ${info.freeBlocks} blocks, log switch CH${info.switchChannel}`);
  const sessions = await readLogSessions(client);
  for (const s of sessions) {
    console.log(`  session ${s.number}: ${sessionPages(s)} pages, ${sessionSeconds(s).toFixed(1)} s${s.closed ? "" : ", not closed"}`);
  }
  const wanted = process.argv[4] ? Number(process.argv[4]) : sessions.at(-1)?.number;
  const s = sessions.find((x) => x.number === wanted);
  if (!s) {
    console.log(`session ${wanted} not on the chip`);
    process.exit(1);
  }
  let last = 0;
  const r = await downloadSession(client, s, (p) => {
    if (performance.now() - last > 1000) {
      last = performance.now();
      console.log(`  ${p.done} / ${p.total} pages, ${(p.bytesPerS / 1024).toFixed(0)} KB/s`);
    }
  });
  console.log(`session ${s.number}: ${r.pages} pages in ${r.seconds.toFixed(1)} s = ${((r.pages * 2048) / 1024 / r.seconds).toFixed(0)} KB/s, not received ${r.missing}, read errors ${r.readErrors}`);
  const d = decodeSession(r.data);
  process.stdout.write(d.summary);
  const enc = new TextEncoder();
  const files = [{ name: `session_${s.number}/summary.txt`, data: enc.encode(d.summary) }];
  for (const [name, text] of d.csv) files.push({ name: `session_${s.number}/${name}.csv`, data: enc.encode(text) });
  const out = process.argv[5] ?? `/tmp/session_${s.number}.zip`;
  writeFileSync(out, makeZip(files));
  console.log(`zip: ${out}`);
  stream.destroy();
  process.exit(r.missing || r.readErrors ? 1 : 0);
}

if (mode === "outputs") {
  let ok = true;
  const check = (what: string, pass: boolean) => {
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${what}`);
  };
  const read = async () => decodeOutputs(await client.request(MSP.OUTPUTS));
  const original = await read();
  for (const [i, o] of original.outputs.entries()) {
    console.log(
      `  OUT${i + 1}: ${o.source ? `CH${o.source}` : "none"}${o.reverse ? " rev" : ""} ${o.minUs}/${o.centerUs}/${o.maxUs} us, loss ${FAILSAFE_NAMES[o.failsafe]}${o.failsafe === 1 ? ` ${o.failsafeUs}` : ""}`,
    );
  }
  console.log(`  rates ${original.ratesHz.join("/")} Hz, arm CH${original.armChannel}, ESC OUT${original.escOutput}`);
  check("board config passes the configurator's validation", validateOutputs(original).length === 0);
  try {
    await client.request(MSP.SET_OUTPUTS, encodeOutputs(original));
    check("write back unchanged accepted", sameOutputs(await read(), original));

    const out9 = original.outputs[8]!;
    if (out9.source === 0) {
      const changed = cloneOutputs(original);
      const o = changed.outputs[8]!;
      Object.assign(o, { reverse: !o.reverse, failsafe: (o.failsafe + 1) % 3, minUs: o.minUs - 1, centerUs: o.centerUs + 1, maxUs: o.maxUs + 1, failsafeUs: o.failsafeUs + 3 });
      await client.request(MSP.SET_OUTPUTS, encodeOutputs(changed));
      check("OUT9 (no source) edit written and read back", sameOutputs(await read(), changed));
    } else {
      console.log("skip OUT9 edit: OUT9 has a source");
    }

    const invalid = cloneOutputs(original);
    invalid.outputs[8]!.minUs = invalid.outputs[8]!.centerUs + 1;
    const before = await read();
    const code = await client.request(MSP.SET_OUTPUTS, encodeOutputs(invalid)).then(
      () => 0,
      (e: unknown) => (e instanceof MspErrorReply ? e.code : -1),
    );
    check(`invalid (OUT9 min > center) refused with error 3 (got ${code})`, code === 3);
    check("refused write left the board unchanged", sameOutputs(await read(), before));
  } finally {
    await client.request(MSP.SET_OUTPUTS, encodeOutputs(original));
    check("original restored", sameOutputs(await read(), original));
  }
  console.log(ok ? "outputs: all checks passed" : "outputs: FAILED");
  stream.destroy();
  process.exit(ok ? 0 : 1);
}

if (mode === "lights") {
  let ok = true;
  const check = (what: string, pass: boolean) => {
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${what}`);
  };
  const read = async () => decodeLights(await client.request(MSP.LIGHTS));
  const original = await read();
  original.functions.forEach((f, i) => console.log(`  LIGHT${i + 1}: ${functionNames(f)}`));
  original.modes.forEach((m, i) => console.log(`  mode ${i + 1}${i >= original.modeCount ? " (spare)" : ""}: ${functionNames(m)}`));
  console.log(
    `  mode channel ${original.modeChannel ? `CH${original.modeChannel}` : "none"}, ${original.modeCount} modes, steering ${original.steerChannel ? `CH${original.steerChannel}` : "none"}, ` +
      `flags 0x${original.flags.toString(16)}, turn > ${original.steerThresholdUs} us, dead band ${original.throttleDeadbandUs} us`,
  );
  check("board config passes the configurator's validation", validateLights(original).length === 0);
  try {
    await client.request(MSP.SET_LIGHTS, encodeLights(original));
    check("write back unchanged accepted", sameLights(await read(), original));

    if (original.modeCount < LIGHT_MODES) {
      const changed = cloneLights(original);
      changed.modes[LIGHT_MODES - 1] = FN.ROCK | FN.BAR | FN.LEFT;
      changed.steerThresholdUs = original.steerThresholdUs === 450 ? 449 : original.steerThresholdUs + 1;
      await client.request(MSP.SET_LIGHTS, encodeLights(changed));
      check(`spare mode ${LIGHT_MODES} + turn threshold edit written and read back`, sameLights(await read(), changed));
    } else {
      console.log("skip edit: all modes in use");
    }

    const invalid = cloneLights(original);
    invalid.modes[LIGHT_MODES - 1] = FN.BRAKE;
    const before = await read();
    const code = await client.request(MSP.SET_LIGHTS, encodeLights(invalid)).then(
      () => 0,
      (e: unknown) => (e instanceof MspErrorReply ? e.code : -1),
    );
    check(`invalid (brake in a mode) refused with error 3 (got ${code})`, code === 3);
    check("refused write left the board unchanged", sameLights(await read(), before));
  } finally {
    await client.request(MSP.SET_LIGHTS, encodeLights(original));
    check("original restored", sameLights(await read(), original));
  }
  console.log(ok ? "lights: all checks passed" : "lights: FAILED");
  stream.destroy();
  process.exit(ok ? 0 : 1);
}

if (mode === "log") {
  // Codec check only: nothing is saved, the original is written back
  let ok = true;
  const check = (what: string, pass: boolean) => {
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${what}`);
  };
  const read = async () => decodeLog(await client.request(MSP.LOG_CONFIG));
  const original = await read();
  console.log(`  log switch channel ${original.switchChannel ? `CH${original.switchChannel}` : "none"}`);
  check("board config passes the configurator's validation", validateLog(original).length === 0);
  try {
    await client.request(MSP.SET_LOG_CONFIG, encodeLog(original));
    check("write back unchanged accepted", sameLog(await read(), original));

    const invalid = cloneLog(original);
    invalid.switchChannel = 17;
    const before = await read();
    const code = await client.request(MSP.SET_LOG_CONFIG, encodeLog(invalid)).then(
      () => 0,
      (e: unknown) => (e instanceof MspErrorReply ? e.code : -1),
    );
    check(`invalid (channel 17) refused with error 3 (got ${code})`, code === 3);
    check("refused write left the board unchanged", sameLog(await read(), before));
  } finally {
    await client.request(MSP.SET_LOG_CONFIG, encodeLog(original));
    check("original restored", sameLog(await read(), original));
  }
  console.log(ok ? "log: all checks passed" : "log: FAILED");
  stream.destroy();
  process.exit(ok ? 0 : 1);
}

if (mode === "beeper") {
  // Codec check only: nothing is saved, the original is written back; only the delay is edited (no sound)
  let ok = true;
  const check = (what: string, pass: boolean) => {
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${what}`);
  };
  const read = async () => decodeBeeper(await client.request(MSP.BEEPER_CONFIG));
  const original = await read();
  console.log(
    `  switch ${original.switchChannel ? `CH${original.switchChannel}` : "none"}, flags 0x${original.flags.toString(16)}, delay ${original.lostDelayS} s`,
  );
  check("board config passes the configurator's validation", validateBeeper(original).length === 0);
  try {
    await client.request(MSP.SET_BEEPER_CONFIG, encodeBeeper(original));
    check("write back unchanged accepted", sameBeeper(await read(), original));

    const changed = cloneBeeper(original);
    changed.lostDelayS = original.lostDelayS === 3600 ? 3599 : original.lostDelayS + 1;
    await client.request(MSP.SET_BEEPER_CONFIG, encodeBeeper(changed));
    check(`delay ${changed.lostDelayS} s written and read back`, sameBeeper(await read(), changed));

    for (const [what, edit] of [
      ["channel 17", (c: typeof original) => (c.switchChannel = 17)],
      ["flag bit 2", (c: typeof original) => (c.flags |= 0x04)],
      ["delay 9 s", (c: typeof original) => (c.lostDelayS = 9)],
    ] as const) {
      const invalid = cloneBeeper(original);
      edit(invalid);
      const before = await read();
      const code = await client.request(MSP.SET_BEEPER_CONFIG, encodeBeeper(invalid)).then(
        () => 0,
        (e: unknown) => (e instanceof MspErrorReply ? e.code : -1),
      );
      check(`invalid (${what}) refused with error 3 (got ${code})`, code === 3);
      check("refused write left the board unchanged", sameBeeper(await read(), before));
    }
  } finally {
    await client.request(MSP.SET_BEEPER_CONFIG, encodeBeeper(original));
    check("original restored", sameBeeper(await read(), original));
  }
  console.log(ok ? "beeper: all checks passed" : "beeper: FAILED");
  stream.destroy();
  process.exit(ok ? 0 : 1);
}

const end = Date.now() + seconds * 1000;
let polls = 0;
let failed = 0;
const rtts: number[] = [];
let last = "";
while (Date.now() < end) {
  const t0 = performance.now();
  try {
    const [s, r, b, l] = client.requestMany([{ id: MSP.STATUS }, { id: MSP.RC }, { id: MSP.BATTERY }, { id: MSP.OUTPUTS_LIVE }]);
    const st = decodeStatus(await s!);
    const rc = decodeRc(await r!);
    const bat = decodeBattery(await b!);
    const live = decodeOutputsLive(await l!);
    rtts.push(performance.now() - t0);
    last =
      `${OUTPUT_STATES[st.outputState] ?? st.outputState} '${st.mode}', block [${armBlockNames(st.armBlock).join(", ")}], up ${(st.uptimeMs / 1000).toFixed(1)} s, load ${(st.loadPermille / 10).toFixed(1)} %\n` +
      `  link ${rc.linkActive ? "ACTIVE" : "lost"} LQ ${st.linkQuality} %, CH1-4 ${rc.channels.slice(0, 4).join(" ")}; battery ${bat.ready ? (bat.batteryMv / 1000).toFixed(2) + " V" : "-"}, MCU ${bat.temperatureC} C; pulses ${live.pulses.join(" ")}`;
  } catch (e) {
    failed++;
    console.log(`poll failed: ${(e as Error).message}`);
  }
  polls++;
  await new Promise((r) => setTimeout(r, Math.max(0, 100 - (performance.now() - t0))));
}
rtts.sort((a, b) => a - b);
console.log(last);
console.log(
  `${polls} polls (4 requests each) in ${seconds} s, ${failed} failed; round trip min ${rtts[0]?.toFixed(1)} / median ${rtts[rtts.length >> 1]?.toFixed(1)} / max ${rtts[rtts.length - 1]?.toFixed(1)} ms; ` +
    `client ${JSON.stringify(client.stats)}, parser ${JSON.stringify(client.parserCounters)}`,
);
console.log(`CLI text skipped: ${JSON.stringify(cliText.slice(0, 120))}`);
stream.destroy();
process.exit(0);
