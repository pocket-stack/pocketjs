//! PSP native audio mixer — the host side of `globalThis.audio` (AUDIO.md;
//! spec ops 26-31, `spec/spec.ts` OP.playSfx..setChannelVolume). Audio has NO
//! core (`pocketjs-core::Ui`) implementation and never will (AUDIO.md
//! "Determinism contract") — this module is entirely separate from ffi.rs's
//! `ui` surface, wired up by its own `ffi::register_audio`.
//!
//! ## Threading model
//!
//! One hardware channel (44100 Hz stereo, reserved once in `init`) is driven
//! by a dedicated mixer thread, separate from the QuickJS worker thread that
//! owns the arena allocator (`arena.rs`: "Single-threaded (the QuickJS
//! worker), so `static mut` matches the existing style" — that contract is
//! for the ARENA specifically, and this module never calls into it). The two
//! threads talk through a lock-free SPSC command ring (`RING`): the JS thread
//! (inside the `play_*`/`stop_bgm`/`pause_bgm`/`set_bus_volume` ops below)
//! pushes; the mixer thread drains once per 1024-frame block. Everything the
//! mixer thread touches after boot (`VOICES`, `RING`, `BUS_*`, `OUT_BUF`) is
//! either exclusively mixer-thread-owned or synchronized purely through the
//! ring's Acquire/Release atomics — no locks, no shared mutable state that
//! crosses threads any other way.
//!
//! `SOUNDS` (the sound registry) is the one exception: it is filled from
//! `pak::feed` on the BOOT thread before `init()` ever creates the mixer
//! thread (see main.rs's ordering), and is treated as read-only by both
//! threads from that point on — plain `static mut` reads are sound because
//! there is no concurrent writer once the mixer thread exists.
//!
//! ## Allocation / float discipline
//!
//! The mixer thread (`mixer_thread_entry`, `mix_block` and everything it
//! calls) is **allocation-free and integer-only**: no heap, no `format!`, no
//! `Vec`/`Box`, no f32/f64. All state lives in fixed-size `static` arrays;
//! gains are Q15 (`i32`, unity = `Q15_ONE` = 1<<15); PCM/synth phase uses
//! 16.16 or full-`u32` fixed-point accumulators. The handful of f32/f64
//! conversions in this file (`q15_from_unit`, `pan_gains`, `ms_to_samples`,
//! `hz_to_step`) run ONLY on the JS thread, converting JS's f64 args to
//! integers before they ever reach the ring — flagged individually below.
//!
//! ## Voice pool + cross-fade scheme
//!
//! `VOICES` is a fixed `[Voice; 8]`: slots 0..4 are PCM one-shot SFX, slot 4
//! is the single BGM slot, slots 5..8 are procedural synth voices (AUDIO.md's
//! "4 SFX + 1 BGM + 3 synth"). SFX and synth pools do "oldest-of-kind"
//! stealing (`alloc_voice`) via a monotonic per-voice `trigger` counter.
//!
//! BGM only has ONE slot, so a true overlapping cross-fade needs somewhere to
//! put the outgoing track while the new one ramps in. Scheme: when
//! `playBgm(..., fadeMs>0)` arrives and a track is already playing, the OLD
//! voice's playback state is copied into a borrowed SYNTH slot (stolen
//! oldest-of-kind exactly like a real synth trigger would be), retagged
//! `VKind::BgmDying`, and given a linear fade-to-0 that frees the slot when
//! it completes (`die_at_fade_end`). The BGM slot itself is immediately
//! handed to the new track, ramping 0 -> volume over the same window. Net
//! effect: a real overlapping cross-fade using the SAME fixed 8-voice pool —
//! no 9th slot, no second "BGM-capable" slot carved out of the budget. The
//! trade-off (documented, accepted): a `BgmDying` voice can itself be stolen
//! by a genuine synth trigger (or a second rapid `playBgm`) if all 3 synth
//! slots are busy — the old track just cuts a little early in that case,
//! which is a fine failure mode for a fire-and-forget fade.
//!
//! `fadeMs == 0` never allocates a dying voice: the BGM slot is simply
//! overwritten (silent cut), matching the web host's "else cuts" behavior.
//!
//! Pausing (`pauseBgm`) freezes the ENTIRE BGM voice — cursor, fade ramp, the
//! lot — and produces silence while paused (AUDIO.md Hosts table: "BGM pause
//! freezes the cursor (voice stays, produces silence)"); resuming continues
//! exactly where it left off, fade included.

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use psp::sys::{self, AudioFormat, ThreadAttributes, AUDIO_NEXT_CHANNEL, AUDIO_VOLUME_MAX};

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/// Frames per `sceAudioOutputPannedBlocking` call (~23.2 ms @ 44100 Hz) —
/// AUDIO.md "1024-sample blocks ~= 23 ms".
const BLOCK: usize = 1024;
/// Interleaved stereo i16 samples per block.
const MIX_LEN: usize = BLOCK * 2;
/// The one hardware channel always runs at 44100 Hz stereo (rust-psp's plain
/// channel API); SFX/BGM source rates (22050/11025 Hz, SND header) resample
/// UP to this via the 16.16 cursor step.
const OUTPUT_RATE: u32 = 44100;

const NUM_VOICES: usize = 8;
const SFX_START: usize = 0;
const SFX_COUNT: usize = 4;
const BGM_SLOT: usize = 4;
const SYNTH_START: usize = 5;
const SYNTH_COUNT: usize = 3;

/// SPSC command ring capacity (power of two not required — modulo, not mask).
const RING_CAP: usize = 32;

const MAX_SOUNDS: usize = 64;
const MAX_NAME_LEN: usize = 32;

/// Q15 unity gain (gains are 0..=Q15_ONE, never negative — these are volume
/// multipliers, not signed audio samples).
const Q15_ONE: i32 = 1 << 15;

