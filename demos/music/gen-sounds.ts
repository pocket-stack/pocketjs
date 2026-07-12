// demos/music/gen-sounds.ts — synthesize the "Now Playing" demo's chiptune
// BGM loops and UI blip as committed WAV assets for sounds.json (AUDIO.md
// "Assets -- sounds.json -> SND pak entries").
//
//   bun demos/music/gen-sounds.ts
//
// Offline baker (run MANUALLY, like demos/zoomlab/gen-assets.ts) with NO
// external inputs, no Math.random and no wall clock: every track is a
// monophonic note sequence rendered straight into 16-bit PCM mono samples
// (square/triangle oscillators, a short linear attack/release envelope per
// note) so a re-run is byte-identical. Each track is built from an integer
// number of integer-length notes and its first sample (attack ratio 0/N = 0)
// and last sample (forced to 0) are both exact silence, so `loop: true`
// playback has no click at the seam — sample-accurate loop closure without
// needing to search for a zero crossing.
//
// Outputs are COMMITTED (the bake is deterministic; a re-run is byte-identical):
//   demos/music/sounds/midnight-replay.wav  BGM for "MIDNIGHT REPLAY" (A minor arpeggio, square, ~120 BPM)
//   demos/music/sounds/glass-horizon.wav    BGM for "GLASS HORIZON" (C major arpeggio, triangle, ~130 BPM)
//   demos/music/sounds/static-bloom.wav     BGM for "STATIC BLOOM" (pentatonic run, square+triangle alternating, ~160 BPM)
//   demos/music/sounds/click.wav            tiny UI blip SFX (baked for sounds.json/pak
//                                            coverage — the demo's interactive feedback
//                                            instead uses a defineSfx-registered synth
//                                            blip, zero pak cost; see app.tsx)
// demos/music/sounds.json maps all four into the pak as audio:bgm.<name> /
// audio:sfx.click (scripts/build.ts bakes them at build time; nothing here is
// read at runtime).

import { mkdirSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname; // demos/music/
const SOUNDS_DIR = HERE + "sounds/";
const RATE = 11025; // AUDIO.md budget: 11025 Hz halves the 22050 default

// ---------------------------------------------------------------------------
// Oscillators — phase in [0, 1), output in [-1, 1]. Pure functions of phase,
// no state, no randomness.
// ---------------------------------------------------------------------------

type Wave = "square" | "triangle";

function oscillator(wave: Wave, phase: number): number {
  if (wave === "square") return phase < 0.5 ? 1 : -1;
  // Continuous triangle: -1 at phase 0, +1 at phase 0.5, -1 at phase 1.
  return phase < 0.5 ? -1 + 4 * phase : 3 - 4 * phase;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(v * 32767);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WAV encoder (RIFF/WAVE, PCM=1, mono, 16-bit) — matches compiler/pak.ts's
// decodeWav exactly: "RIFF" + size, "WAVE", a 16-byte "fmt " chunk, then a
// "data" chunk immediately after (word-aligned; data length here is always
// even so no pad byte is needed).
// ---------------------------------------------------------------------------

function encodeWav(samples: Int16Array, rate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // format = PCM
  dv.setUint16(22, 1, true); // channels = mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // byte rate = rate * blockAlign
  dv.setUint16(32, 2, true); // block align (2 bytes/frame, mono 16-bit)
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return buf;
}

// ---------------------------------------------------------------------------
// Note-sequence renderer — every note gets its own short linear
// attack/release envelope (click-free note-to-note transitions); the whole
// buffer's first and last samples are forced to exact 0 for a clean loop seam.
// ---------------------------------------------------------------------------

interface TrackSpec {
  file: string;
  title: string;
  /** Scale degrees in Hz, indexed by `pattern`. */
  scale: number[];
  /** Sequence of indices into `scale`, one per note; tiled across the buffer once. */
  pattern: number[];
  /** Seconds per note (drives both tempo and note length). */
  noteSec: number;
  /** Waveform per note, cycled if shorter than `pattern`. */
  waves: Wave[];
  /** Peak amplitude, 0..1. */
  amp: number;
}

function renderTrack(spec: TrackSpec): Int16Array {
  const noteSamples = Math.round(RATE * spec.noteSec);
  const envSamples = Math.min(Math.round(RATE * 0.008), Math.floor(noteSamples / 4)); // ~8ms attack+release
  const total = noteSamples * spec.pattern.length;
  const buf = new Float32Array(total);
  for (let n = 0; n < spec.pattern.length; n++) {
    const freq = spec.scale[spec.pattern[n]];
    const wave = spec.waves[n % spec.waves.length];
    const offset = n * noteSamples;
    for (let i = 0; i < noteSamples; i++) {
      const phase = ((freq * i) / RATE) % 1;
      let env = 1;
      if (i < envSamples) env = i / envSamples;
      else if (i >= noteSamples - envSamples) env = (noteSamples - i) / envSamples;
      buf[offset + i] = oscillator(wave, phase) * env * spec.amp;
    }
  }
  buf[0] = 0; // exact silence at the loop start (attack ratio 0/N is already ~0; make it exact)
  buf[total - 1] = 0; // exact silence at the loop end -> click-free seam
  return toInt16(buf);
}

function renderClick(): Int16Array {
  const samples = Math.round(RATE * 0.035); // ~35ms blip
  const attackSamples = Math.round(RATE * 0.003);
  const releaseSamples = Math.round(RATE * 0.02);
  const freq = 1400;
  const buf = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const phase = ((freq * i) / RATE) % 1;
    let env = 1;
    if (i < attackSamples) env = i / attackSamples;
    else if (i >= samples - releaseSamples) env = Math.max(0, (samples - i) / releaseSamples);
    buf[i] = oscillator("square", phase) * env * 0.5;
  }
  buf[0] = 0;
  buf[samples - 1] = 0;
  return toInt16(buf);
}

// ---------------------------------------------------------------------------
// Track table — matches the 3 covers in demos/music/app.tsx (title/artist
// order and accent colors: blue "MIDNIGHT REPLAY", amber "GLASS HORIZON",
// cyan "STATIC BLOOM"); tempo/scale/waveform deliberately differ per track so
// they read as distinct loops.
// ---------------------------------------------------------------------------

// A natural minor, one octave (A3..A4).
const A_MINOR = [220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0];
// C major, one octave (C4..C5).
const C_MAJOR = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];
// C major pentatonic, one octave + a high C (C4..C5..C6).
const C_PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];

