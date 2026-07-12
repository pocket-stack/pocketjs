// test/sound-bake.test.ts — the audio ASSET pipeline (AUDIO.md "Assets —
// sounds.json -> SND pak entries"): compiler/pak.ts's decodeWav, resampleMono
// and encodeSoundEntry. Pure deterministic TS; no wall clock, no RNG, no host.
//
// Run: bun test test/sound-bake.test.ts (no --conditions=browser needed —
// this file never touches src/ or solid-js).

import { describe, expect, test } from "bun:test";
import {
  SND_FLAG_LOOP,
  SND_HEADER_SIZE,
  SND_MAGIC,
  SND_VERSION,
} from "../spec/spec.ts";
import { decodeWav, encodeSoundEntry, resampleMono } from "../compiler/pak.ts";

// ---------------------------------------------------------------------------
// helper: hand-build a minimal RIFF/WAVE PCM file (mirrors buildTileset in
// test/tiles.test.ts — construct the exact bytes the real encoder produces,
// then round-trip through our own decoder).
// ---------------------------------------------------------------------------

interface WavOpts {
  channels: number;
  rate: number;
  bitsPerSample: 8 | 16;
  /** Interleaved samples: signed for 16-bit, 0..255 unsigned for 8-bit. */
  samples: number[];
  /** Override the fmt chunk's format tag (1 = PCM). Used to test rejection. */
  format?: number;
}