/// setChannelVolume ramp window: "Hosts ramp ~10 ms to avoid clicks"
/// (spec/spec.ts OP.setChannelVolume, AUDIO.md). 44100 * 0.010 ~= 441.
const BUS_RAMP_SAMPLES: u32 = 441;

// SND pak entry format (AUDIO.md / spec/spec.ts SND_*). Not re-exported from
// pocketjs_core::spec (spec/gen-rust.ts hasn't grown SND constants there),
// so these are pinned locally, byte-for-byte identical to spec.ts's values —
// same approach pak.rs already takes for IMG/SPRITE entry sub-fields that
// don't have their own core::spec constants either.
pub(crate) const SND_MAGIC: u32 = 0x4453_4b50; // 'PKSD' LE
pub(crate) const SND_VERSION: u16 = 1;
pub(crate) const SND_HEADER_SIZE: usize = 24;
pub(crate) const SND_FLAG_LOOP: u16 = 1 << 0;

// ---------------------------------------------------------------------------
// waveform (ENUMS.Waveform, spec/spec.ts:419 — ordinals are the wire values)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Waveform {
    Square = 0,
    Pulse25 = 1,
    Pulse12 = 2,
    Triangle = 3,
    Saw = 4,
    Sine = 5,
    Noise = 6,
}

impl Waveform {
    /// Any out-of-range ordinal (a future enum value an old host doesn't know
    /// about yet) falls back to Noise — never panics, never indexes OOB.
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Waveform::Square,
            1 => Waveform::Pulse25,
            2 => Waveform::Pulse12,
            3 => Waveform::Triangle,
            4 => Waveform::Saw,
            5 => Waveform::Sine,
            _ => Waveform::Noise,
        }
    }
}

/// 256-entry full-cycle sine table, `round(sin(2*pi*i/256) * 32767)` —
/// precomputed (no libm on the audio thread). Indexed by the top 8 bits of
/// the 32-bit phase accumulator (`phase >> 24`).
static SINE_LUT: [i16; 256] = [
    0, 804, 1608, 2410, 3212, 4011, 4808, 5602, 6393, 7179, 7962, 8739, 9512, 10278, 11039, 11793,
    12539, 13279, 14010, 14732, 15446, 16151, 16846, 17530, 18204, 18868, 19519, 20159, 20787, 21403, 22005, 22594,
    23170, 23731, 24279, 24811, 25329, 25832, 26319, 26790, 27245, 27683, 28105, 28510, 28898, 29268, 29621, 29956,
    30273, 30571, 30852, 31113, 31356, 31580, 31785, 31971, 32137, 32285, 32412, 32521, 32609, 32678, 32728, 32757,
    32767, 32757, 32728, 32678, 32609, 32521, 32412, 32285, 32137, 31971, 31785, 31580, 31356, 31113, 30852, 30571,
    30273, 29956, 29621, 29268, 28898, 28510, 28105, 27683, 27245, 26790, 26319, 25832, 25329, 24811, 24279, 23731,
    23170, 22594, 22005, 21403, 20787, 20159, 19519, 18868, 18204, 17530, 16846, 16151, 15446, 14732, 14010, 13279,
    12539, 11793, 11039, 10278, 9512, 8739, 7962, 7179, 6393, 5602, 4808, 4011, 3212, 2410, 1608, 804,
    0, -804, -1608, -2410, -3212, -4011, -4808, -5602, -6393, -7179, -7962, -8739, -9512, -10278, -11039, -11793,
    -12539, -13279, -14010, -14732, -15446, -16151, -16846, -17530, -18204, -18868, -19519, -20159, -20787, -21403, -22005, -22594,
    -23170, -23731, -24279, -24811, -25329, -25832, -26319, -26790, -27245, -27683, -28105, -28510, -28898, -29268, -29621, -29956,
    -30273, -30571, -30852, -31113, -31356, -31580, -31785, -31971, -32137, -32285, -32412, -32521, -32609, -32678, -32728, -32757,
    -32767, -32757, -32728, -32678, -32609, -32521, -32412, -32285, -32137, -31971, -31785, -31580, -31356, -31113, -30852, -30571,
    -30273, -29956, -29621, -29268, -28898, -28510, -28105, -27683, -27245, -26790, -26319, -25832, -25329, -24811, -24279, -23731,
    -23170, -22594, -22005, -21403, -20787, -20159, -19519, -18868, -18204, -17530, -16846, -16151, -15446, -14732, -14010, -13279,
    -12539, -11793, -11039, -10278, -9512, -8739, -7962, -7179, -6393, -5602, -4808, -4011, -3212, -2410, -1608, -804,
];

// ---------------------------------------------------------------------------
// sound registry (filled at boot from pak.rs, read-only once the mixer runs)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SoundKind {
    Sfx,
    Bgm,
}

#[derive(Clone, Copy)]
struct SoundReg {
    in_use: bool,
    kind: SoundKind,
    name: [u8; MAX_NAME_LEN],
    name_len: u8,
    // Pointer into APP_PAK's .rodata (include_bytes!, program-lifetime
    // 'static) — see register_sound's safety doc. Never null while in_use.
    ptr: *const i16,
    frames: u32,
    rate: u32,
    // NOTE: the SND header's OWN loop flag is deliberately not stored here —
    // whether an instance loops is entirely the CALLER's decision each time
    // (AUDIO.md playBgm's `loop` argument); `loop_start` is the only baked
    // metadata playback needs, and pak.rs already clamps it to 0 when the
    // header itself wasn't baked with looping in mind.
    loop_start: u32,
}

impl SoundReg {
    const EMPTY: SoundReg = SoundReg {
        in_use: false,
        kind: SoundKind::Sfx,
        name: [0; MAX_NAME_LEN],
        name_len: 0,
        ptr: core::ptr::null(),
        frames: 0,
        rate: 0,
        loop_start: 0,
    };
}

