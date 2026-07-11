// demos/nightbloom/sfx.ts — the sound sink: NIGHTBLOOM's hit/impact audio,
// synthesized from oscillators (no assets, no pipeline) and installed as
// globalThis.__nightbloomSfx for the engine to poke.
//
// Sound is an OUTPUT, never an input: the engine emits SfxKind events from
// deterministic tick state and reads nothing back, so the simulation is
// byte-identical with or without a sink. Hosts without WebAudio (the
// headless sim, QuickJS on a PSP) simply never install one.
//
// Everything is feature-detected off globalThis — this module must load
// cleanly on every host, so it never names a DOM type.
//
// Browser autoplay policy: the AudioContext starts suspended until a user
// gesture; the first keydown / pointer press resumes it, which is also the
// gesture that presses START.

import type { SfxKind } from "./data.ts";

interface Voice {
  /** Oscillator frequency ramp, seconds, wave, peak gain, start delay. */
  f0: number;
  f1: number;
  dur: number;
  type: "sine" | "square" | "sawtooth" | "triangle";
  gain: number;
  delay?: number;
}

interface NoiseBurst {
  dur: number;
  gain: number;
  cutoff: number;
  delay?: number;
}

interface SfxDef {
  voices: Voice[];
  noise?: NoiseBurst[];
  /** Minimum wall-clock ms between plays of this kind (spam guard). */
  throttle?: number;
}

const ARP = (notes: number[], step: number, dur: number, gain: number, type: Voice["type"]): Voice[] =>
  notes.map((f, i) => ({ f0: f, f1: f, dur, type, gain, delay: i * step }));

const SFX: Record<SfxKind, SfxDef> = {
  // the trigger finger — quiet, constant, felt more than heard
  shoot: { voices: [{ f0: 900, f1: 640, dur: 0.03, type: "square", gain: 0.03 }], throttle: 45 },
  // 打击音效 — the thock of a shot landing
  hit: {
    voices: [{ f0: 250, f1: 150, dur: 0.055, type: "square", gain: 0.1 }],
    noise: [{ dur: 0.035, gain: 0.08, cutoff: 900 }],
    throttle: 40,
  },
  kill: {
    voices: [{ f0: 720, f1: 170, dur: 0.15, type: "triangle", gain: 0.16 }],
    noise: [{ dur: 0.07, gain: 0.12, cutoff: 1400 }],
    throttle: 60,
  },
  hurt: {
    voices: [{ f0: 260, f1: 65, dur: 0.24, type: "sawtooth", gain: 0.26 }],
    noise: [{ dur: 0.14, gain: 0.18, cutoff: 500 }],
  },
  wilt: { voices: [{ f0: 440, f1: 110, dur: 0.45, type: "triangle", gain: 0.2 }] },
  graze: { voices: [{ f0: 2300, f1: 2300, dur: 0.02, type: "sine", gain: 0.05 }], throttle: 70 },
  mote: { voices: [{ f0: 1300, f1: 1560, dur: 0.05, type: "sine", gain: 0.055 }], throttle: 50 },
  switch: { voices: ARP([520, 780], 0.06, 0.05, 0.1, "square") },
  spell: {
    voices: [
      { f0: 250, f1: 1400, dur: 0.3, type: "sawtooth", gain: 0.16 },
      { f0: 1800, f1: 1800, dur: 0.15, type: "sine", gain: 0.07, delay: 0.1 },
    ],
  },
  evolve: { voices: ARP([523.25, 659.25, 783.99], 0.07, 0.12, 0.12, "sine") },
  unlock: { voices: ARP([659.25, 880, 1174.66, 1567.98], 0.09, 0.2, 0.13, "triangle") },
  heal: { voices: [{ f0: 880, f1: 1320, dur: 0.07, type: "sine", gain: 0.05 }], throttle: 260 },
  // the diva's cry — three quick chirps, up, down-up, and away
  "boss-bird": {
    voices: [
      { f0: 2000, f1: 2750, dur: 0.07, type: "sine", gain: 0.16 },
      { f0: 2500, f1: 1650, dur: 0.09, type: "sine", gain: 0.14, delay: 0.1 },
      { f0: 2300, f1: 3100, dur: 0.1, type: "sine", gain: 0.15, delay: 0.21 },
    ],
  },
  // the umbrella's cry — a beating metal clang over a low whoomp
  "boss-umbrella": {
    voices: [
      { f0: 196, f1: 180, dur: 0.4, type: "square", gain: 0.14 },
      { f0: 203, f1: 186, dur: 0.4, type: "square", gain: 0.12 },
      { f0: 90, f1: 45, dur: 0.35, type: "sawtooth", gain: 0.2, delay: 0.02 },
    ],
    noise: [{ dur: 0.12, gain: 0.14, cutoff: 3200 }],
  },
  bossbreak: {
    voices: [{ f0: 160, f1: 40, dur: 0.5, type: "sawtooth", gain: 0.28 }, ...ARP([659.25, 783.99, 1046.5], 0.09, 0.16, 0.1, "sine")],
    noise: [{ dur: 0.3, gain: 0.22, cutoff: 700 }],
  },
  dawn: { voices: ARP([523.25, 659.25, 783.99, 1046.5], 0.12, 0.4, 0.13, "sine") },
  eternal: {
    voices: [
      { f0: 110, f1: 55, dur: 0.9, type: "sawtooth", gain: 0.26 },
      { f0: 220, f1: 110, dur: 0.7, type: "triangle", gain: 0.18, delay: 0.05 },
    ],
  },
};

