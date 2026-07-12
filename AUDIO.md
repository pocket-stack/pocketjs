# Pocket Audio — SFX, BGM and a tiny synth as a host surface

PocketJS is a **closed, deterministic world** (see DETERMINISM.md): frame
content is a pure function of frame index + inputs, and byte-exact goldens
rely on it. Audio is inherently side-effecting wall-clock output, so it lives
**entirely outside the core** as its own surface:

- Mounted as **`globalThis.audio`** — not `ui.*`. Every `ui.*` op maps 1:1 to
  a `pocketjs_core::Ui` method; audio has *no* core implementation, no wasm
  export, no DrawList op, and never will.
- **Capability = surface** (RUNTIMES.md): a host that doesn't mount
  `globalThis.audio` gives the guest no way to make noise. Goldens, input
  tapes and headless test hosts never mount it, so replay stays byte-exact by
  construction — the same contract as the DevTools ops (18–22).
- All ops are **synchronous fire-and-forget**: they enqueue intent and return
  `undefined`. Nothing about playback state ever flows back into the guest.

## The surface (spec ops 26–31)

Op codes are pinned in `spec/spec.ts` `OP` (append-only, shared registry with
the `ui` surface; `test/contract.ts` guards drift). Sounds are identified by
**string key** — the bare `name` from `sounds.json`, resolved host-side to a
pak entry (`audio:sfx.<name>` / `audio:bgm.<name>`), mirroring
`loadTileTexture`.

| op | JS (`audio.*`) | semantics |
|---|---|---|
| 26 | `playSfx(key, volume, pan)` | one-shot SFX from the pak. `volume` 0..1 (multiplied by sfx × master gain), `pan` −1..1 (0 = center). Unknown key: silent no-op. |
| 27 | `playSynth(wave, freq, freqEnd, durMs, attackMs, releaseMs, volume)` | one-shot procedural voice. `wave` = `ENUMS.Waveform` ordinal; linear frequency sweep `freq → freqEnd` Hz over `durMs`; linear attack/release envelope in ms. Routed through the sfx bus. |
| 28 | `playBgm(key, loop, fadeMs, volume)` | start/switch the (single) music track. `loop` 0\|1; `fadeMs` cross-fades from the current track where the host can, else cuts. Same key as the playing track: no-op (phase is kept). |
| 29 | `stopBgm(fadeMs)` | fade the track to silence and release it. |
| 30 | `pauseBgm(paused)` | freeze / resume the track cursor (idempotent). |
| 31 | `setChannelVolume(channel, volume)` | live bus gain. `channel` = `ENUMS.AudioChannel` ordinal: 0 master, 1 sfx, 2 bgm. Hosts ramp ~10 ms to avoid clicks. |

Plus one dunder, web-only: `__unlock()` — resume the `AudioContext` after the
first user gesture (see *Hosts* below).

## Using it — `@pocketjs/framework/audio`

PocketJS runtime APIs come from `@pocketjs/framework/*`; state and control
flow come from your framework package (`solid-js` / `vue`):

```tsx
import { onButtonPress, BTN } from "@pocketjs/framework/input";
import {
  defineSfx, playSfx, playBgm, setVolume, setMuted,
} from "@pocketjs/framework/audio";

// A code-defined retro blip — no asset, no pak entry.
defineSfx("blip", { wave: "square", freq: 880, durMs: 40, releaseMs: 20 });

playBgm("theme1", { loop: true, fadeMs: 300 }); // baked from sounds.json
onButtonPress(BTN.X, () => playSfx("blip"));    // resolves the defineSfx
onButtonPress(BTN.SELECT, () => setMuted(true));
```

### API reference

Every function returns `void` and is a **silent no-op when the host has no
audio** — apps must never branch on audio availability (see *Determinism*).

| function | behavior |
|---|---|
| `playSfx(name, opts?)` | `opts: { volume?: 0..1 = 1, pan?: −1..1 = 0 }`. If `name` was registered with `defineSfx`, routes to `playSynth`; otherwise plays the pak SFX `audio:sfx.<name>`. |
| `defineSfx(name, desc)` | register a `SynthDesc` under a name. Re-defining replaces. Registrations live in app JS only — nothing is baked or shipped. |
| `playSynth(desc)` | play an unnamed `SynthDesc` immediately. |
| `playBgm(name, opts?)` | `opts: { loop? = true, fadeMs? = 0, volume? = 1 }`. Plays `audio:bgm.<name>`; switching tracks cross-fades over `fadeMs`; calling with the already-playing name is a no-op. |
| `pauseBgm()` / `resumeBgm()` | freeze/unfreeze the track cursor. Idempotent; `resumeBgm()` after `stopBgm()` is a no-op (the track is gone). |
| `stopBgm(opts?)` | `opts: { fadeMs? = 0 }`. |
| `setVolume(channel, v)` | `channel: "master" \| "sfx" \| "bgm"`, `v` clamped to 0..1. Applied live to playing sounds. |
| `getVolume(channel)` | the runtime-held value (identical on every host — it is *not* read back from hardware). |
| `setMuted(on)` / `isMuted()` | runtime-level: mute pushes master gain 0 to the host and remembers the user's master volume; unmute restores it. |
| `audioSupported()` | whether an audio host is mounted. **Presentation only** — use it to grey out a volume slider, never to branch app state. |

Volumes compose multiplicatively: a `playSfx` at `volume: 0.5` on an sfx bus
at `0.8` with master `1.0` plays at 0.4.

