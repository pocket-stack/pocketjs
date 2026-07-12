// Pocket Audio runtime (AUDIO.md) — the JS side of the `audio.*` surface.
//
// Audio lives ENTIRELY outside pocketjs-core: no Ui method, no wasm export,
// no DrawList op, and it never will (DETERMINISM.md). Mounted as
// `globalThis.audio` — NOT `ui.*` — so a host that doesn't set it gives the
// guest no way to make noise; goldens, input tapes and headless test hosts
// never mount it, keeping replay byte-exact by construction (same contract
// as the DevTools ops, DEVTOOLS.md). Framework-agnostic: shared by the Solid
// and Vue Vapor entry points (no solid-js imports here — src/audio.ts is the
// thin public shim).
//
// Every op is SYNCHRONOUS fire-and-forget: it enqueues intent and returns
// undefined — nothing about playback state ever flows back into the guest.
// Every public function here is a SILENT no-op when no host is mounted (or
// the host lacks a given method); apps must never branch on audio
// availability (see audioSupported()).

import { ENUMS } from "../spec/spec.ts";

/** The `audio.*` op surface (spec OP 26..31). All methods are optional: a
 *  host that mounts `globalThis.audio` may implement any subset — a missing
 *  method is the same silent no-op as no host at all. */
export interface AudioOps {
  /** op 26: one-shot SFX from the pak (audio:sfx.<key>). volume 0..1
   *  (x sfx x master gain); pan -1..1 (0 = center). Unknown key: no-op. */
  playSfx?(key: string, volume: number, pan: number): void;
  /** op 27: one-shot procedural voice. wave = ENUMS.Waveform ordinal; linear
   *  freq sweep freq -> freqEnd over durMs; linear attack/release envelope
   *  in ms. Routed through the sfx bus. */
  playSynth?(
    wave: number,
    freq: number,
    freqEnd: number,
    durMs: number,
    attackMs: number,
    releaseMs: number,
    volume: number,
  ): void;
  /** op 28: start/switch the single music track (audio:bgm.<key>). loop
   *  0|1; fadeMs cross-fades from the current track where the host can,
   *  else cuts. Same key as the playing track: no-op (phase kept). */
  playBgm?(key: string, loop: number, fadeMs: number, volume: number): void;
  /** op 29: fade the track to silence and release it. */
  stopBgm?(fadeMs: number): void;
  /** op 30: freeze/resume the track cursor (idempotent). */
  pauseBgm?(paused: number): void;
  /** op 31: live bus gain. channel = ENUMS.AudioChannel ordinal. Hosts ramp
   *  ~10ms to avoid clicks. */
  setChannelVolume?(channel: number, volume: number): void;
  /** web-only dunder: resume the AudioContext after the first user gesture.
   *  Wired by the host itself (first keydown/pointerdown) — the runtime
   *  never calls this. */
  __unlock?(): void;
}

/** A code-defined procedural sound — the 8-bit palette (AUDIO.md). No asset,
 *  no pak entry: descriptors travel as op numbers, so a synth sound costs
 *  zero pak bytes. */
export interface SynthDesc {
  wave: "square" | "pulse25" | "pulse12" | "triangle" | "saw" | "sine" | "noise";
  /** Hz at note-on. */
  freq: number;
  /** Hz at note-off (linear sweep); default = freq. */
  freqEnd?: number;
  /** Total voice length, envelope included. */
  durMs: number;
  /** Linear fade-in; default 0. */
  attackMs?: number;
  /** Linear fade-out; default 15 (click-free tail). */
  releaseMs?: number;
  /** 0..1, default 1. */
  volume?: number;
}

const WAVE_ORDINAL: Record<SynthDesc["wave"], number> = {
  square: ENUMS.Waveform.Square,
  pulse25: ENUMS.Waveform.Pulse25,
  pulse12: ENUMS.Waveform.Pulse12,
  triangle: ENUMS.Waveform.Triangle,
  saw: ENUMS.Waveform.Saw,
  sine: ENUMS.Waveform.Sine,
  noise: ENUMS.Waveform.Noise,
};

