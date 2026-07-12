// host-web/audio.js — WebAudio implementation of globalThis.audio (AUDIO.md,
// src/sound.ts AudioOps). Plain ES module, zero deps, in the wasm-ops.js
// style. Mounted by engine.js as `globalThis.audio = createWebAudio(findEntry)`
// BEFORE the demo bundle evals (mirrors the globalThis.ui contract). Audio has
// NO core implementation, no wasm export, no DrawList op (DETERMINISM.md) —
// this file must stay out of test/golden.ts and host-sim/ entirely.
//
// Node graph:
//        sfxGain \
//                  -> masterGain -> destination
//        bgmGain /
// One AudioBufferSourceNode per playSfx/playSynth call (through a per-play
// GainNode + StereoPannerNode); a single BGM "slot" (one GainNode + one live
// source at a time) for playBgm/pauseBgm/stopBgm cross-fades.
//
// SND pak entries (spec/spec.ts, AUDIO.md) are decoded once per key into an
// AudioBuffer and cached; playSynth descriptors are pre-rendered ONCE per
// distinct arg-tuple into a cached AudioBuffer using the exact waveform math
// documented in AUDIO.md, so a blip sounds the same as the PSP mixer.
//
// Autoplay policy (AUDIO.md Hosts table): the AudioContext starts locked —
// browser policy, not a bug. Until __unlock() runs (wired by engine.js to the
// first keydown/pointerdown), playSfx/playSynth are silently dropped and the
// LAST playBgm call is remembered and started from the top at unlock.

// spec/spec.ts SND_* / ENUMS.Waveform, hand-rolled: host-web has no build
// step for these files (same convention as the BTN map in engine.js).
const SND_MAGIC = 0x44534b50; // 'PKSD' LE
const SND_HEADER_SIZE = 24;
const SND_FLAG_LOOP = 1 << 0;
const WAVE = { SQUARE: 0, PULSE25: 1, PULSE12: 2, TRIANGLE: 3, SAW: 4, SINE: 5, NOISE: 6 };

const CHANNEL_RAMP_S = 0.01; // ~10ms click-free channel-volume ramps (AUDIO.md)

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampPan(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Parse one SND pak entry (AUDIO.md layout) into header fields + a DataView
 *  over the s16 LE PCM data. Returns null for a missing/too-short/bad-magic
 *  entry (silent no-op territory — callers warn once per key). */
function parseSnd(bytes) {
  if (!bytes || bytes.length < SND_HEADER_SIZE) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== SND_MAGIC) return null;
  const flags = dv.getUint16(6, true);
  const sampleRate = dv.getUint32(8, true);
  const frameCount = dv.getUint32(12, true);
  const loopStart = dv.getUint32(16, true);
  if (SND_HEADER_SIZE + frameCount * 2 > bytes.length) return null;
  return { flags, sampleRate, frameCount, loopStart, dv, dataOff: SND_HEADER_SIZE };
}

/** Render one cycle of a SynthDesc (AUDIO.md waveform math) as Float32
 *  samples at `sampleRate`, envelope included. Linear freq sweep freq ->
 *  freqEnd across durMs; linear attack over attackMs; linear release over the
 *  final releaseMs. */
function renderSynth(wave, freq, freqEnd, durMs, attackMs, releaseMs, sampleRate) {
  const n = Math.max(1, Math.round((durMs / 1000) * sampleRate));
  const out = new Float32Array(n);
  let phase = 0; // 0..1 phase accumulator
  let lfsr = 0x1; // 15-bit LFSR, seeded non-zero
  const dt = 1 / sampleRate;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0; // 0..1 progress through the sweep
    const f = freq + (freqEnd - freq) * t;
    let s;
    switch (wave) {
      case WAVE.SQUARE:
        s = phase < 0.5 ? 1 : -1;
        break;
      case WAVE.PULSE25:
        s = phase < 0.25 ? 1 : -1;
        break;
      case WAVE.PULSE12:
        s = phase < 0.125 ? 1 : -1;
        break;
      case WAVE.TRIANGLE:
        s = 4 * Math.abs(phase - 0.5) - 1; // folded ramp, -1..1
        break;
      case WAVE.SAW:
        s = 2 * phase - 1;
        break;
      case WAVE.SINE:
        s = Math.sin(2 * Math.PI * phase);
        break;
      case WAVE.NOISE:
      default:
        // Classic 15-bit LFSR: taps bits 0 and 1.
        lfsr = (lfsr >> 1) | (((lfsr ^ (lfsr >> 1)) & 1) << 14);
        s = lfsr & 1 ? 1 : -1;
        break;
    }
    const ms = (i / sampleRate) * 1000;
    const remainMs = durMs - ms;
    let env = 1;
    if (attackMs > 0 && ms < attackMs) env = ms / attackMs;
    if (releaseMs > 0 && remainMs < releaseMs) env = Math.min(env, Math.max(0, remainMs / releaseMs));
    out[i] = s * env;
    phase += f * dt;
    phase -= Math.floor(phase); // wrap 0..1
  }
  return out;
}

