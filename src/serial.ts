/**
 * \author Toximik
 * \file serial.ts
 * \brief Web Serial transport for the board's USB CDC port (Chrome / Edge,
 *        secure context: localhost or HTTPS).
 *
 * DTR is asserted like Tools/cli.py: the firmware sends its CLI banner then,
 * the MSP client skips it as text.
 */

import type { MspTransport } from "./msp/client.ts";

/** Board USB CDC "MAIN V1_0" (VID 0xCAFE, PID 0x4002, as enumerated 2026-11-01) – only a picker filter,
 *  "show all ports" bypasses it */
const USB_FILTERS: SerialPortFilter[] = [{ usbVendorId: 0xcafe, usbProductId: 0x4002 }];

export function webSerialSupported(): boolean {
  return "serial" in navigator;
}

export class SerialLink implements MspTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private closing = false;

  private constructor(
    readonly port: SerialPort,
    private readonly onData: (chunk: Uint8Array) => void,
    private readonly onLost: (reason: string) => void,
  ) {}

  /** Port picker (needs a user gesture); showAll = no USB filter */
  static async pick(showAll: boolean): Promise<SerialPort> {
    return navigator.serial.requestPort(showAll ? {} : { filters: USB_FILTERS });
  }

  static async open(port: SerialPort, onData: (chunk: Uint8Array) => void, onLost: (reason: string) => void): Promise<SerialLink> {
    await port.open({ baudRate: 115200, bufferSize: 4096 }); // CDC: the baud rate is ignored by the board
    const link = new SerialLink(port, onData, onLost);
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      link.writer = port.writable!.getWriter();
      link.readLoop = link.read();
    } catch (error) {
      await port.close().catch(() => {});
      throw error;
    }
    return link;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) {
      throw new Error("port closed");
    }
    await this.writer.write(data);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.reader?.cancel().catch(() => {});
    await this.readLoop?.catch(() => {});
    this.writer?.releaseLock();
    this.writer = null;
    await this.port.close().catch(() => {});
  }

  private async read(): Promise<void> {
    let reason = "port closed";
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this.onData(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (!this.closing) {
      this.onLost(reason); // unplugged or board reset
    }
  }
}
