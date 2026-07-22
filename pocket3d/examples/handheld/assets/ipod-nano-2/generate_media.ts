// Deterministically generate three short original PCM WAV songs for the
// local iPod Stage demo. No downloaded or copyrighted recordings are used.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22_050;
const DURATION_SECONDS = 24;
const SAMPLES = SAMPLE_RATE * DURATION_SECONDS;
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "media");

interface Song {
  file: string;
  bpm: number;
  lead: readonly number[];
  bass: readonly number[];
  color: number;
}

const SONGS: readonly Song[] = [
  {
    file: "neon-boardwalk.wav",
    bpm: 112,
    lead: [69, 72, 76, 72, 67, 71, 74, 71, 65, 69, 72, 69, 67, 71, 76, 74],
    bass: [45, 43, 41, 43],
    color: 0.18,
  },
  {
    file: "silver-static.wav",
    bpm: 96,
    lead: [64, 67, 71, 74, 71, 67, 66, 69, 73, 76, 73, 69, 62, 66, 69, 73],
    bass: [40, 42, 38, 42],
    color: 0.42,
  },
  {
    file: "night-bus-loop.wav",
    bpm: 124,
    lead: [62, 65, 69, 72, 69, 65, 60, 64, 67, 71, 67, 64, 58, 62, 65, 69],
    bass: [38, 36, 34, 36],
    color: 0.67,
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
