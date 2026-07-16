// demos/youtube/host/media.ts — the play pipeline: YouTube -> .pkst rings.
//
// Two ffmpeg processes per session, both pulling the SAME progressive URL
// (yt.resolve gives one muxed 360p stream; pulling it twice is simpler and
// sturdier than demuxing one pipe, and YouTube serves ranges statelessly):
//
//   video: -re -ss S -i URL -vf fps/scale/pad -> rawvideo rgb24 pipe
//          -> quantize (CLUT8 + dither) -> StreamWriter.writeFrame
//   audio: -re -ss S -i URL -> s16le 22.05 kHz stereo pipe
//          -> exact chunkFrames chunks -> StreamWriter.writeAudio
//
// `-re` paces both pipes at source rate, so "the writer writes in real time"
// falls out of ffmpeg and the device's latest-seq chase IS the play clock.
// pause = SIGSTOP (the pipes stall, rings freeze), resume = SIGCONT,
// seek = kill + respawn at the new offset + epoch bump (the device drops its
// ring positions and re-syncs to the tail).
//
// The plane is 256x128 (pow2, spec requirement) PRE-SQUASHED for the PSP's
// 480x272 stretch: content letterboxed for the final screen aspect, not the
// texture's own 2:1 — see planeBox().

import { unlinkSync } from "node:fs";
import type { StreamGeometry } from "./ring.ts";
import { StreamWriter } from "./ring.ts";
import { quantize, paletteBytes } from "./quant.ts";
import type { ResolvedStream } from "./yt.ts";

export const PLANE_W = 256;
export const PLANE_H = 128;
export const FPS = 15;
export const SAMPLE_RATE = 22050;
export const CHUNK_FRAMES = 2048;

export const GEOMETRY: Omit<StreamGeometry, "totalFrames"> = {
  w: PLANE_W,
  h: PLANE_H,
  fpsNum: FPS,
  fpsDen: 1,
  slotCount: 8,
  sampleRate: SAMPLE_RATE,
  channels: 2,
  chunkFrames: CHUNK_FRAMES,
  chunkCount: 64,
};

/**
 * Content box inside the plane for a source aspect ratio: the plane is
 * stretched to the full 480x272 screen, so the box must letterbox in SCREEN
 * space and then map back into plane texels (x: *256/480, y: *128/272).
 * For 16:9 that lands at 256x127 — half-pixel bars, effectively full plane.
 */
export function planeBox(srcW: number, srcH: number): { w: number; h: number } {
  const screenW = 480;
  const screenH = 272;
  const fit = Math.min(screenW / srcW, screenH / srcH);
  const w = Math.round(((srcW * fit) / screenW) * PLANE_W);
  const h = Math.round(((srcH * fit) / screenH) * PLANE_H);
  return { w: Math.min(PLANE_W, Math.max(16, w & ~1)), h: Math.min(PLANE_H, Math.max(16, h & ~1)) };
}

export interface SessionEvents {
  /** Pipeline ended (source exhausted or killed) — informational. */
  onEnd?: (reason: string) => void;
}

export class PlaySession {
  readonly stream: ResolvedStream;
  readonly file: string;
  /** svc-relative path the app passes to videoOpen. */
  readonly relPath: string;
  private writer: StreamWriter;
  private video: Bun.Subprocess | null = null;
  private audio: Bun.Subprocess | null = null;
  private baseFrame = 0;
  private baseSample = 0;
  /** Newest video frame index written to the ring (the host's play clock). */
  private framesWritten = 0;
  private paused = false;
  private closed = false;
  private events: SessionEvents;

  constructor(stream: ResolvedStream, svcDir: string, relPath: string, events: SessionEvents = {}) {
    this.stream = stream;
    this.relPath = relPath;
    this.file = `${svcDir}/${relPath}`;
    this.events = events;
    this.writer = new StreamWriter(this.file, {
      ...GEOMETRY,
      totalFrames: Math.max(0, Math.round(stream.durationS * FPS)),
    });
    this.spawnAt(0);
  }

  get positionBase(): number {
    return this.baseFrame / FPS;
  }

  private spawnAt(seconds: number): void {
    this.baseFrame = Math.round(seconds * FPS);
    this.baseSample = Math.round(seconds * SAMPLE_RATE);
    const seek = seconds > 0 ? ["-ss", seconds.toFixed(2)] : [];
    this.video = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        ...seek,
        "-i",
        this.stream.url,
        "-vf",
        `fps=${FPS},scale=${PLANE_W}:${PLANE_H}:force_original_aspect_ratio=decrease:flags=bilinear,pad=${PLANE_W}:${PLANE_H}:(ow-iw)/2:(oh-ih)/2:black`,
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    this.audio = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        ...seek,
        "-i",
        this.stream.url,
        "-vn",
        "-ac",
        "2",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    void this.pumpVideo(this.video, this.baseFrame);
    void this.pumpAudio(this.audio, this.baseSample);
  }