interface AudioState {
  ops: AudioOps | null;
  volumes: { master: number; sfx: number; bgm: number };
  /** Mute is runtime-level only: it pushes master gain 0 to the host while
   *  volumes.master keeps holding the app's real value (the "remembered
   *  master") so unmute can restore it — and setVolume("master") while
   *  muted can keep updating that remembered value without unmuting. */
  muted: boolean;
  synths: Map<string, SynthDesc>;
  bgm: { key: string | null; playing: boolean; paused: boolean };
}

const state: AudioState = {
  ops: null,
  volumes: { master: 1, sfx: 1, bgm: 1 },
  muted: false,
  synths: new Map(),
  bgm: { key: null, playing: false, paused: false },
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampPan(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function pushChannelVolume(channel: number, volume: number): void {
  state.ops?.setChannelVolume?.(channel, volume);
}

// ---------------------------------------------------------------------------
// lifecycle (wired by index.ts render()/dispose — not part of the public API)
// ---------------------------------------------------------------------------

/**
 * Resolve the audio host: an explicitly injected AudioOps wins; otherwise
 * `globalThis.audio` (mounted by the web host / a test); otherwise no audio.
 * Pushes all three channel volumes to the host so its bus gains match
 * runtime state (matters when the runtime already has non-default volumes,
 * e.g. a hot-reloaded mount).
 */
export function initAudio(injected?: AudioOps): void {
  state.ops = injected ?? (globalThis as { audio?: AudioOps }).audio ?? null;
  pushChannelVolume(ENUMS.AudioChannel.Master, state.muted ? 0 : state.volumes.master);
  pushChannelVolume(ENUMS.AudioChannel.Sfx, state.volumes.sfx);
  pushChannelVolume(ENUMS.AudioChannel.Bgm, state.volumes.bgm);
}

/** Tear down for test isolation / render() disposal: stops any playing BGM
 *  (fade 0) and resets every module-level field back to its default. */
export function resetAudio(): void {
  if (state.bgm.playing) stopBgm({ fadeMs: 0 });
  state.ops = null;
  state.volumes.master = 1;
  state.volumes.sfx = 1;
  state.volumes.bgm = 1;
  state.muted = false;
  state.synths.clear();
  state.bgm.key = null;
  state.bgm.playing = false;
  state.bgm.paused = false;
}

// ---------------------------------------------------------------------------
// public API (re-exported by src/audio.ts)
// ---------------------------------------------------------------------------

/** Whether an audio host is mounted. PRESENTATION ONLY (e.g. grey out a
 *  volume slider) — never branch app state on this (DETERMINISM.md). */
export function audioSupported(): boolean {
  return state.ops !== null;
}

/** Register a SynthDesc under `name`. Re-defining replaces. Registrations
 *  live in app JS only — nothing is baked or shipped. */
export function defineSfx(name: string, desc: SynthDesc): void {
  state.synths.set(name, desc);
}

/** Play an unnamed SynthDesc immediately (op 27), filling in its defaults
 *  and mapping `wave` to its ENUMS.Waveform ordinal. */
export function playSynth(desc: SynthDesc): void {
  const freqEnd = desc.freqEnd ?? desc.freq;
  const attackMs = desc.attackMs ?? 0;
  const releaseMs = desc.releaseMs ?? 15;
  const volume = clamp01(desc.volume ?? 1);
  state.ops?.playSynth?.(
    WAVE_ORDINAL[desc.wave],
    desc.freq,
    freqEnd,
    desc.durMs,
    attackMs,
    releaseMs,
    volume,
  );
}

/**
 * Play `name`: if it was registered with defineSfx(), routes to playSynth();
 * otherwise plays the pak SFX (op 26, `audio:sfx.<name>` resolved host-side —
 * the bare name crosses the FFI, mirroring loadTileTexture's pak keys).
 */
export function playSfx(name: string, opts?: { volume?: number; pan?: number }): void {
  const synth = state.synths.get(name);
  if (synth) {
    const volume = opts?.volume !== undefined ? clamp01(opts.volume) : synth.volume;
    playSynth(volume === synth.volume ? synth : { ...synth, volume });
    return;
  }
  const volume = clamp01(opts?.volume ?? 1);
  const pan = clampPan(opts?.pan ?? 0);
  state.ops?.playSfx?.(name, volume, pan);
}

/**
 * Start/switch the single music track (op 28, `audio:bgm.<name>` resolved
 * host-side). Calling with the already-playing name is a no-op (phase kept).
 */
export function playBgm(
  name: string,
  opts?: { loop?: boolean; fadeMs?: number; volume?: number },
): void {
  if (state.bgm.playing && state.bgm.key === name) return;
  const loop = opts?.loop ?? true;
  const fadeMs = opts?.fadeMs ?? 0;
  const volume = clamp01(opts?.volume ?? 1);
  state.ops?.playBgm?.(name, loop ? 1 : 0, fadeMs, volume);
  state.bgm.key = name;
  state.bgm.playing = true;
  state.bgm.paused = false;
}

/** Freeze the track cursor (op 30). Idempotent: a no-op while already
 *  paused or while nothing is playing. */
export function pauseBgm(): void {
  if (!state.bgm.playing || state.bgm.paused) return;
  state.bgm.paused = true;
  state.ops?.pauseBgm?.(1);
}

/** Unfreeze the track cursor (op 30). Idempotent; a no-op after stopBgm()
 *  since the track is gone. */
export function resumeBgm(): void {
  if (!state.bgm.playing || !state.bgm.paused) return;
  state.bgm.paused = false;
  state.ops?.pauseBgm?.(0);
}

/** Fade the track to silence and release it (op 29). No-op if nothing is
 *  playing. */
export function stopBgm(opts?: { fadeMs?: number }): void {
  if (!state.bgm.playing) return;
  const fadeMs = opts?.fadeMs ?? 0;
  state.ops?.stopBgm?.(fadeMs);
  state.bgm.key = null;
  state.bgm.playing = false;
  state.bgm.paused = false;
}

/** Set a bus's live gain (op 31), clamped to 0..1. `setVolume("master", v)`
 *  while muted updates the remembered master WITHOUT unmuting or pushing to
 *  the host (the host stays at 0 until setMuted(false)). */
export function setVolume(channel: "master" | "sfx" | "bgm", v: number): void {
  const clamped = clamp01(v);
  if (channel === "master") {
    state.volumes.master = clamped;
    if (!state.muted) pushChannelVolume(ENUMS.AudioChannel.Master, clamped);
    return;
  }
  state.volumes[channel] = clamped;
  pushChannelVolume(
    channel === "sfx" ? ENUMS.AudioChannel.Sfx : ENUMS.AudioChannel.Bgm,
    clamped,
  );
}

/** The runtime-held value for `channel` — identical on every host, never
 *  read back from hardware. Reflects the app's intended master volume even
 *  while muted (see setVolume). */
export function getVolume(channel: "master" | "sfx" | "bgm"): number {
  return state.volumes[channel];
}

/** Mute pushes master gain 0 to the host and remembers the current master
 *  volume; unmute restores it. Runtime-level only (see AUDIO.md
 *  Determinism contract — a muted PSP and an unmuted browser tab must stay
 *  pixel-identical app-state-wise). */
export function setMuted(on: boolean): void {
  if (on === state.muted) return;
  state.muted = on;
  pushChannelVolume(ENUMS.AudioChannel.Master, on ? 0 : state.volumes.master);
}

export function isMuted(): boolean {
  return state.muted;
}
