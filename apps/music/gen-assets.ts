// Deterministically synthesize the three original 5-second WAV tracks the
// music demo streams through the audio module (contracts/spec/audio.ts). No
// downloaded or copyrighted recordings; same synth architecture as the iPod
// Stage demo's generate_media.ts, cut to the demo's 300-frame track length.
//
//   bun apps/music/gen-assets.ts     # rewrites apps/music/media/*.wav
//
// The outputs are committed (pak.json splices them verbatim; the build never
// runs this). Exactly 5.000 s at 22 050 Hz mono s16 — 300 frames at 60 Hz, so
// the demo's tick-driven progress bar IS the track clock and the pixel
// goldens stay frame-locked. tests/audio.test.ts pins the decoded shape.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22_050;
const DURATION_SECONDS = 5;
const SAMPLES = SAMPLE_RATE * DURATION_SECONDS;
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "media");

interface Song {
  file: string;
  bpm: number;
  lead: readonly number[];
  bass: readonly number[];
  /** Phase offset that shades the triangle layer per song. */
  color: number;
}

// Motifs match the demo's track moods: MIDNIGHT REPLAY (dark synthwave),
// GLASS HORIZON (bright and open), STATIC BLOOM (fast neon arpeggio).
const SONGS: readonly Song[] = [
  {
    file: "midnight-replay.wav",
    bpm: 118,
    lead: [57, 60, 64, 67, 64, 60, 55, 59, 62, 66, 62, 59, 53, 57, 60, 64],
    bass: [33, 31, 29, 31],
    color: 0.12,
  },
  {
    file: "glass-horizon.wav",
    bpm: 100,
    lead: [69, 73, 76, 81, 76, 73, 74, 78, 81, 85, 81, 78, 71, 74, 78, 83],
    bass: [45, 43, 47, 43],
    color: 0.45,
  },
  {
    file: "static-bloom.wav",
    bpm: 128,
    lead: [64, 71, 68, 76, 71, 64, 66, 73, 69, 78, 73, 66, 61, 68, 64, 73],
    bass: [37, 39, 35, 39],
    color: 0.78,
  },
];

const frequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const fract = (value: number): number => value - Math.floor(value);
const triangle = (phase: number): number => 1 - 4 * Math.abs(fract(phase) - 0.5);

function noise(sample: number, seed: number): number {
  let value = (sample ^ (seed * 0x9e3779b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return ((value >>> 0) / 0xffff_ffff) * 2 - 1;
}

function render(song: Song, songIndex: number): Int16Array {
  const pcm = new Int16Array(SAMPLES);
  for (let sample = 0; sample < SAMPLES; sample++) {
    const t = sample / SAMPLE_RATE;
    const beat = (t * song.bpm) / 60;
    const eighth = Math.floor(beat * 2);
    const leadNote = song.lead[eighth % song.lead.length];
    const leadPhase = fract(beat * 2);
    const leadEnvelope = Math.exp(-leadPhase * 3.4) * (0.78 + 0.22 * Math.sin(Math.PI * leadPhase));
    const leadFrequency = frequency(leadNote);
    const lead =
      (Math.sin(Math.PI * 2 * leadFrequency * t) * 0.72 +
        triangle(leadFrequency * 0.5 * t + song.color) * 0.28) *
      leadEnvelope;

    const bassNote = song.bass[Math.floor(beat / 2) % song.bass.length];
    const bassPhase = fract(beat / 2);
    const bass =
      Math.sin(Math.PI * 2 * frequency(bassNote) * t) *
      Math.exp(-bassPhase * 1.7);

    const beatPhase = fract(beat);
    const kickFrequency = 54 + 92 * Math.exp(-beatPhase * 20);
    const kick =
      Math.sin(Math.PI * 2 * kickFrequency * t) * Math.exp(-beatPhase * 18);
    const hatPhase = fract(beat * 2);
    const hat = noise(sample, songIndex + 1) * Math.exp(-hatPhase * 42);

    const intro = Math.min(1, t / 0.35);
    const outro = Math.min(1, (DURATION_SECONDS - t) / 0.6);
    const value = (lead * 0.36 + bass * 0.28 + kick * 0.22 + hat * 0.055) * intro * outro;
    pcm[sample] = Math.round(Math.max(-1, Math.min(1, value)) * 28_000);
  }
  return pcm;
}

function wavBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

mkdirSync(OUT, { recursive: true });
for (const [index, song] of SONGS.entries()) {
  const path = join(OUT, song.file);
  await Bun.write(path, wavBytes(render(song, index)));
  console.log(`${song.file}: ${DURATION_SECONDS}s, ${SAMPLE_RATE} Hz mono PCM`);
}
