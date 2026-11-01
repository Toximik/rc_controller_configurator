# RC_Controller configurator

Author: Toximik. Web configurator for the RC_Controller board: MSP v2 over Web Serial on the board's USB CDC
port (shared with the text CLI). Protocol, message set and decisions: firmware repo
`../rc_controller_firmware/Docs/PHASE2_MSP_PLAN.md`.

Status (2026-11-01, plan step 5): **connect, status, outputs, lights and logger pages; log download** (firmware
API 1.3).

## Use

Chrome or Edge (desktop) – Web Serial needs a secure context (`http://localhost` or HTTPS).

```sh
nvm use            # Node 24 (.nvmrc); Vite needs >= 22.12
npm install
npm run dev        # http://localhost:5173
```

Connect → pick the port "MAIN V1_0" (the picker filters VID 0xCAFE / PID 0x4002; tick *all ports* to see every
port). The port must not be open in `Tools/cli.py` / `screen` at the same time.

On connect the configurator checks the firmware variant (`RCCT`) and the API major (1); a newer API minor
works (only appended fields / new messages). Then STATUS, RC, BATTERY and OUTPUTS_LIVE are polled together at
10 Hz (one write, answered in one firmware task run). After a reboot or replug it reconnects by itself.

Pages are tabs (URL hash `#status`, `#outputs`, `#lights`, `#log`). **Reboot** (top bar, while connected) sends `REBOOT` after a
confirmation (warns about written but unsaved values); the board refuses it while armed (button disabled) or
saving, resets ~50 ms after the reply and the page reconnects by itself.

**Logger:** the log switch channel (`LOG_CONFIG` area) and **Logs on the board**: logger state, free space, the
sessions (newest first) with **CSV .zip** (decoded in the browser: `session_<n>/imu.csv`, `rc.csv`, `outputs.csv`,
`status.csv`, `event.csv`, `session.csv`, `summary.txt` – identical to `Tools/log.py download`) or **.bin** (raw NAND
pages for `Tools/log.py decode`); ~1 MB/s, a 10 min session in ~22 s. Start / stop logging, erase all (confirmation).
The board refuses download, erase, start and stop while armed; download and erase also while a session is written.

**Outputs:** the whole `OUTPUTS_CONFIG` area – per output source channel, reverse, min / center / max, RC loss
behaviour (hold / fixed value / no pulses); arm switch channel, ESC output, frame rate per timer. Edits are
checked with the firmware's rules (`OutputConfig.hpp` `isValid()`) before *Write* is enabled; changed fields are
marked, problems listed. *Write* = `SET_OUTPUTS` (active on the board at once – disarmed, the servos follow the
sticks with the new values), then read back. *Save* = `SAVE` (all areas), result from the STATUS poll. Everything
is disabled while the board is armed (the board refuses writes then anyway). Edits survive a reconnect; values
written but lost by a reboot before *Save* come back as edits. Leaving the page with edits or unsaved values
asks first.

**Lights:** the whole `LIGHTS_CONFIG` area with the same editor (Write / Save / lock / reconnect behaviour, rules =
`LightConfig.hpp` `isValid()`): functions per output LIGHT1..8 (day, head, bar, tail, rock, brake, reverse, left,
right), user defined modes 1..6 (steady functions; left + right = hazard; modes beyond "modes in use" are spare),
mode input (channel, switch or momentary button, double press = hazard), steering channel / reverse / turn signal
threshold, throttle reverse / direct reverse / dead band. Live: light on/off, current mode, mode and steering
channel values, drive state, hazard, bench test notice. *Save* stores all areas, so a save from either page also
clears the "written, not saved" state of the other.

## Commands

| Command | |
|---|---|
| `npm run dev` | Dev server (localhost) |
| `npm run build` | Typecheck + production build into `dist/` (relative paths, GitHub Pages ready) |
| `npm test` | Unit tests (Vitest): codec with the firmware's frame vectors, payload decoders, outputs + lights areas + validation, client, connect handshake |
| `npm run probe -- /dev/cu.usbmodem1101 [s]` | Same MSP client from Node against the board (handshake + status poll), no browser |
| `npm run probe -- /dev/cu.usbmodem1101 outputs` | Outputs area through the configurator's codec: read, write back, OUT9 edit (only without a source – nothing moves), invalid write refused, original restored; nothing saved |
| `npm run probe -- /dev/cu.usbmodem1101 logs [n] [out.zip]` | Logger info + sessions, downloads session n (default the last) through the configurator's download + decoder, writes the CSV zip (default `/tmp/session_<n>.zip`); read only |
| `npm run probe -- /dev/cu.usbmodem1101 lights` | Lights area the same way: edit of a spare mode + the turn signal threshold, brake in a mode refused; nothing saved |

## Structure

| Path | |
|---|---|
| `src/msp/codec.ts` | CRC-8 DVB-S2, v2 encoder, stream parser (skips CLI text), LE reader / writer – twin of `AppMsp/MspCodec` |
| `src/msp/outputs.ts` | Outputs area: model, decoder / encoder (version 1, 112 B), validation = `OutputConfig.hpp` |
| `src/msp/lights.ts` | Lights area: model, decoder / encoder (version 2, 37 B), validation = `LightConfig.hpp` |
| `src/msp/protocol.ts` | IDs, error codes, expected identity – mirrors `MspProtocol.hpp` |
| `src/msp/payloads.ts` | Identity and live data decoders – layouts from `MspPayload.hpp` |
| `src/msp/client.ts` | Request / reply matching, batching, timeouts (transport independent) |
| `src/msp/identity.ts` | Connect handshake + compatibility check |
| `src/serial.ts` | Web Serial transport (DTR on, read loop, loss detection) |
| `src/ui/area.ts` | Settings area editor (read / edit / validate / write / save, lock while armed) + shared save tracker |
| `src/msp/logs.ts` | Logger messages (LOG_INFO / LIST / READ / ERASE / CONTROL), session download (8 requests in flight, retries) |
| `src/msp/logformat.ts` | Log page decoder → CSV per record type + summary – twin of the firmware's `Tools/log.py decode` (same text) |
| `src/zip.ts` | Minimal ZIP writer (stored) for the CSV download |
| `src/ui/status.ts`, `src/ui/outputs.ts`, `src/ui/lights.ts`, `src/ui/log.ts`, `src/ui/logs.ts`, `src/main.ts` | Status, outputs, lights and logger pages (logger: log switch + logs on the board), app / connection state, tabs |

Rules as in the firmware repo: new files `\author Toximik`, git identity `Toximik <info@tmcm.cz>`, no
`Co-Authored-By`. Payload layouts change in the firmware first (host tests), then here with the same vectors.
