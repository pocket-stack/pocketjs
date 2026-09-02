// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/host/wire.ts — the host side of the SVC WIRE (PKNT)
// protocol: framing, the device hello, the discovery beacon. Byte layouts
// come from contracts/spec/spec.ts "SVC WIRE protocol" and must stay
// bit-identical to engine/core/src/wire.rs and hosts/iphone2g/svcwire.c.
//
// The constants are repeated here rather than imported so the daemon can be
// copied to the Omarchy machine as one small directory with no repository
// around it; tests/pocket-remote.test.ts pins them to spec.ts.

export const WIRE_MAGIC = 0x544e4b50; // 'PKNT' LE
export const WIRE_BEACON_MAGIC = 0x42444b50; // 'PKDB' LE
export const WIRE_VERSION = 1;
export const WIRE_HEADER_SIZE = 8;
export const WIRE_MAX_PAYLOAD = 256 * 1024;
export const WIRE_BEACON_PORT = 8621;
export const WIRE_PORT = 8622;
export const WIRE_MSG = { ping: 0x01, pong: 0x02, ctrl: 0x10 } as const;
/** One ctrl line may not exceed this (spec SVC_POLL_BUF). */
export const SVC_POLL_BUF = 8192;

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > WIRE_MAX_PAYLOAD) {
    throw new Error(`frame payload ${payload.length} exceeds WIRE_MAX_PAYLOAD`);
  }
  const frame = new Uint8Array(WIRE_HEADER_SIZE + payload.length);
  frame[0] = type;
  frame[1] = 0;
  new DataView(frame.buffer).setUint32(4, payload.length, true);
  frame.set(payload, WIRE_HEADER_SIZE);
  return frame;
}

export function encodeCtrl(line: string): Uint8Array {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length > SVC_POLL_BUF) throw new Error(`ctrl line ${bytes.length} bytes exceeds SVC_POLL_BUF`);
  return encodeFrame(WIRE_MSG.ctrl, bytes);
}

/** Once-a-second discovery datagram; the device connects to the SOURCE
 *  address of the datagram at the advertised TCP port. */
export function encodeBeacon(app: string, name: string, tcpPort: number): Uint8Array {
  const appBytes = new TextEncoder().encode(app);
  const nameBytes = new TextEncoder().encode(name).slice(0, 32);
  const datagram = new Uint8Array(8 + 1 + appBytes.length + 1 + nameBytes.length);
  const view = new DataView(datagram.buffer);
  view.setUint32(0, WIRE_BEACON_MAGIC, true);
  datagram[4] = WIRE_VERSION;
  datagram[5] = 0;
  view.setUint16(6, tcpPort, true);
  datagram[8] = appBytes.length;
  datagram.set(appBytes, 9);
  datagram[9 + appBytes.length] = nameBytes.length;
  datagram.set(nameBytes, 10 + appBytes.length);
  return datagram;
}

/** The device's opening handshake. Returns the app id, or null while the
 *  buffer is still short of a full hello; throws on a malformed one. */
export function parseHello(buffer: Uint8Array): { app: string; consumed: number } | null {
  if (buffer.length < 7) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) throw new Error("bad hello magic");
  if (buffer[4] !== WIRE_VERSION) throw new Error(`unsupported wire version ${buffer[4]}`);
  const appLength = buffer[6]!;
  if (appLength === 0 || appLength > 64) throw new Error("bad hello app length");
  if (buffer.length < 7 + appLength) return null;
  const app = new TextDecoder().decode(buffer.subarray(7, 7 + appLength));
  return { app, consumed: 7 + appLength };
}

export function encodeHelloAck(): Uint8Array {
  const ack = new Uint8Array(8);
  new DataView(ack.buffer).setUint32(0, WIRE_MAGIC, true);
  ack[4] = WIRE_VERSION;
  return ack;
}

export interface Frame {
  type: number;
  payload: Uint8Array;
}

/** Incremental frame reassembly over a byte stream. */
export class FrameParser {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffer.length < WIRE_HEADER_SIZE) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
      const length = view.getUint32(4, true);
      if (this.buffer[2] !== 0 || this.buffer[3] !== 0 || length > WIRE_MAX_PAYLOAD) {
        throw new Error("bad frame header");
      }
      if (this.buffer.length < WIRE_HEADER_SIZE + length) break;
      frames.push({
        type: this.buffer[0]!,
        payload: this.buffer.slice(WIRE_HEADER_SIZE, WIRE_HEADER_SIZE + length),
      });
      this.buffer = this.buffer.slice(WIRE_HEADER_SIZE + length);
    }
    return frames;
  }
}