### `SynthDesc` — the 8-bit palette

```ts
interface SynthDesc {
  wave: "square" | "pulse25" | "pulse12" | "triangle" | "saw" | "sine" | "noise";
  freq: number;        // Hz at note-on
  freqEnd?: number;    // Hz at note-off (linear sweep); default = freq
  durMs: number;       // total voice length, envelope included
  attackMs?: number;   // linear fade-in;  default 0
  releaseMs?: number;  // linear fade-out; default 15 (click-free tail)
  volume?: number;     // 0..1, default 1
}
```

`pulse25`/`pulse12` are 25 % / 12.5 % duty pulses; `noise` is a 15-bit LFSR.
Both hosts render a descriptor with the **same waveform math** (the PSP mixer
generates it per-sample; the web host pre-renders it once into a cached
`AudioBuffer`), so a blip sounds the same everywhere. Descriptors travel as
op numbers — a synth sound costs zero pak bytes.

Sweep + envelope cover the classic vocabulary: laser = `square` 1760→110 Hz,
pickup = `pulse25` 440→880 Hz, explosion = `noise` with a long release.

## Assets — `sounds.json` → SND pak entries

Sound files are baked at build time so the PSP does **zero decoding**. Add an
optional `<appDir>/sounds.json` (same pattern as `sprites.json`):

```json
{
  "click.wav":  { "name": "click" },
  "theme1.wav": { "name": "theme1", "bgm": true, "loop": true, "loopStart": 0, "rate": 22050 }
}
```

Files resolve against `<appDir>`, `assets/sounds/`, then `assets/`. Each
entry is decoded (RIFF/WAVE, PCM 8/16-bit), downmixed to mono, resampled to
`rate` (default 22050 Hz), and packed as an SND pak entry under
`audio:sfx.<name>` or (with `"bgm": true`) `audio:bgm.<name>`. Old hosts skip
unknown `audio:` keys — forward compatible.

SND entry layout (constants in `spec/spec.ts`):

| off | field | value |
|---|---|---|
| 0 | `u32 magic` | `0x44534B50` (`'PKSD'`) |
| 4 | `u16 version` | 1 |
| 6 | `u16 flags` | bit 0 = loop (BGM loops from `loopStart`) |
| 8 | `u32 sampleRate` | 22050 default, 11025 allowed |
| 12 | `u32 frameCount` | mono sample count |
| 16 | `u32 loopStart` | sample index (iff loop flag) |
| 20 | `u32 reserved` | 0 |
| 24 | data | `frameCount` × s16 LE mono |

**Budget:** the pak is `include_bytes!`-ed into the EBOOT's `.rodata`, so BGM
costs binary size, not heap. 22050 Hz s16 mono = 44.1 KB/s → 1 MB ≈ 23 s
(11025 Hz halves that). v1 rule: **BGM = loopable chiptune-length clips,
≤ ~1 MB per track** — the build warns above that. ADPCM compression is future
work (the `version` field is the hinge); real streaming (ms0:/UMD IO) is
explicitly out of scope.

## Hosts

| host | implementation |
|---|---|
| browser (`host-web/audio.js`) | WebAudio: `master → destination`, `sfx`/`bgm` `GainNode` buses; SFX/BGM are `AudioBufferSourceNode`s built straight from the SND PCM (no `decodeAudioData`); fades are `linearRampToValueAtTime`. **Autoplay is a browser policy, not a bug:** the context starts locked; the engine unlocks on the first keydown/pointerdown. Until then SFX are dropped and the last `playBgm` is remembered and started (from the top) at unlock. |
| PSP (`native/src/audio.rs`) | one hardware channel (44100 Hz stereo, reserved once at boot) + a software mixer thread (priority above the main worker, 1024-sample blocks ≈ 23 ms). Fixed pool of 8 voices (4 SFX + 1 BGM + 3 synth), **oldest-of-kind stealing** when full. The mixer is allocation-free and integer-only (Q15 gains, 16.16 phase accumulators); PCM plays directly from `.rodata`. JS ops push into a lock-free SPSC command ring. Trigger→ear ≈ 25–45 ms. Cost: < 2 % of the 333 MHz CPU at full polyphony. |
| sim (`host-sim/`) | a recorder: every op appends `{ t: "audio", frame, op, args }` to `Trace.audio`, so journeys can assert *when* sounds fire — deterministically. |
| goldens / tapes / QuickJS-headless | nothing mounted → every runtime call is one null-check no-op. Zero test churn. |

PPSSPP renders the same channel-API path; its blocking-output timing is
emulated, so tune latency on hardware (psplink), not by ear in the emulator.

## Determinism contract

1. Audio never enters replayable core state — no `Ui` method, no wasm export,
   no DrawList op. `bun run golden` and `bun run tape:check` are unchanged by
   this feature, byte for byte.
2. The *command stream* is deterministic even though the *output* is not:
   the sim host records it, and `test/sim.test.ts` asserts a chaos run and a
   clean run produce identical `Trace.audio` — same ops, same frames.
3. `getVolume`/`isMuted` read runtime-owned JS state, never hardware. Apps
   must not branch app state on `audioSupported()` — a muted PSP and a
   browser tab must stay pixel-identical.

## What v1 explicitly punts

Per-SFX handles (stop/retune a playing one-shot — add later as
generation-tagged handles, the `freeTexture` pattern), streamed or
ADPCM-compressed BGM, 3D/positional audio, DSP effect chains (reverb,
filters, ducking), per-voice priorities.