const MASTER_GAIN = 0.6;
const MAX_VOICES = 14;

export function installSfx(): void {
  const g = globalThis as Record<string, unknown>;
  const AC = (g.AudioContext ?? g.webkitAudioContext) as (new () => AudioContext) | undefined;
  if (!AC) return; // headless sim, PSP: no audio device, no sink

  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);

  // one shared noise buffer for the impact texture (xorshift so even the
  // speaker noise is reproducible — the repo's habit, kept out of habit)
  const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.3), ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  let n = 0x6e696768; // "nigh"
  for (let i = 0; i < data.length; i++) {
    n ^= (n << 13) >>> 0;
    n = n >>> 0;
    n ^= n >>> 17;
    n ^= (n << 5) >>> 0;
    n = n >>> 0;
    data[i] = (n / 0xffffffff) * 2 - 1;
  }

  let live = 0;
  const lastPlay = new Map<SfxKind, number>();

  const spend = (): boolean => {
    if (live >= MAX_VOICES) return false;
    live++;
    return true;
  };
  const release = (): void => {
    live = Math.max(0, live - 1);
  };

  function tone(v: Voice): void {
    if (!spend()) return;
    const t0 = ctx.currentTime + (v.delay ?? 0);
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = v.type;
    osc.frequency.setValueAtTime(Math.max(1, v.f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.f1), t0 + v.dur);
    env.gain.setValueAtTime(v.gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
    osc.connect(env);
    env.connect(master);
    osc.onended = release;
    osc.start(t0);
    osc.stop(t0 + v.dur + 0.02);
  }

  function burst(n: NoiseBurst): void {
    if (!spend()) return;
    const t0 = ctx.currentTime + (n.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = n.cutoff;
    const env = ctx.createGain();
    env.gain.setValueAtTime(n.gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
    src.connect(lp);
    lp.connect(env);
    env.connect(master);
    src.onended = release;
    src.start(t0);
    src.stop(t0 + n.dur + 0.02);
  }

  g.__nightbloomSfx = (kind: SfxKind) => {
    const def = SFX[kind];
    if (!def) return;
    if (ctx.state !== "running") return; // pre-gesture: stay silent
    const now = performance.now();
    if (def.throttle) {
      const last = lastPlay.get(kind) ?? -1e9;
      if (now - last < def.throttle) return;
      lastPlay.set(kind, now);
    }
    for (const v of def.voices) tone(v);
    for (const n of def.noise ?? []) burst(n);
  };

  // The lab seam: lets a harness confirm the device state without hearing.
  g.__nightbloomSfxState = () => ({ state: ctx.state, live });

  // Autoplay policy: resume on the first (and any later) user gesture.
  const doc = g.document as { addEventListener?: (t: string, cb: () => void) => void } | undefined;
  const resume = (): void => {
    if (ctx.state === "suspended") void ctx.resume();
  };
  if (doc?.addEventListener) {
    doc.addEventListener("keydown", resume);
    doc.addEventListener("pointerdown", resume);
  }
}