const TRACKS: TrackSpec[] = [
  {
    file: "midnight-replay.wav",
    title: "MIDNIGHT REPLAY — A minor arpeggio, square, ~120 BPM eighths",
    scale: A_MINOR,
    // 24 eighth-notes @ 120 BPM (noteSec 0.25s) = 6.0s
    pattern: [0, 2, 4, 7, 6, 4, 2, 0, 1, 3, 5, 7, 6, 5, 3, 1, 0, 2, 4, 6, 7, 6, 4, 2],
    noteSec: 0.25,
    waves: ["square"],
    amp: 0.35,
  },
  {
    file: "glass-horizon.wav",
    title: "GLASS HORIZON — C major arpeggio, triangle, ~130 BPM eighths",
    scale: C_MAJOR,
    // 24 eighth-notes @ 130 BPM (noteSec ~0.2308s) = ~5.54s
    pattern: [0, 2, 4, 7, 6, 4, 2, 0, 1, 3, 5, 7, 6, 5, 3, 1, 2, 4, 6, 7, 6, 4, 2, 0],
    noteSec: 60 / 130 / 2,
    waves: ["triangle"],
    amp: 0.4,
  },
  {
    file: "static-bloom.wav",
    title: "STATIC BLOOM — C major pentatonic run, square+triangle alternating, ~160 BPM sixteenths",
    scale: C_PENTATONIC,
    // 48 sixteenth-notes @ 160 BPM (noteSec ~0.09375s) = 4.5s
    pattern: [
      0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 0, 2, 4, 5, 4, 2,
      0, 1, 3, 5, 4, 3, 1, 0, 2, 4,
    ],
    noteSec: 60 / 160 / 4,
    waves: ["square", "triangle"],
    amp: 0.3,
  },
];

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

mkdirSync(SOUNDS_DIR, { recursive: true });

let totalBytes = 0;
for (const spec of TRACKS) {
  const pcm = renderTrack(spec);
  const wav = encodeWav(pcm, RATE);
  await Bun.write(SOUNDS_DIR + spec.file, wav);
  totalBytes += wav.length;
  console.log(
    `  bgm: ${spec.file} <- ${spec.title} (${(pcm.length / RATE).toFixed(2)}s, ${(wav.length / 1024).toFixed(1)} KB)`,
  );
}

const clickPcm = renderClick();
const clickWav = encodeWav(clickPcm, RATE);
await Bun.write(SOUNDS_DIR + "click.wav", clickWav);
totalBytes += clickWav.length;
console.log(`  sfx: click.wav (${((clickPcm.length / RATE) * 1000).toFixed(0)}ms, ${(clickWav.length / 1024).toFixed(1)} KB)`);

console.log(
  `gen-sounds: wrote ${TRACKS.length + 1} wav file(s), ${(totalBytes / 1024).toFixed(1)} KB total -> ${SOUNDS_DIR}`,
);
