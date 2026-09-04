// contracts/spec/svc-wire.ts — the host side of the SVC WIRE (PKNT) protocol
// as pure functions: frame encode/decode, the device hello and its ack, and
// the discovery beacon. Byte layouts are the "SVC WIRE protocol" section of
// spec.ts and must stay bit-identical to engine/core/src/wire.rs and
// hosts/3ds/src/svcwire.c. Sockets live with whoever owns them
// (tools/companion-serve.ts); nothing here touches one.

import {
  WIRE_BEACON_MAGIC,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MAX_PAYLOAD,
  WIRE_MSG,
  WIRE_VERSION,
} from "./spec.ts";

export { WIRE_BEACON_PORT, WIRE_MSG, WIRE_PORT } from "./spec.ts";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export interface WireFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > WIRE_MAX_PAYLOAD) {
    throw new Error(`svc-wire: frame payload ${payload.length} exceeds WIRE_MAX_PAYLOAD`);
  }
  const frame = new Uint8Array(WIRE_HEADER_SIZE + payload.length);
  frame[0] = type;
  frame[1] = 0;
  new DataView(frame.buffer).setUint32(4, payload.length, true);
  frame.set(payload, WIRE_HEADER_SIZE);
  return frame;
}

/** One ctrl frame carrying newline-terminated JSON lines. */
export function encodeCtrl(text: string): Uint8Array {
  return encodeFrame(WIRE_MSG.ctrl, utf8.encode(text));
}

/** The once-a-second discovery datagram. A device connects to the SOURCE
 *  address of the datagram at the advertised TCP port, and only when the
 *  app id matches the one it passed to svcOpen. */
export function encodeBeacon(app: string, name: string, tcpPort: number): Uint8Array {
  const appBytes = utf8.encode(app);
  const nameBytes = utf8.encode(name).slice(0, 32);
  if (appBytes.length === 0 || appBytes.length > 64) throw new Error("svc-wire: bad beacon app id");
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

export interface WireBeacon {
  readonly app: string;
  readonly name: string;
  readonly tcpPort: number;
}

/** Decode a beacon datagram, or null when it is not one. */
export function parseBeacon(datagram: Uint8Array): WireBeacon | null {
  if (datagram.length < 10) return null;
  const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength);
  if (view.getUint32(0, true) !== WIRE_BEACON_MAGIC || datagram[4] !== WIRE_VERSION) return null;
  const tcpPort = view.getUint16(6, true);
  const appLength = datagram[8]!;
  if (appLength === 0 || 10 + appLength > datagram.length) return null;
  const nameLength = datagram[9 + appLength]!;
  if (10 + appLength + nameLength > datagram.length) return null;
  return {
    app: utf8d.decode(datagram.subarray(9, 9 + appLength)),
    name: utf8d.decode(datagram.subarray(10 + appLength, 10 + appLength + nameLength)),
    tcpPort,
  };
}

/** The device's opening bytes. Returns the app id, or null while the buffer
 *  is still short of a whole hello; throws on a malformed one. */
export function parseHello(buffer: Uint8Array): { app: string; consumed: number } | null {
  if (buffer.length < 7) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) throw new Error("svc-wire: bad hello magic");
  if (buffer[4] !== WIRE_VERSION) throw new Error(`svc-wire: unsupported wire version ${buffer[4]}`);
  const appLength = buffer[6]!;
  if (appLength === 0 || appLength > 64) throw new Error("svc-wire: bad hello app length");
  if (buffer.length < 7 + appLength) return null;
  return { app: utf8d.decode(buffer.subarray(7, 7 + appLength)), consumed: 7 + appLength };
}

export function encodeHelloAck(): Uint8Array {
  const ack = new Uint8Array(8);
  new DataView(ack.buffer).setUint32(0, WIRE_MAGIC, true);
  ack[4] = WIRE_VERSION;
  return ack;
}

/** Incremental frame reassembly over a byte stream. */
export class FrameParser {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): WireFrame[] {
    if (this.buffer.length === 0) this.buffer = chunk;
    else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    const frames: WireFrame[] = [];
    for (;;) {
      if (this.buffer.length < WIRE_HEADER_SIZE) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const length = view.getUint32(4, true);
      if (this.buffer[2] !== 0 || this.buffer[3] !== 0 || length > WIRE_MAX_PAYLOAD) {
        throw new Error("svc-wire: bad frame header");
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