/// Filled once at boot (pak::feed, boot thread) BEFORE `init()` creates the
/// mixer thread — see main.rs's ordering. Plain `static mut` writes here are
/// sound: nothing else touches this table concurrently (module docs).
static mut SOUNDS: [SoundReg; MAX_SOUNDS] = [SoundReg::EMPTY; MAX_SOUNDS];
static mut SOUND_COUNT: usize = 0;

/// Register one SND pak entry. Called from `pak::feed` while walking the
/// pak, on the boot thread, strictly before `init()` — see main.rs.
///
/// # Safety
/// Single-threaded boot contract, same shape as `pak::install`: caller must
/// not call this concurrently with itself or with any mixer-thread read (the
/// mixer thread does not exist yet at the point main.rs calls this). `ptr`
/// must point at `frames` contiguous `i16` LE samples that remain valid for
/// the rest of the program's lifetime (APP_PAK's .rodata satisfies this).
pub unsafe fn register_sound(
    kind: SoundKind,
    name: &str,
    ptr: *const i16,
    frames: u32,
    rate: u32,
    loop_start: u32,
) {
    let bytes = name.as_bytes();
    if bytes.len() > MAX_NAME_LEN || SOUND_COUNT >= MAX_SOUNDS {
        return; // too long / registry full: skip silently (pak.rs convention)
    }
    let slot = &mut SOUNDS[SOUND_COUNT];
    slot.in_use = true;
    slot.kind = kind;
    slot.name = [0; MAX_NAME_LEN];
    slot.name[..bytes.len()].copy_from_slice(bytes);
    slot.name_len = bytes.len() as u8;
    slot.ptr = ptr;
    slot.frames = frames;
    slot.rate = if rate == 0 { OUTPUT_RATE } else { rate };
    slot.loop_start = loop_start;
    SOUND_COUNT += 1;
}

