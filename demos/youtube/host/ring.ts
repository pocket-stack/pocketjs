// demos/youtube/host/ring.ts — the .pkst STREAM container writer.
//
// Mac-side half of the spec.ts "STREAM container" contract (the PSP reader
// is native/src/vid.rs over core/src/stream.rs): one preallocated file, two
// fixed-slot rings, and the ordering rule that makes concurrent access safe
// over usbhostfs — a slot/chunk is fully written BEFORE the header block's
// latestSeq advances, so the device never gets told about bytes that are not
// there yet. The device double-checks each slot's embedded seq after reading
// it, which covers the one remaining race (a reader lapped mid-read).
//
// Also exports readStream() — a whole-file decoder used by tests and by the
// fixture generator (the committed golden that core's cargo tests parse).

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import {
  STREAM_ARING_MAGIC,
  STREAM_ARING_OFF,
  STREAM_CHUNK_HEADER_SIZE,
  STREAM_FLAG_ENDED,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_MAGIC,
  STREAM_SLOT_HEADER_SIZE,
  STREAM_VERSION,
  STREAM_VRING_MAGIC,
  STREAM_VRING_OFF,
  TEX_MAX_DIM,
} from "../../../spec/spec.ts";

export interface StreamGeometry {
  /** Plane dims — pow2 <= TEX_MAX_DIM (the plane texture IS the frame). */
  w: number;
  h: number;
  fpsNum: number;
  fpsDen: number;
  slotCount: number;
  sampleRate: number;
  channels: 1 | 2;
  chunkFrames: number;
  chunkCount: number;
  /** Source length in frames (0 = unknown/live). */
  totalFrames: number;
}

const align16 = (n: number): number => (n + 15) & ~15;
const pow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

export const slotSizeOf = (g: StreamGeometry): number =>
  align16(STREAM_SLOT_HEADER_SIZE + 1024 + g.w * g.h);
export const chunkSizeOf = (g: StreamGeometry): number =>
  STREAM_CHUNK_HEADER_SIZE + g.chunkFrames * g.channels * 2;

export class StreamWriter {
  readonly geo: StreamGeometry;
  readonly slotSize: number;
  readonly chunkSize: number;
  readonly videoOff = STREAM_HEADER_BLOCK_SIZE;
  readonly audioOff: number;
  private fd: number;
  private epoch = 0;
  private videoSeq = 0;
  private audioSeq = 0;
  private ended = false;

  constructor(path: string, geo: StreamGeometry) {
    if (!pow2(geo.w) || !pow2(geo.h) || geo.w > TEX_MAX_DIM || geo.h > TEX_MAX_DIM) {
      throw new Error(`pkst: plane dims must be pow2 <= ${TEX_MAX_DIM}, got ${geo.w}x${geo.h}`);
    }
    if (geo.slotCount < 2 || geo.chunkCount < 2) {
      throw new Error("pkst: rings need >= 2 entries (single-slot rings tear constantly)");
    }
    this.geo = geo;
    this.slotSize = slotSizeOf(geo);
    this.chunkSize = chunkSizeOf(geo);
    this.audioOff = this.videoOff + geo.slotCount * this.slotSize;
    const total = this.audioOff + geo.chunkCount * this.chunkSize;
    this.fd = openSync(path, "w+");
    // Preallocate the whole ring: the device treats short reads as transport
    // errors (ring semantics need every slot offset to exist from t0).
    writeSync(this.fd, new Uint8Array(total), 0, total, 0);
    this.writeHeaders();
  }