/**
 * @param {(key: string) => Uint8Array | null} findEntry raw bytes of a pak
 *   entry (e.g. "audio:sfx.click" / "audio:bgm.theme1"), or null when the
 *   pak is absent or the key doesn't exist. Built by engine.js over the
 *   already-fetched pak bytes.
 * @returns AudioOps-shaped object (src/sound.ts) plus a host-only dispose().
 */
export function createWebAudio(findEntry) {
  let ctx = null;
  let masterGain = null;
  let sfxGain = null;
  let bgmGain = null;
  let unlockedFlag = false;
  const channelVolume = [1, 1, 1]; // 0 master, 1 sfx, 2 bgm — applied once ctx exists
  const warned = new Set(); // one console.warn per malformed/unknown key

  const sndCache = new Map(); // full pak key -> { buffer, loop, loopStart } | null
  const synthCache = new Map(); // packed arg-tuple -> AudioBuffer

  // The single BGM slot: at most one of these is "live" at a time.
  let bgm = null; // { key, source, gain, buffer, loop, loopStart, startedAt, offset, paused }
  let pendingBgm = null; // { key, loop, fadeMs, volume } remembered while locked

  function ensureCtx() {
    if (ctx) return ctx;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    sfxGain = ctx.createGain();
    bgmGain = ctx.createGain();
    sfxGain.connect(masterGain);
    bgmGain.connect(masterGain);
    masterGain.connect(ctx.destination);
    masterGain.gain.value = channelVolume[0];
    sfxGain.gain.value = channelVolume[1];
    bgmGain.gain.value = channelVolume[2];
    return ctx;
  }

  function warnOnce(key, msg) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn("[pocketjs/audio] " + msg);
  }

  function buildSndBuffer(parsed) {
    const buf = ctx.createBuffer(1, parsed.frameCount, parsed.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < parsed.frameCount; i++) {
      ch[i] = parsed.dv.getInt16(parsed.dataOff + i * 2, true) / 32768;
    }
    return buf;
  }

  /** Decode-and-cache one SND pak entry (ctx must already exist). */
  function getSndEntry(fullKey) {
    if (sndCache.has(fullKey)) return sndCache.get(fullKey);
    const bytes = findEntry(fullKey);
    let result = null;
    if (bytes) {
      const parsed = parseSnd(bytes);
      if (!parsed) {
        warnOnce(fullKey, "malformed SND entry: " + fullKey);
      } else {
        result = {
          buffer: buildSndBuffer(parsed),
          loop: !!(parsed.flags & SND_FLAG_LOOP),
          loopStart: parsed.loopStart / parsed.sampleRate,
        };
      }
    }
    sndCache.set(fullKey, result);
    return result;
  }

  /** Play a pre-built AudioBuffer through the sfx bus (used by both playSfx
   *  and playSynth — a synth voice is just a pre-rendered SFX). */
  function playBufferThroughSfx(buffer, volume, pan) {
    const gain = ctx.createGain();
    gain.gain.value = clamp01(volume);
    let tail = gain;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clampPan(pan);
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(sfxGain);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.start();
  }

  function playSfxImpl(key, volume, pan) {
    if (!unlockedFlag) return; // dropped while locked
    const entry = getSndEntry("audio:sfx." + key);
    if (!entry) return; // unknown/malformed key: silent no-op
    playBufferThroughSfx(entry.buffer, volume, pan);
  }

  function playSynthImpl(wave, freq, freqEnd, durMs, attackMs, releaseMs, volume) {
    if (!unlockedFlag) return; // dropped while locked
    const cacheKey = wave + "|" + freq + "|" + freqEnd + "|" + durMs + "|" + attackMs + "|" + releaseMs + "|" + ctx.sampleRate;
    let buffer = synthCache.get(cacheKey);
    if (!buffer) {
      const data = renderSynth(wave, freq, freqEnd, durMs, attackMs, releaseMs, ctx.sampleRate);
      buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buffer.getChannelData(0).set(data);
      synthCache.set(cacheKey, buffer);
    }
    playBufferThroughSfx(buffer, volume, 0);
  }

  /** Stop+disconnect a bgm slot's live source/gain, optionally cross-fading
   *  the gain to 0 first (fire-and-forget timer — the slot itself may
   *  already be gone or replaced by the time it fires). */
  function releaseBgmSlot(slot, fadeMs) {
    if (!slot) return;
    const now = ctx.currentTime;
    if (fadeMs > 0) {
      slot.gain.gain.cancelScheduledValues(now);
      slot.gain.gain.setValueAtTime(slot.gain.gain.value, now);
      slot.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      setTimeout(() => {
        try {
          slot.source && slot.source.stop();
        } catch {
          /* already stopped */
        }
        slot.source && slot.source.disconnect();
        slot.gain.disconnect();
      }, fadeMs);
    } else {
      try {
        slot.source && slot.source.stop();
      } catch {
        /* already stopped */
      }
      slot.source && slot.source.disconnect();
      slot.gain.disconnect();
    }
  }

  /** Start a fresh BGM track from the top, cross-fading out whatever was
   *  playing before. ctx must already exist. */
  function startBgmTrack(fullKey, loop, fadeMs, volume) {
    const entry = getSndEntry(fullKey);
    if (!entry) return; // unknown/malformed bgm key: silent no-op

    const gain = ctx.createGain();
    const target = clamp01(volume);
    gain.gain.value = fadeMs > 0 ? 0 : target;
    gain.connect(bgmGain);

    const src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.loop = !!loop;
    if (src.loop) {
      src.loopStart = entry.loopStart;
      src.loopEnd = entry.buffer.duration;
    }
    src.connect(gain);
    src.start(0, 0);

    if (fadeMs > 0) {
      const now = ctx.currentTime;
      gain.gain.linearRampToValueAtTime(target, now + fadeMs / 1000);
    }

    releaseBgmSlot(bgm, fadeMs);

    bgm = {
      key: fullKey,
      source: src,
      gain,
      buffer: entry.buffer,
      loop: !!loop,
      loopStart: entry.loopStart,
      startedAt: ctx.currentTime,
      offset: 0,
      paused: false,
    };
  }

  function playBgmImpl(key, loop, fadeMs, volume) {
    const fullKey = "audio:bgm." + key;
    if (bgm && bgm.key === fullKey) return; // already the playing track: no-op (phase kept)
    if (!unlockedFlag) {
      pendingBgm = { key, loop, fadeMs, volume }; // last call wins; started at unlock
      return;
    }
    startBgmTrack(fullKey, loop, fadeMs, volume);
  }

  function stopBgmImpl(fadeMs) {
    pendingBgm = null;
    if (!bgm) return;
    const slot = bgm;
    bgm = null; // slot is gone now — resume after stop must be impossible
    if (ctx) releaseBgmSlot(slot, fadeMs);
  }

  function pauseBgmImpl(paused) {
    if (!bgm) return;
    if (paused) {
      if (bgm.paused) return; // idempotent
      const now = ctx.currentTime;
      let pos = bgm.offset + (now - bgm.startedAt);
      pos = bgm.loop && bgm.buffer.duration > 0 ? pos % bgm.buffer.duration : Math.min(pos, bgm.buffer.duration);
      try {
        bgm.source.stop();
      } catch {
        /* already stopped */
      }
      bgm.source.disconnect();
      bgm.source = null;
      bgm.offset = pos;
      bgm.paused = true;
    } else {
      if (!bgm.paused) return; // idempotent
      const src = ctx.createBufferSource();
      src.buffer = bgm.buffer;
      src.loop = bgm.loop;
      if (bgm.loop) {
        src.loopStart = bgm.loopStart;
        src.loopEnd = bgm.buffer.duration;
      }
      src.connect(bgm.gain);
      src.start(0, bgm.offset);
      bgm.source = src;
      bgm.startedAt = ctx.currentTime;
      bgm.paused = false;
    }
  }

  function setChannelVolumeImpl(channel, volume) {
    const v = clamp01(volume);
    if (channel < 0 || channel > 2) return;
    channelVolume[channel] = v;
    if (!ctx) return; // stored; applied to the gain node once ctx exists
    const node = channel === 0 ? masterGain : channel === 1 ? sfxGain : bgmGain;
    const now = ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(v, now + CHANNEL_RAMP_S);
  }

  /** Resume the AudioContext after the first user gesture, then start any
   *  deferred BGM from the top. Idempotent. */
  function unlockImpl() {
    if (unlockedFlag) {
      if (ctx && ctx.state === "suspended") ctx.resume();
      return;
    }
    const c = ensureCtx();
    if (!c) return;
    unlockedFlag = true;
    if (c.state === "suspended") c.resume();
    if (pendingBgm) {
      const p = pendingBgm;
      pendingBgm = null;
      startBgmTrack("audio:bgm." + p.key, p.loop, 0, p.volume);
    }
  }

  /** Host-only teardown for reload (not part of AudioOps): stop BGM and
   *  close the AudioContext so a reloaded demo starts from a clean graph. */
  function dispose() {
    pendingBgm = null;
    if (bgm) {
      const slot = bgm;
      bgm = null;
      try {
        slot.source && slot.source.stop();
      } catch {
        /* already stopped */
      }
    }
    if (ctx) {
      try {
        ctx.close();
      } catch {
        /* already closed */
      }
    }
    ctx = null;
    masterGain = null;
    sfxGain = null;
    bgmGain = null;
    unlockedFlag = false;
    sndCache.clear();
    synthCache.clear();
    warned.clear();
  }

  return {
    playSfx: playSfxImpl,
    playSynth: playSynthImpl,
    playBgm: playBgmImpl,
    stopBgm: stopBgmImpl,
    pauseBgm: pauseBgmImpl,
    setChannelVolume: setChannelVolumeImpl,
    __unlock: unlockImpl,
    dispose,
  };
}