function makeWav(opts: WavOpts): Uint8Array {
  const { channels, rate, bitsPerSample, samples, format = 1 } = opts;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buf = new Uint8Array(44 + dataSize);
  const dv = new DataView(buf.buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size (no extension)
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    if (bitsPerSample === 16) dv.setInt16(44 + i * 2, samples[i], true);
    else buf[44 + i] = samples[i] & 0xff;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// decodeWav
// ---------------------------------------------------------------------------

describe("decodeWav", () => {
  test("extracts rate/channels/samples from a 16-bit mono file", () => {
    const wav = makeWav({ channels: 1, rate: 22050, bitsPerSample: 16, samples: [0, 100, -100, 32767, -32768] });
    const dec = decodeWav(wav);
    expect(dec.rate).toBe(22050);
    expect(dec.channels).toBe(1);
    expect(Array.from(dec.samples)).toEqual([0, 100, -100, 32767, -32768]);
  });

  test("extracts interleaved samples from a 16-bit stereo file", () => {
    const wav = makeWav({ channels: 2, rate: 44100, bitsPerSample: 16, samples: [100, 300, -50, 50] });
    const dec = decodeWav(wav);
    expect(dec.rate).toBe(44100);
    expect(dec.channels).toBe(2);
    expect(Array.from(dec.samples)).toEqual([100, 300, -50, 50]);
  });

  test("expands 8-bit unsigned PCM to the s16 range, centered at 128", () => {
    const wav = makeWav({ channels: 1, rate: 8000, bitsPerSample: 8, samples: [0, 128, 255] });
    const dec = decodeWav(wav);
    expect(dec.channels).toBe(1);
    expect(dec.rate).toBe(8000);
    expect(Array.from(dec.samples)).toEqual([-32768, 0, 32512]);
  });

  test("throws a descriptive error on a non-PCM format tag", () => {
    const wav = makeWav({ channels: 1, rate: 22050, bitsPerSample: 16, samples: [0, 1], format: 3 });
    expect(() => decodeWav(wav)).toThrow(/format/);
  });

  test("throws on a bad RIFF/WAVE magic", () => {
    const wav = makeWav({ channels: 1, rate: 22050, bitsPerSample: 16, samples: [0] });
    const corrupt = wav.slice();
    corrupt[0] = 0; // clobber "R" of RIFF
    expect(() => decodeWav(corrupt)).toThrow(/RIFF/);
  });

  test("throws on an unsupported bit depth", () => {
    const wav = makeWav({ channels: 1, rate: 22050, bitsPerSample: 16, samples: [0, 1] });
    // Hand-clobber the bitsPerSample field (offset 34) to an unsupported value.
    new DataView(wav.buffer).setUint16(34, 24, true);
    expect(() => decodeWav(wav)).toThrow(/bit depth/);
  });

  test("throws on a truncated / malformed file", () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow();
    const wav = makeWav({ channels: 1, rate: 22050, bitsPerSample: 16, samples: [0, 1, 2] });
    expect(() => decodeWav(wav.slice(0, wav.length - 20))).toThrow(); // data chunk overruns
  });
});

// ---------------------------------------------------------------------------
// resampleMono
// ---------------------------------------------------------------------------

describe("resampleMono", () => {
  test("identity fast-path: mono at the same rate returns the samples unchanged", () => {
    const samples = new Int16Array([0, 100, -100, 32767, -32768]);
    const out = resampleMono(samples, 1, 22050, 22050);
    expect(Array.from(out)).toEqual(Array.from(samples));
  });

  test("downmixes stereo by averaging channels (no resample)", () => {
    const samples = new Int16Array([100, 300, -50, 50]);
    const out = resampleMono(samples, 2, 44100, 44100);
    expect(Array.from(out)).toEqual([200, 0]);
  });

  test("44100 -> 22050 halves frameCount within +-1", () => {
    const n = 4410; // 0.1s at 44100
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.round(Math.sin(i / 10) * 10000);
    const out = resampleMono(samples, 1, 44100, 22050);
    expect(Math.abs(out.length - n / 2)).toBeLessThanOrEqual(1);
  });

  test("22050 -> 44100 doubles frameCount within +-1 (upsample)", () => {
    const n = 2205;
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = (i * 37) % 1000;
    const out = resampleMono(samples, 1, 22050, 44100);
    expect(Math.abs(out.length - n * 2)).toBeLessThanOrEqual(1);
  });

  test("linear interpolation of a straight ramp stays evenly spaced", () => {
    // A perfectly linear source (0, 1000, 2000) resampled to double the rate
    // (3 frames @ rate 2 -> 6 frames @ rate 4) must land on an even ramp —
    // the exact values a correct linear interpolant produces for straight-
    // line input, endpoints included.
    const samples = new Int16Array([0, 1000, 2000]);
    const out = resampleMono(samples, 1, 2, 4);
    expect(out.length).toBe(6);
    expect(Array.from(out)).toEqual([0, 400, 800, 1200, 1600, 2000]);
  });

  test("output samples stay within the s16 range", () => {
    const samples = new Int16Array([32767, -32768, 32767, -32768]);
    const out = resampleMono(samples, 1, 8000, 11025);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });
});

// ---------------------------------------------------------------------------
// encodeSoundEntry
// ---------------------------------------------------------------------------

describe("encodeSoundEntry", () => {
  test("header round-trips the spec constants with loop off", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    const entry = encodeSoundEntry(pcm, 22050);
    const dv = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(dv.getUint32(0, true)).toBe(SND_MAGIC);
    expect(dv.getUint16(4, true)).toBe(SND_VERSION);
    expect(dv.getUint16(6, true)).toBe(0); // no loop flag
    expect(dv.getUint32(8, true)).toBe(22050);
    expect(dv.getUint32(12, true)).toBe(pcm.length);
    expect(dv.getUint32(16, true)).toBe(0); // loopStart default
    expect(dv.getUint32(20, true)).toBe(0); // reserved
    expect(entry.length).toBe(SND_HEADER_SIZE + pcm.length * 2);
  });

  test("header carries the loop flag + loopStart when opted in", () => {
    const pcm = new Int16Array(10);
    const entry = encodeSoundEntry(pcm, 11025, { loop: true, loopStart: 4 });
    const dv = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(dv.getUint16(6, true)).toBe(SND_FLAG_LOOP);
    expect(dv.getUint32(8, true)).toBe(11025);
    expect(dv.getUint32(16, true)).toBe(4);
  });

  test("sample bytes are preserved exactly, s16 LE", () => {
    const pcm = new Int16Array([1234, -1234, 0, 32767, -32768]);
    const entry = encodeSoundEntry(pcm, 22050);
    const dv = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    for (let i = 0; i < pcm.length; i++) {
      expect(dv.getInt16(SND_HEADER_SIZE + i * 2, true)).toBe(pcm[i]);
    }
  });

  test("rejects an out-of-range loopStart", () => {
    const pcm = new Int16Array(4);
    expect(() => encodeSoundEntry(pcm, 22050, { loopStart: 5 })).toThrow();
    expect(() => encodeSoundEntry(pcm, 22050, { loopStart: -1 })).toThrow();
  });

  test("rejects a bad sampleRate", () => {
    const pcm = new Int16Array(4);
    expect(() => encodeSoundEntry(pcm, 0)).toThrow();
    expect(() => encodeSoundEntry(pcm, -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// end-to-end: wav -> decode -> resample -> encode
// ---------------------------------------------------------------------------

describe("wav -> SND pipeline", () => {
  test("a 440Hz sine at 44100Hz mono bakes to a valid 22050Hz SND entry", () => {
    const rate = 44100;
    const durationS = 0.05;
    const n = Math.round(rate * durationS);
    const samples: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20000);
    }
    const wav = makeWav({ channels: 1, rate, bitsPerSample: 16, samples });

    const decoded = decodeWav(wav);
    expect(decoded.rate).toBe(rate);
    expect(decoded.channels).toBe(1);

    const target = 22050;
    const pcm = resampleMono(decoded.samples, decoded.channels, decoded.rate, target);
    expect(Math.abs(pcm.length - n / 2)).toBeLessThanOrEqual(1);

    const entry = encodeSoundEntry(pcm, target, { loop: true, loopStart: 0 });
    const dv = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect(dv.getUint32(0, true)).toBe(SND_MAGIC);
    expect(dv.getUint16(4, true)).toBe(SND_VERSION);
    expect(dv.getUint16(6, true)).toBe(SND_FLAG_LOOP);
    expect(dv.getUint32(8, true)).toBe(target);
    expect(dv.getUint32(12, true)).toBe(pcm.length);
    expect(entry.length).toBe(SND_HEADER_SIZE + pcm.length * 2);
  });

  test("a stereo 8-bit wav downmixes and resamples end to end", () => {
    const rate = 16000;
    const n = 100;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      samples.push(128 + Math.round(Math.sin(i / 5) * 50), 128 + Math.round(Math.cos(i / 5) * 50));
    }
    const wav = makeWav({ channels: 2, rate, bitsPerSample: 8, samples });
    const decoded = decodeWav(wav);
    expect(decoded.channels).toBe(2);
    const pcm = resampleMono(decoded.samples, decoded.channels, decoded.rate, 8000);
    expect(Math.abs(pcm.length - n / 2)).toBeLessThanOrEqual(1);
    const entry = encodeSoundEntry(pcm, 8000);
    expect(entry.length).toBe(SND_HEADER_SIZE + pcm.length * 2);
  });
});