  /** NOTE on the pre-squash: ffmpeg letterboxes into the 256x128 texture
   *  box directly. That box stretches to 480x272 (1.875x, 2.125x) — for a
   *  16:9 source the error vs. a true screen-space letterbox is <1% (see
   *  planeBox); acceptable against a second scale pass. */
  private async pumpVideo(proc: Bun.Subprocess, baseFrame: number): Promise<void> {
    const frameBytes = PLANE_W * PLANE_H * 3;
    const rgba = new Uint8Array(PLANE_W * PLANE_H * 4);
    let pending = new Uint8Array(0);
    let index = 0;
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) return;
    for await (const part of stdout as ReadableStream<Uint8Array>) {
      if (this.closed || proc !== this.video) return;
      const buf = pending.length ? concat(pending, part) : part;
      let off = 0;
      while (buf.length - off >= frameBytes) {
        const rgb = buf.subarray(off, off + frameBytes);
        off += frameBytes;
        for (let i = 0; i < PLANE_W * PLANE_H; i++) {
          rgba[i * 4] = rgb[i * 3];
          rgba[i * 4 + 1] = rgb[i * 3 + 1];
          rgba[i * 4 + 2] = rgb[i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        const q = quantize(rgba, PLANE_W, PLANE_H);
        if (this.closed || proc !== this.video) return;
        this.writer.writeFrame(baseFrame + index, paletteBytes(q.palette), q.indices);
        index++;
        this.framesWritten = baseFrame + index;
      }
      pending = buf.subarray(off).slice();
    }
    if (!this.closed && proc === this.video) {
      this.writer.markEnded();
      this.events.onEnd?.("video-eof");
    }
  }

  private async pumpAudio(proc: Bun.Subprocess, baseSample: number): Promise<void> {
    const chunkSamples = CHUNK_FRAMES * 2;
    let pending = new Uint8Array(0);
    let frames = 0;
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) return;
    for await (const part of stdout as ReadableStream<Uint8Array>) {
      if (this.closed || proc !== this.audio) return;
      let buf = pending.length ? concat(pending, part) : part;
      while (buf.length >= chunkSamples * 2) {
        // Int16Array needs 2-byte alignment; a concat/subarray offset may
        // not be — copy the chunk out.
        const bytes = buf.slice(0, chunkSamples * 2);
        buf = buf.subarray(chunkSamples * 2);
        const pcm = new Int16Array(bytes.buffer, 0, chunkSamples);
        if (this.closed || proc !== this.audio) return;
        this.writer.writeAudio(baseSample + frames, pcm);
        frames += CHUNK_FRAMES;
      }
      pending = buf.slice();
    }
  }

  /** Bun's Subprocess.kill silently ignores job-control signal names —
   *  stop/cont must go through process.kill(pid, …). */
  private signal(sig: "SIGSTOP" | "SIGCONT"): void {
    for (const p of [this.video, this.audio]) {
      if (!p) continue;
      try {
        process.kill(p.pid, sig);
      } catch {
        // process already exited
      }
    }
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.signal("SIGSTOP"); // freeze decode+network NOW; rings stop growing
  }

  /** Resume by respawning at the paused position, NOT by SIGCONT alone:
   *  ffmpeg's -re clock keeps running while the process is stopped, so a
   *  plain continue bursts to catch up and the picture jumps by the whole
   *  pause duration (observed on hardware). The seek path already rebuilds
   *  cleanly (kill + respawn + epoch bump); reuse it. */
  resume(): void {
    if (!this.paused || this.closed) return;
    this.seek(this.framesWritten / FPS);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Kill + respawn at `seconds`, bumping the epoch so the device resyncs. */
  seek(seconds: number): void {
    if (this.closed) return;
    const to = Math.max(0, Math.min(seconds, Math.max(0, this.stream.durationS - 2)));
    this.killProcs();
    this.paused = false;
    this.writer.bumpEpoch();
    this.spawnAt(to);
  }

  private killProcs(): void {
    this.signal("SIGCONT"); // a stopped process cannot handle the TERM below
    for (const p of [this.video, this.audio]) p?.kill();
    this.video = null;
    this.audio = null;
  }

  /** Stop and delete the ring file (a new session writes a fresh file — the
   *  device holds no fd into this one once the app videoClose()s). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.killProcs();
    this.writer.close();
    try {
      unlinkSync(this.file);
    } catch {
      // already gone — fine
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
