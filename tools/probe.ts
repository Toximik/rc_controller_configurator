/**
 * \author Toximik
 * \file probe.ts
 * \brief Runs the configurator's MSP client (connect handshake + status poll)
 *        against the board from Node, without a browser (macOS / Linux tty).
 *
 * usage: npm run probe -- /dev/cu.usbmodem1101 [seconds]
 */

import { execFileSync } from "node:child_process";
import { constants, openSync, write } from "node:fs";
import { ReadStream } from "node:tty";
import { MspClient } from "../src/msp/client.ts";
import { readIdentity } from "../src/msp/identity.ts";
import { armBlockNames, decodeBattery, decodeOutputsLive, decodeRc, decodeStatus, OUTPUT_STATES } from "../src/msp/payloads.ts";
import { API_MINOR_KNOWN, MSP } from "../src/msp/protocol.ts";

const path = process.argv[2];
const seconds = Number(process.argv[3] ?? "3");
if (!path) {
  console.log("usage: npm run probe -- /dev/cu.usbmodemXXXX [seconds]");
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