/// Linear scan (registry is <= 64 entries, looked up only on `play*` calls,
/// never per-sample) — mirrors pak::find's "callers cache the handle, not
/// the lookup" comment, except here the JS runtime just calls by name every
/// time (AUDIO.md ops are fire-and-forget), so this stays O(entries) by
/// design.
unsafe fn find_sound(kind: SoundKind, name: &str) -> Option<SoundReg> {
    let bytes = name.as_bytes();
    for i in 0..SOUND_COUNT {
        let s = SOUNDS[i];
        if s.in_use && s.kind == kind && s.name_len as usize == bytes.len() && &s.name[..bytes.len()] == bytes {
            return Some(s);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// SPSC command ring (JS thread pushes, mixer thread drains)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Cmd {
    None,
    PlaySfx {
        ptr: *const i16,
        frames: u32,
        rate: u32,
        vol_q15: i32,
        pan_l_q15: i32,
        pan_r_q15: i32,
    },
    PlaySynth {
        wave: Waveform,
        step0: u32,
        step1: u32,
        total_samples: u32,
        attack_samples: u32,
        release_samples: u32,
        vol_q15: i32,
    },
    PlayBgm {
        ptr: *const i16,
        frames: u32,
        rate: u32,
        loop_flag: bool,
        loop_start: u32,
        fade_samples: u32,
        vol_q15: i32,
    },
    StopBgm {
        fade_samples: u32,
    },
    PauseBgm {
        paused: bool,
    },
    SetBusVolume {
        bus: usize,
        vol_q15: i32,
    },
}

static mut RING: [Cmd; RING_CAP] = [Cmd::None; RING_CAP];
/// Written only by the producer (JS thread); read by the consumer via
/// Acquire to observe the paired Release store's slot write.
static RING_HEAD: AtomicUsize = AtomicUsize::new(0);
/// Written only by the consumer (mixer thread); read by the producer via
/// Acquire to know how much room is free.
static RING_TAIL: AtomicUsize = AtomicUsize::new(0);

/// Push one command. Never blocks: a full ring silently drops the command
/// (AUDIO.md "synchronous fire-and-forget" — dropping under extreme command
/// pressure is strictly better than stalling the JS thread).
///
/// # Safety
/// Must only be called from the single JS-thread producer (never
/// concurrently with itself).
unsafe fn ring_push(cmd: Cmd) {
    let head = RING_HEAD.load(Ordering::Relaxed); // sole writer of HEAD
    let tail = RING_TAIL.load(Ordering::Acquire); // syncs with the consumer's Release store below
    let next = (head + 1) % RING_CAP;
    if next == tail {
        return; // full: drop
    }
    RING[head] = cmd;
    RING_HEAD.store(next, Ordering::Release); // publishes the slot write above to the consumer
}

/// Drain every pending command. Called once per block from the mixer
/// thread.
///
/// # Safety
/// Must only be called from the single mixer-thread consumer.
unsafe fn ring_drain_all() {
    loop {
        let tail = RING_TAIL.load(Ordering::Relaxed); // sole writer of TAIL
        let head = RING_HEAD.load(Ordering::Acquire); // syncs with the producer's Release store
        if tail == head {
            break;
        }
        let cmd = RING[tail];
        apply_cmd(cmd);
        RING_TAIL.store((tail + 1) % RING_CAP, Ordering::Release); // publishes the free slot to the producer
    }
}

// ---------------------------------------------------------------------------
// voice pool
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum VKind {
    Free,
    Sfx,
    Bgm,
    /// An outgoing BGM track fading out in a BORROWED synth slot — see the
    /// module doc's cross-fade scheme.
    BgmDying,
    Synth,
}

#[derive(Clone, Copy)]
struct Voice {
    kind: VKind,
    /// Monotonic trigger counter for oldest-of-kind stealing (`alloc_voice`).
    trigger: u32,

    // -- PCM playback (Sfx, Bgm, BgmDying) --
    ptr: *const i16,
    frames: u32,
    /// 16.16 fixed-point index into the source PCM (integer part = sample).
    cursor: u32,
    /// 16.16 per-output-sample cursor increment = `source_rate * 65536 / 44100`.
    step: u32,
    loop_flag: bool,
    loop_start: u32,
    /// BGM (and its BgmDying copy) only: freezes cursor + fade + output.
    paused: bool,

    // -- synth --
    wave: Waveform,
    /// Phase accumulator: the full `u32` range is one waveform cycle
    /// (`phase >> 24` indexes the 256-entry sine LUT; `phase >> 16` gives a
    /// 16-bit 0..65536 fraction-of-cycle for the duty/ramp waveforms).
    phase: u32,
    freq_step0: u32,
    freq_step1: u32,
    total_samples: u32,
    attack_samples: u32,
    release_samples: u32,
    elapsed: u32,
    /// 15-bit Galois LFSR state for the noise waveform (never 0).
    lfsr: u16,
    /// Static per-voice volume (multiplies the envelope for synth voices).
    vol_q15: i32,

    // -- generic linear gain ramp (Sfx: constant, no ramp; Bgm/BgmDying: the
    //    cross-fade / stop-fade ramps) --
    gain_cur: i32,
    gain_target: i32,
    gain_step: i32,
    fade_remaining: u32,
    die_at_fade_end: bool,

    // -- pan (Sfx only; Bgm/Synth/BgmDying stay centered, both Q15_ONE) --
    pan_l_q15: i32,
    pan_r_q15: i32,
}

impl Voice {
    const EMPTY: Voice = Voice {
        kind: VKind::Free,
        trigger: 0,
        ptr: core::ptr::null(),
        frames: 0,
        cursor: 0,
        step: 0,
        loop_flag: false,
        loop_start: 0,
        paused: false,
        wave: Waveform::Square,
        phase: 0,
        freq_step0: 0,
        freq_step1: 0,
        total_samples: 0,
        attack_samples: 0,
        release_samples: 0,
        elapsed: 0,
        lfsr: 0xACE1,
        vol_q15: 0,
        gain_cur: 0,
        gain_target: 0,
        gain_step: 0,
        fade_remaining: 0,
        die_at_fade_end: false,
        pan_l_q15: Q15_ONE,
        pan_r_q15: Q15_ONE,
    };
}

/// Mixer-thread-owned after boot (see module docs); the JS thread never
/// touches this array directly, only through `RING` commands.
static mut VOICES: [Voice; NUM_VOICES] = [Voice::EMPTY; NUM_VOICES];
static mut TRIGGER: u32 = 0;

/// Live bus gains: [Master, Sfx, Bgm] (ENUMS.AudioChannel ordinals). Ramped
/// over BUS_RAMP_SAMPLES on every `setChannelVolume` (click guard).
static mut BUS_CUR: [i32; 3] = [Q15_ONE, Q15_ONE, Q15_ONE];
static mut BUS_TARGET: [i32; 3] = [Q15_ONE, Q15_ONE, Q15_ONE];
static mut BUS_STEP: [i32; 3] = [0, 0, 0];
static mut BUS_REMAINING: [u32; 3] = [0, 0, 0];

/// False until `init()` fully succeeds (channel reserved + mixer thread
/// started). Every `play_*`/`stop_bgm`/`pause_bgm`/`set_bus_volume` op checks
/// this FIRST — a boot failure must not change guest-visible shape, so ops
/// just silently no-op forever instead (AUDIO.md capability-as-surface
/// contract: the ops still exist as functions, they just do nothing).
static READY: AtomicBool = AtomicBool::new(false);

static mut OUT_BUF: [i16; MIX_LEN] = [0; MIX_LEN];
static mut CHANNEL: i32 = -1;

// ---------------------------------------------------------------------------
// integer-only helpers (audio thread AND JS thread both use these — no
// float, safe to share)
// ---------------------------------------------------------------------------

#[inline]
fn q15_mul(a: i32, b: i32) -> i32 {
    (((a as i64) * (b as i64)) >> 15) as i32
}

#[inline]
fn clamp_i16(v: i32) -> i16 {
    if v > i16::MAX as i32 {
        i16::MAX
    } else if v < i16::MIN as i32 {
        i16::MIN
    } else {
        v as i16
    }
}

/// Per-sample ramp step from `from` to `to` over `samples` samples. Floors
/// to +/-1 when integer division truncates a nonzero difference to 0 (a huge
/// `samples` count with a tiny gain delta) so the ramp is still monotonic and
/// visibly moving rather than appearing frozen; `advance_fade`/
/// `advance_bus_ramps` clamp against overshoot, and both always snap exactly
/// to `to` when their remaining-count reaches 0, so this floor never causes
/// the final value to be wrong — only (rarely) to arrive a few samples early.
#[inline]
fn fade_step(from: i32, to: i32, samples: u32) -> i32 {
    if samples == 0 {
        return 0;
    }
    let diff = to as i64 - from as i64;
    let mut step = diff / samples as i64;
    if step == 0 && diff != 0 {
        step = if diff > 0 { 1 } else { -1 };
    }
    step as i32
}

/// 16.16 fixed-point per-output-sample cursor step for resampling `rate` Hz
/// mono PCM up to the fixed 44100 Hz hardware channel (nearest-neighbor —
/// no interpolation; simplest correct choice for an allocation-free,
/// integer-only mixer, and plenty for chiptune-grade source material).
fn rate_step(rate: u32) -> u32 {
    let rate = if rate == 0 { OUTPUT_RATE } else { rate };
    (((rate as u64) << 16) / OUTPUT_RATE as u64) as u32
}

/// Linear-interpolate a synth voice's phase step between its start/end sweep
/// values across its whole lifetime. i64 math only (b-a can be negative for
/// downward sweeps).
#[inline]
fn lerp_u32(a: u32, b: u32, t: u32, total: u32) -> u32 {
    if total == 0 {
        return b;
    }
    let a = a as i64;
    let b = b as i64;
    let t = t as i64;
    let total = total as i64;
    (a + (b - a) * t / total) as u32
}

/// Linear attack -> full sustain -> linear release envelope, in Q15. `attack`
/// and `release` are clamped into `[0, total]` by the caller (`play_synth`)
/// before this ever runs, so `release_start` never goes negative.
#[inline]
fn envelope_q15(elapsed: u32, total: u32, attack: u32, release: u32) -> i32 {
    if attack > 0 && elapsed < attack {
        return ((elapsed as i64 * Q15_ONE as i64) / attack as i64) as i32;
    }
    let release_start = total.saturating_sub(release);
    if release > 0 && elapsed >= release_start {
        let into = elapsed - release_start;
        let remain = release.saturating_sub(into);
        return ((remain as i64 * Q15_ONE as i64) / release as i64) as i32;
    }
    Q15_ONE
}

// ---------------------------------------------------------------------------
// JS-thread helpers (f32/f64 math — NEVER called from the mixer thread)
// ---------------------------------------------------------------------------

/// Clamp 0..1 and scale to Q15. `f32::clamp`/comparisons are plain
/// hardware/softfloat ops, not transcendental — no libm needed, and this
/// only ever runs on the JS thread (which has FPU/VFPU access; see host.rs).
fn q15_from_unit(v: f32) -> i32 {
    let c = if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    (c * Q15_ONE as f32) as i32
}

/// Linear (not constant-power) L/R split from a -1..1 pan value — AUDIO.md's
/// mixer entry explicitly allows this ("Linear L/R split is fine"). At
/// pan=0 both channels are full (Q15_ONE); at the extremes one channel goes
/// to 0 while the other stays full.
fn pan_gains(p: f32) -> (i32, i32) {
    let p = if p.is_finite() { p.clamp(-1.0, 1.0) } else { 0.0 };
    let l = (1.0 - p).clamp(0.0, 1.0);
    let r = (1.0 + p).clamp(0.0, 1.0);
    (q15_from_unit(l), q15_from_unit(r))
}

fn ms_to_samples(ms: f32) -> u32 {
    if !ms.is_finite() || ms <= 0.0 {
        return 0;
    }
    (ms * (OUTPUT_RATE as f32) / 1000.0) as u32
}

/// Per-sample phase increment for a `hz` Hz waveform against the full `u32`
/// phase wheel (one cycle = 2^32). f64 (not f32) avoids precision loss at
/// this magnitude; still plain arithmetic, no libm.
fn hz_to_step(hz: f32) -> u32 {
    let hz = if hz.is_finite() && hz > 0.0 { hz as f64 } else { 0.0 };
    let v = hz * 4294967296.0 / (OUTPUT_RATE as f64);
    if v <= 0.0 {
        0
    } else if v >= 4294967295.0 {
        u32::MAX
    } else {
        v as u64 as u32
    }
}

// ---------------------------------------------------------------------------
// mixer thread: init + entry
// ---------------------------------------------------------------------------

/// Reserve the hardware channel and start the mixer thread. Called once from
/// main.rs, after `pak::install` (so `register_sound` has already filled the
/// registry) and before `JS_Eval`. Returns whether audio is actually live;
/// `ffi::register_audio` is called unconditionally regardless of the result
/// (see `READY`'s doc comment) — a boot failure here must not change the
/// guest-visible shape of `globalThis.audio`.
///
/// # Safety
/// Must be called exactly once, from the boot thread, before any `play_*`/
/// `register_sound` call and before the mixer thread could possibly exist.
pub unsafe fn init() -> bool {
    let ch = sys::sceAudioChReserve(AUDIO_NEXT_CHANNEL, BLOCK as i32, AudioFormat::Stereo);
    if ch < 0 {
        return false;
    }
    CHANNEL = ch;
    let id = sys::sceKernelCreateThread(
        b"pocketjs_audio\0".as_ptr(),
        mixer_thread_entry,
        16,          // priority: numerically below (PSP: lower = scheduled first)
        //             the main worker's 32 (host.rs run_on_worker)
        32 * 1024,   // 32 KB stack: allocation-free integer mixing needs little
        ThreadAttributes::USER, // NO VFPU: the mixer thread never touches f32/f64
        core::ptr::null_mut(),
    );
    if id.0 < 0 {
        sys::sceAudioChRelease(CHANNEL);
        CHANNEL = -1;
        return false;
    }
    sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
    READY.store(true, Ordering::Release);
    true
}

unsafe extern "C" fn mixer_thread_entry(_argc: usize, _argv: *mut c_void) -> i32 {
    loop {
        mix_block();
    }
}

/// Drain commands, mix one 1024-frame stereo block, output it. The ENTIRE
/// call tree from here down is allocation-free and integer-only (module
/// docs) — this is the only function the mixer thread ever calls in steady
/// state.
unsafe fn mix_block() {
    ring_drain_all();
    for i in 0..BLOCK {
        advance_bus_ramps();
        let master = BUS_CUR[0];
        let sfx_bus = BUS_CUR[1];
        let bgm_bus = BUS_CUR[2];
        let mut acc_l: i32 = 0;
        let mut acc_r: i32 = 0;
        for vi in 0..NUM_VOICES {
            let kind = VOICES[vi].kind;
            if kind == VKind::Free {
                continue;
            }
            let bus = match kind {
                VKind::Sfx | VKind::Synth => sfx_bus,
                VKind::Bgm | VKind::BgmDying => bgm_bus,
                VKind::Free => unreachable!(),
            };
            if let Some((sample, pan_l, pan_r)) = sample_voice(vi, kind) {
                let g_l = q15_mul(q15_mul(bus, master), pan_l);
                let g_r = q15_mul(q15_mul(bus, master), pan_r);
                acc_l += q15_mul(sample, g_l);
                acc_r += q15_mul(sample, g_r);
            }
        }
        OUT_BUF[i * 2] = clamp_i16(acc_l);
        OUT_BUF[i * 2 + 1] = clamp_i16(acc_r);
    }
    if CHANNEL >= 0 {
        // Hardware volume pinned to max — ALL gain (voice/envelope/fade/bus/
        // pan/master) is already baked into OUT_BUF by the software mix
        // above (AUDIO.md mixer entry pseudocode).
        sys::sceAudioOutputPannedBlocking(
            CHANNEL,
            AUDIO_VOLUME_MAX as i32,
            AUDIO_VOLUME_MAX as i32,
            OUT_BUF.as_mut_ptr() as *mut c_void,
        );
    }
}

unsafe fn advance_bus_ramps() {
    for b in 0..3 {
        if BUS_REMAINING[b] > 0 {
            BUS_CUR[b] = BUS_CUR[b].saturating_add(BUS_STEP[b]);
            if BUS_STEP[b] >= 0 {
                if BUS_CUR[b] > BUS_TARGET[b] {
                    BUS_CUR[b] = BUS_TARGET[b];
                }
            } else if BUS_CUR[b] < BUS_TARGET[b] {
                BUS_CUR[b] = BUS_TARGET[b];
            }
            BUS_REMAINING[b] -= 1;
            if BUS_REMAINING[b] == 0 {
                BUS_CUR[b] = BUS_TARGET[b];
            }
        }
    }
}

/// Advance one active voice by one output sample; returns
/// `Some((gain-scaled sample, pan_l_q15, pan_r_q15))`, or `None` if the voice
/// just finished (and was deactivated).
unsafe fn sample_voice(vi: usize, kind: VKind) -> Option<(i32, i32, i32)> {
    match kind {
        VKind::Free => None,
        VKind::Sfx => sample_sfx(vi),
        VKind::Bgm | VKind::BgmDying => sample_bgm(vi),
        VKind::Synth => sample_synth(vi),
    }
}

unsafe fn sample_sfx(vi: usize) -> Option<(i32, i32, i32)> {
    let v = &mut VOICES[vi];
    let idx = v.cursor >> 16;
    if idx >= v.frames {
        v.kind = VKind::Free;
        return None;
    }
    // SAFETY: `v.ptr` points into an SND entry's PCM region inside APP_PAK's
    // .rodata (register_sound's contract); `idx < v.frames` was just
    // checked, and `frames` is exactly the SND header's frameCount used to
    // bound-check the entry at registration time (pak.rs's register_snd_entry).
    let raw = *v.ptr.add(idx as usize) as i32;
    v.cursor = v.cursor.wrapping_add(v.step);
    let sample = q15_mul(raw, v.gain_cur); // constant for Sfx: no ramp
    Some((sample, v.pan_l_q15, v.pan_r_q15))
}

unsafe fn sample_bgm(vi: usize) -> Option<(i32, i32, i32)> {
    let v = &mut VOICES[vi];
    if v.paused {
        // Freeze cursor AND fade: AUDIO.md "voice stays, produces silence".
        return Some((0, Q15_ONE, Q15_ONE));
    }
    let mut idx = v.cursor >> 16;
    if idx >= v.frames {
        if !(v.loop_flag && v.frames > v.loop_start) {
            v.kind = VKind::Free;
            return None;
        }
        let loop_len = v.frames - v.loop_start;
        v.cursor = v.cursor.wrapping_sub(loop_len << 16);
        idx = v.cursor >> 16;
        if idx >= v.frames {
            // Malformed loop metadata (shouldn't happen — pak.rs validates
            // loop_start < frames at registration): bail instead of spinning.
            v.kind = VKind::Free;
            return None;
        }
    }
    // SAFETY: same .rodata contract as sample_sfx; idx bound-checked above.
    let raw = *v.ptr.add(idx as usize) as i32;
    v.cursor = v.cursor.wrapping_add(v.step);
    advance_fade(v);
    Some((q15_mul(raw, v.gain_cur), Q15_ONE, Q15_ONE)) // BGM never pans
}

unsafe fn sample_synth(vi: usize) -> Option<(i32, i32, i32)> {
    let v = &mut VOICES[vi];
    if v.elapsed >= v.total_samples {
        v.kind = VKind::Free;
        return None;
    }
    let env = envelope_q15(v.elapsed, v.total_samples, v.attack_samples, v.release_samples);
    let step = lerp_u32(v.freq_step0, v.freq_step1, v.elapsed, v.total_samples);
    let raw = waveform_sample(v);
    v.phase = v.phase.wrapping_add(step);
    v.elapsed += 1;
    let gain = q15_mul(env, v.vol_q15);
    Some((q15_mul(raw, gain), Q15_ONE, Q15_ONE)) // playSynth has no pan arg (spec)
}

/// Generate one raw (pre-gain) sample for the voice's waveform at its
/// current phase; advances the LFSR for Noise (the only waveform with
/// state beyond the shared phase accumulator).
unsafe fn waveform_sample(v: &mut Voice) -> i32 {
    const AMP: i32 = i16::MAX as i32;
    let frac16 = (v.phase >> 16) as i32; // 0..65535: position within the cycle
    match v.wave {
        Waveform::Square => {
            if frac16 < 32768 {
                AMP
            } else {
                -AMP
            }
        }
        Waveform::Pulse25 => {
            if frac16 < 16384 {
                AMP
            } else {
                -AMP
            }
        }
        Waveform::Pulse12 => {
            if frac16 < 8192 {
                AMP
            } else {
                -AMP
            }
        }
        Waveform::Triangle => {
            if frac16 < 32768 {
                -AMP + (frac16 * 2 * AMP) / 32768
            } else {
                AMP - ((frac16 - 32768) * 2 * AMP) / 32768
            }
        }
        Waveform::Saw => -AMP + (frac16 * 2 * AMP) / 65536,
        Waveform::Sine => SINE_LUT[(v.phase >> 24) as usize] as i32,
        Waveform::Noise => {
            // 15-bit Galois LFSR (AUDIO.md / spec task): x = (x>>1) |
            // (((x^(x>>1))&1)<<14). Output = current bit 0, THEN advance —
            // order doesn't matter perceptually, just needs to be consistent.
            let bit = v.lfsr & 1;
            let x = v.lfsr;
            v.lfsr = (x >> 1) | (((x ^ (x >> 1)) & 1) << 14);
            if v.lfsr == 0 {
                v.lfsr = 0xACE1; // never let it lock into the all-zero state
            }
            if bit != 0 {
                AMP
            } else {
                -AMP
            }
        }
    }
}

/// Advance a BGM/BgmDying voice's linear gain ramp by one sample. Clamps
/// against overshoot (see `fade_step`'s floor-to-+/-1 comment) and, on
/// completion, snaps exactly to `gain_target` and frees the voice if
/// `die_at_fade_end`.
unsafe fn advance_fade(v: &mut Voice) {
    if v.fade_remaining > 0 {
        v.gain_cur = v.gain_cur.saturating_add(v.gain_step);
        if v.gain_step >= 0 {
            if v.gain_cur > v.gain_target {
                v.gain_cur = v.gain_target;
            }
        } else if v.gain_cur < v.gain_target {
            v.gain_cur = v.gain_target;
        }
        v.fade_remaining -= 1;
        if v.fade_remaining == 0 {
            v.gain_cur = v.gain_target;
            if v.die_at_fade_end {
                v.kind = VKind::Free;
            }
        }
    }
}

fn next_trigger() -> u32 {
    unsafe {
        TRIGGER = TRIGGER.wrapping_add(1);
        TRIGGER
    }
}

/// Find a free slot in `[start, start+count)`, else steal the oldest (lowest
/// `trigger`) one — AUDIO.md "oldest-of-kind stealing when a kind's slots
/// are full".
unsafe fn alloc_voice(start: usize, count: usize) -> usize {
    for i in start..start + count {
        if VOICES[i].kind == VKind::Free {
            return i;
        }
    }
    let mut oldest = start;
    let mut oldest_trigger = VOICES[start].trigger;
    for i in start + 1..start + count {
        if VOICES[i].trigger < oldest_trigger {
            oldest = i;
            oldest_trigger = VOICES[i].trigger;
        }
    }
    oldest
}

// ---------------------------------------------------------------------------
// command application (mixer thread only — called from ring_drain_all)
// ---------------------------------------------------------------------------

unsafe fn apply_cmd(cmd: Cmd) {
    match cmd {
        Cmd::None => {}
        Cmd::PlaySfx { ptr, frames, rate, vol_q15, pan_l_q15, pan_r_q15 } => {
            let slot = alloc_voice(SFX_START, SFX_COUNT);
            let v = &mut VOICES[slot];
            *v = Voice::EMPTY;
            v.kind = VKind::Sfx;
            v.trigger = next_trigger();
            v.ptr = ptr;
            v.frames = frames;
            v.step = rate_step(rate);
            v.gain_cur = vol_q15; // constant, no ramp for one-shot SFX
            v.gain_target = vol_q15;
            v.pan_l_q15 = pan_l_q15;
            v.pan_r_q15 = pan_r_q15;
        }
        Cmd::PlaySynth { wave, step0, step1, total_samples, attack_samples, release_samples, vol_q15 } => {
            let slot = alloc_voice(SYNTH_START, SYNTH_COUNT);
            let v = &mut VOICES[slot];
            *v = Voice::EMPTY;
            v.kind = VKind::Synth;
            v.trigger = next_trigger();
            v.wave = wave;
            v.freq_step0 = step0;
            v.freq_step1 = step1;
            v.total_samples = total_samples;
            v.attack_samples = attack_samples;
            v.release_samples = release_samples;
            v.vol_q15 = vol_q15;
        }
        Cmd::PlayBgm { ptr, frames, rate, loop_flag, loop_start, fade_samples, vol_q15 } => {
            handle_play_bgm(ptr, frames, rate, loop_flag, loop_start, fade_samples, vol_q15);
        }
        Cmd::StopBgm { fade_samples } => handle_stop_bgm(fade_samples),
        Cmd::PauseBgm { paused } => {
            if VOICES[BGM_SLOT].kind == VKind::Bgm {
                VOICES[BGM_SLOT].paused = paused;
            }
            // No track playing: idempotent no-op (src/sound.ts already guards
            // this JS-side too, but the native op stays safe either way).
        }
        Cmd::SetBusVolume { bus, vol_q15 } => {
            BUS_TARGET[bus] = vol_q15;
            BUS_STEP[bus] = fade_step(BUS_CUR[bus], vol_q15, BUS_RAMP_SAMPLES);
            BUS_REMAINING[bus] = BUS_RAMP_SAMPLES;
        }
    }
}

unsafe fn handle_play_bgm(
    ptr: *const i16,
    frames: u32,
    rate: u32,
    loop_flag: bool,
    loop_start: u32,
    fade_samples: u32,
    vol_q15: i32,
) {
    let step = rate_step(rate);
    let loop_start = if loop_start < frames { loop_start } else { 0 };

    if VOICES[BGM_SLOT].kind == VKind::Bgm && fade_samples > 0 {
        // Cross-fade scheme (module docs): park the outgoing track in a
        // borrowed synth slot, fading it to 0; the BGM slot goes straight to
        // the new track, fading it in. Both ramps share `fade_samples`.
        let dying_slot = alloc_voice(SYNTH_START, SYNTH_COUNT);
        let old = VOICES[BGM_SLOT];
        let d = &mut VOICES[dying_slot];
        *d = old;
        d.kind = VKind::BgmDying;
        d.trigger = next_trigger();
        // Force unpaused: the fade-out must always run to completion and
        // free the slot, even if the track being replaced was paused when
        // this playBgm arrived (otherwise a paused track could pin a synth
        // slot forever — see sample_bgm's full-freeze-while-paused).
        d.paused = false;
        d.gain_target = 0;
        d.fade_remaining = fade_samples;
        d.gain_step = fade_step(old.gain_cur, 0, fade_samples);
        d.die_at_fade_end = true;
    }

    let v = &mut VOICES[BGM_SLOT];
    *v = Voice::EMPTY;
    v.kind = VKind::Bgm;
    v.trigger = next_trigger();
    v.ptr = ptr;
    v.frames = frames;
    v.step = step;
    v.loop_flag = loop_flag;
    v.loop_start = loop_start;
    if fade_samples > 0 {
        v.gain_cur = 0;
        v.gain_target = vol_q15;
        v.fade_remaining = fade_samples;
        v.gain_step = fade_step(0, vol_q15, fade_samples);
    } else {
        // fadeMs == 0: instant cut to the new track (web host's "else cuts").
        v.gain_cur = vol_q15;
        v.gain_target = vol_q15;
    }
}

unsafe fn handle_stop_bgm(fade_samples: u32) {
    let v = &mut VOICES[BGM_SLOT];
    if v.kind != VKind::Bgm {
        return; // nothing playing: no-op (src/sound.ts guards this too)
    }
    if fade_samples == 0 {
        v.kind = VKind::Free; // instant cut + release
        return;
    }
    v.gain_target = 0;
    v.fade_remaining = fade_samples;
    v.gain_step = fade_step(v.gain_cur, 0, fade_samples);
    v.die_at_fade_end = true;
}

// ---------------------------------------------------------------------------
// public ops (JS thread) — called from ffi.rs's js_play_sfx etc.
// ---------------------------------------------------------------------------

/// spec op 26: one-shot SFX from the pak. Unknown key: silent no-op.
///
/// # Safety
/// JS-thread-only (matches the rest of this module's single-producer
/// contract for `RING`/`SOUNDS`).
pub unsafe fn play_sfx(key: &str, volume: f32, pan: f32) {
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    let Some(reg) = find_sound(SoundKind::Sfx, key) else {
        return;
    };
    let (pan_l_q15, pan_r_q15) = pan_gains(pan);
    ring_push(Cmd::PlaySfx {
        ptr: reg.ptr,
        frames: reg.frames,
        rate: reg.rate,
        vol_q15: q15_from_unit(volume),
        pan_l_q15,
        pan_r_q15,
    });
}

/// spec op 27: one-shot procedural voice, routed through the sfx bus.
///
/// # Safety
/// JS-thread-only, see `play_sfx`.
#[allow(clippy::too_many_arguments)]
pub unsafe fn play_synth(wave: i32, freq: f32, freq_end: f32, dur_ms: f32, attack_ms: f32, release_ms: f32, volume: f32) {
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    let total = ms_to_samples(dur_ms).max(1);
    let mut attack = ms_to_samples(attack_ms);
    let mut release = ms_to_samples(release_ms);
    // Clamp attack/release into the voice's own lifetime so envelope_q15's
    // `total - release` never straddles a caller-supplied value longer than
    // the voice itself.
    if attack > total {
        attack = total;
    }
    if release > total {
        release = total;
    }
    let wave = Waveform::from_u8(wave.clamp(0, 255) as u8);
    ring_push(Cmd::PlaySynth {
        wave,
        step0: hz_to_step(freq),
        step1: hz_to_step(freq_end),
        total_samples: total,
        attack_samples: attack,
        release_samples: release,
        vol_q15: q15_from_unit(volume),
    });
}

/// spec op 28: start/switch the single BGM track. Same-key-while-playing
/// no-op is already handled JS-side (src/sound.ts); this always (re)starts
/// whatever key it's given.
///
/// # Safety
/// JS-thread-only, see `play_sfx`.
pub unsafe fn play_bgm(key: &str, loop_flag: bool, fade_ms: f32, volume: f32) {
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    let Some(reg) = find_sound(SoundKind::Bgm, key) else {
        return;
    };
    ring_push(Cmd::PlayBgm {
        ptr: reg.ptr,
        frames: reg.frames,
        rate: reg.rate,
        loop_flag,
        loop_start: reg.loop_start,
        fade_samples: ms_to_samples(fade_ms),
        vol_q15: q15_from_unit(volume),
    });
}

/// spec op 29: fade the BGM track to silence and release it.
///
/// # Safety
/// JS-thread-only, see `play_sfx`.
pub unsafe fn stop_bgm(fade_ms: f32) {
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    ring_push(Cmd::StopBgm { fade_samples: ms_to_samples(fade_ms) });
}

/// spec op 30: freeze/resume the BGM cursor. Idempotent.
///
/// # Safety
/// JS-thread-only, see `play_sfx`.
pub unsafe fn pause_bgm(paused: bool) {
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    ring_push(Cmd::PauseBgm { paused });
}

/// spec op 31: live bus gain. `channel` = ENUMS.AudioChannel ordinal (0
/// Master, 1 Sfx, 2 Bgm); unknown ordinal: silent no-op.
///
/// # Safety
/// JS-thread-only, see `play_sfx`.
pub unsafe fn set_bus_volume(channel: i32, volume: f32) {
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    let bus = match channel {
        0 | 1 | 2 => channel as usize,
        _ => return,
    };
    ring_push(Cmd::SetBusVolume { bus, vol_q15: q15_from_unit(volume) });
}