  private writeHeaders(): void {
    const b = new Uint8Array(STREAM_HEADER_BLOCK_SIZE);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, STREAM_MAGIC, true);
    dv.setUint16(4, STREAM_VERSION, true);
    dv.setUint16(6, this.ended ? STREAM_FLAG_ENDED : 0, true);
    dv.setUint32(8, this.epoch, true);
    dv.setUint32(12, this.videoOff, true);
    dv.setUint32(16, this.audioOff, true);
    const g = this.geo;
    dv.setUint32(STREAM_VRING_OFF, STREAM_VRING_MAGIC, true);
    dv.setUint16(STREAM_VRING_OFF + 4, g.w, true);
    dv.setUint16(STREAM_VRING_OFF + 6, g.h, true);
    dv.setUint16(STREAM_VRING_OFF + 8, g.fpsNum, true);
    dv.setUint16(STREAM_VRING_OFF + 10, g.fpsDen, true);
    dv.setUint32(STREAM_VRING_OFF + 12, g.slotCount, true);
    dv.setUint32(STREAM_VRING_OFF + 16, this.slotSize, true);
    dv.setUint32(STREAM_VRING_OFF + 20, this.videoSeq, true);
    dv.setUint32(STREAM_VRING_OFF + 24, g.totalFrames, true);
    dv.setUint32(STREAM_ARING_OFF, STREAM_ARING_MAGIC, true);
    dv.setUint32(STREAM_ARING_OFF + 4, g.sampleRate, true);
    dv.setUint16(STREAM_ARING_OFF + 8, g.channels, true);
    dv.setUint32(STREAM_ARING_OFF + 12, g.chunkFrames, true);
    dv.setUint32(STREAM_ARING_OFF + 16, g.chunkCount, true);
    dv.setUint32(STREAM_ARING_OFF + 20, this.audioSeq, true);
    writeSync(this.fd, b, 0, b.length, 0);
  }

  private patchU32(off: number, value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, true);
    writeSync(this.fd, b, 0, 4, off);
  }

  /** Write one frame (1024-byte CLUT + w*h indices), then publish its seq. */
  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): number {
    const g = this.geo;
    if (palette.length !== 1024 || indices.length !== g.w * g.h) {
      throw new Error("pkst: frame payload size mismatch");
    }
    const seq = ++this.videoSeq;
    const slot = new Uint8Array(this.slotSize);
    const dv = new DataView(slot.buffer);
    dv.setUint32(0, seq, true);
    dv.setUint32(4, frameIndex, true);
    dv.setUint16(8, g.w, true);
    dv.setUint16(10, g.h, true);
    slot.set(palette, STREAM_SLOT_HEADER_SIZE);
    slot.set(indices, STREAM_SLOT_HEADER_SIZE + 1024);
    const off = this.videoOff + ((seq - 1) % g.slotCount) * this.slotSize;
    writeSync(this.fd, slot, 0, slot.length, off);
    this.patchU32(STREAM_VRING_OFF + 20, seq); // publish AFTER the payload
    return seq;
  }

  /** Write one whole PCM chunk (exactly chunkFrames*channels samples). */
  writeAudio(startFrame: number, pcm: Int16Array): number {
    const g = this.geo;
    if (pcm.length !== g.chunkFrames * g.channels) {
      throw new Error(`pkst: chunk needs ${g.chunkFrames * g.channels} samples, got ${pcm.length}`);
    }
    const seq = ++this.audioSeq;
    const chunk = new Uint8Array(this.chunkSize);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, seq, true);
    dv.setUint32(4, startFrame, true);
    chunk.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), STREAM_CHUNK_HEADER_SIZE);
    const off = this.audioOff + ((seq - 1) % g.chunkCount) * this.chunkSize;
    writeSync(this.fd, chunk, 0, chunk.length, off);
    this.patchU32(STREAM_ARING_OFF + 20, seq); // publish AFTER the payload
    return seq;
  }

  /** Discontinuity (seek): the device drops its positions and re-syncs. */
  bumpEpoch(): void {
    this.epoch++;
    this.patchU32(8, this.epoch);
  }

  /** Source exhausted — latestSeq values are final. */
  markEnded(): void {
    this.ended = true;
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, STREAM_FLAG_ENDED, true);
    writeSync(this.fd, b, 0, 2, 6);
  }

  close(): void {
    closeSync(this.fd);
  }
}

// ---------------------------------------------------------------------------
// Test/fixture-side reader (the device-side reader is core/src/stream.rs)
// ---------------------------------------------------------------------------

export interface DecodedStream {
  epoch: number;
  ended: boolean;
  geo: StreamGeometry;
  slotSize: number;
  videoOff: number;
  audioOff: number;
  videoLatest: number;
  audioLatest: number;
  frames: { seq: number; frameIndex: number; palette: Uint8Array; indices: Uint8Array }[];
  chunks: { seq: number; startFrame: number; pcm: Int16Array }[];
}

