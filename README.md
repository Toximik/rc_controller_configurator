# RC_Controller configurator

Author: Toximik. Web configurator for the RC_Controller board: MSP v2 over Web Serial on the board's USB CDC
port (shared with the text CLI). Protocol, message set and decisions: firmware repo
`../rc_controller_firmware/Docs/PHASE2_MSP_PLAN.md`.

Status (2026-11-01, plan step 4): **connect + status**. Outputs and lights pages follow (step 5).

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

## Commands

| Command | |
|---|---|
| `npm run dev` | Dev server (localhost) |
| `npm run build` | Typecheck + production build into `dist/` (relative paths, GitHub Pages ready) |
| `npm test` | Unit tests (Vitest): codec with the firmware's frame vectors, payload decoders, client, connect handshake |
| `npm run probe -- /dev/cu.usbmodem1101 [s]` | Same MSP client from Node against the board (handshake + status poll), no browser |

## Structure

| Path | |
|---|---|
| `src/msp/codec.ts` | CRC-8 DVB-S2, v2 encoder, stream parser (skips CLI text), LE reader – twin of `AppMsp/MspCodec` |
| `src/msp/protocol.ts` | IDs, error codes, expected identity – mirrors `MspProtocol.hpp` |
| `src/msp/payloads.ts` | Identity and live data decoders – layouts from `MspPayload.hpp` |
| `src/msp/client.ts` | Request / reply matching, batching, timeouts (transport independent) |
| `src/msp/identity.ts` | Connect handshake + compatibility check |
| `src/serial.ts` | Web Serial transport (DTR on, read loop, loss detection) |
| `src/ui/status.ts`, `src/main.ts` | Status page, app / connection state |

Rules as in the firmware repo: new files `\author Toximik`, git identity `Toximik <info@tmcm.cz>`, no
`Co-Authored-By`. Payload layouts change in the firmware first (host tests), then here with the same vectors.