/** Decode a whole .pkst file (newest ring lap only), validating layout. */
export function readStream(path: string): DecodedStream {
  const fd = openSync(path, "r");
  const head = new Uint8Array(STREAM_HEADER_BLOCK_SIZE);
  readSync(fd, head, 0, head.length, 0);
  const dv = new DataView(head.buffer);
  if (dv.getUint32(0, true) !== STREAM_MAGIC) throw new Error("pkst: bad magic");
  if (dv.getUint16(4, true) !== STREAM_VERSION) throw new Error("pkst: bad version");
  if (dv.getUint32(STREAM_VRING_OFF, true) !== STREAM_VRING_MAGIC) {
    throw new Error("pkst: bad vring magic");
  }
  if (dv.getUint32(STREAM_ARING_OFF, true) !== STREAM_ARING_MAGIC) {
    throw new Error("pkst: bad aring magic");
  }
  const geo: StreamGeometry = {
    w: dv.getUint16(STREAM_VRING_OFF + 4, true),
    h: dv.getUint16(STREAM_VRING_OFF + 6, true),
    fpsNum: dv.getUint16(STREAM_VRING_OFF + 8, true),
    fpsDen: dv.getUint16(STREAM_VRING_OFF + 10, true),
    slotCount: dv.getUint32(STREAM_VRING_OFF + 12, true),
    totalFrames: dv.getUint32(STREAM_VRING_OFF + 24, true),
    sampleRate: dv.getUint32(STREAM_ARING_OFF + 4, true),
    channels: dv.getUint16(STREAM_ARING_OFF + 8, true) as 1 | 2,
    chunkFrames: dv.getUint32(STREAM_ARING_OFF + 12, true),
    chunkCount: dv.getUint32(STREAM_ARING_OFF + 16, true),
  };
  const slotSize = dv.getUint32(STREAM_VRING_OFF + 16, true);
  const out: DecodedStream = {
    epoch: dv.getUint32(8, true),
    ended: (dv.getUint16(6, true) & STREAM_FLAG_ENDED) !== 0,
    geo,
    slotSize,
    videoOff: dv.getUint32(12, true),
    audioOff: dv.getUint32(16, true),
    videoLatest: dv.getUint32(STREAM_VRING_OFF + 20, true),
    audioLatest: dv.getUint32(STREAM_ARING_OFF + 20, true),
    frames: [],
    chunks: [],
  };
  const px = geo.w * geo.h;
  const firstSeq = Math.max(1, out.videoLatest - geo.slotCount + 1);
  for (let seq = firstSeq; seq <= out.videoLatest; seq++) {
    const slot = new Uint8Array(slotSize);
    readSync(fd, slot, 0, slotSize, out.videoOff + ((seq - 1) % geo.slotCount) * slotSize);
    const sdv = new DataView(slot.buffer);
    if (sdv.getUint32(0, true) !== seq) continue; // lapped while reading
    out.frames.push({
      seq,
      frameIndex: sdv.getUint32(4, true),
      palette: slot.slice(STREAM_SLOT_HEADER_SIZE, STREAM_SLOT_HEADER_SIZE + 1024),
      indices: slot.slice(STREAM_SLOT_HEADER_SIZE + 1024, STREAM_SLOT_HEADER_SIZE + 1024 + px),
    });
  }
  const chunkSize = chunkSizeOf(geo);
  const firstChunk = Math.max(1, out.audioLatest - geo.chunkCount + 1);
  for (let seq = firstChunk; seq <= out.audioLatest; seq++) {
    const chunk = new Uint8Array(chunkSize);
    readSync(fd, chunk, 0, chunkSize, out.audioOff + ((seq - 1) % geo.chunkCount) * chunkSize);
    const cdv = new DataView(chunk.buffer);
    if (cdv.getUint32(0, true) !== seq) continue;
    out.chunks.push({
      seq,
      startFrame: cdv.getUint32(4, true),
      pcm: new Int16Array(chunk.buffer, STREAM_CHUNK_HEADER_SIZE, geo.chunkFrames * geo.channels),
    });
  }
  closeSync(fd);
  return out;
}
