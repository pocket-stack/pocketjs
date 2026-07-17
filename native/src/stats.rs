//! Device diagnostic counters (spec OP.debugStats).
//!
//! One atomic per signal, incremented at the point of truth and snapshotted
//! into a JSON line on demand — turning the questions that used to take a
//! pspsh autopsy ("is audio underrunning?", "are frames being presented or
//! torn?", "did the svc offset defense fire?") into a single devtools
//! query. Also carries the build identity (app output name + FNV-1a64 of
//! the embedded js+pak, computed by build.rs) so the PSPLINK bridge can
//! detect a stale embed the moment the device says hello.
//!
//! Counters are u32 and free-running; readers diff two snapshots over a
//! known window rather than resetting (writers stay wait-free, and two
//! independent readers can't clobber each other).

use alloc::format;
use alloc::string::String;
use core::sync::atomic::{AtomicI32, AtomicU32, Ordering};

/// Starved 4 ms waits in the audio output thread. Grows freely while the
/// stream is PAUSED (that is starvation by design) — meaningful only as a
/// delta across a window that was supposed to be playing.
pub static AUDIO_STARVED: AtomicU32 = AtomicU32::new(0);
/// start() gave up reserving the hardware channel (the mute-forever class).
pub static AUDIO_RESERVE_GIVEUPS: AtomicU32 = AtomicU32::new(0);
/// Most recent negative sceAudioChReserve result (0 = never failed).
pub static AUDIO_LAST_RESERVE_ERR: AtomicI32 = AtomicI32::new(0);
/// release_channel() exhausted its drain retries (channel left held).
pub static AUDIO_RELEASE_TIMEOUTS: AtomicU32 = AtomicU32::new(0);
/// Source sample frames accepted into the RAM ring.
pub static AUDIO_PUSHED_FRAMES: AtomicU32 = AtomicU32::new(0);

/// Frames committed to the plane texture (the on-screen fps numerator).
pub static VID_PRESENTED: AtomicU32 = AtomicU32::new(0);
/// Completed slot reads discarded because the writer touched the slot
/// mid-read (torn) — a few per seek are normal, a stream of them is not.
pub static VID_TORN: AtomicU32 = AtomicU32::new(0);
/// In-flight slot reads abandoned because the writer lapped the ring
/// (sustained USB stall or an underpowered IO budget).
pub static VID_LAPPED: AtomicU32 = AtomicU32::new(0);
/// Epoch resyncs observed (seek/resume discontinuities).
pub static VID_EPOCHS: AtomicU32 = AtomicU32::new(0);
/// Header-block reads that failed outright (transport errors).
pub static VID_HDR_FAILS: AtomicU32 = AtomicU32::new(0);
/// Total stream-file bytes read (wraps at 4 GiB; diff across a window for
/// effective throughput vs. IO_BUDGET).
pub static VID_BYTES: AtomicU32 = AtomicU32::new(0);

/// svc poll truncation defenses fired (host restarted / file recreated).
pub static SVC_TRUNC_RESETS: AtomicU32 = AtomicU32::new(0);

/// One JSON snapshot. Field names are the wire contract for the devtools
/// "stats" message — extend, never rename.
pub fn json() -> String {
    let r = |c: &AtomicU32| c.load(Ordering::Relaxed);
    format!(
        concat!(
            "{{\"app\":\"{}\",\"bundle\":\"{}\",",
            "\"audio\":{{\"starved\":{},\"reserveGiveups\":{},\"lastReserveErr\":{},",
            "\"releaseTimeouts\":{},\"pushedFrames\":{}}},",
            "\"vid\":{{\"presented\":{},\"torn\":{},\"lapped\":{},\"epochs\":{},",
            "\"hdrFails\":{},\"bytes\":{}}},",
            "\"svc\":{{\"truncResets\":{}}}}}"
        ),
        env!("POCKETJS_APP"),
        env!("POCKETJS_BUNDLE_HASH"),
        r(&AUDIO_STARVED),
        r(&AUDIO_RESERVE_GIVEUPS),
        AUDIO_LAST_RESERVE_ERR.load(Ordering::Relaxed),
        r(&AUDIO_RELEASE_TIMEOUTS),
        r(&AUDIO_PUSHED_FRAMES),
        r(&VID_PRESENTED),
        r(&VID_TORN),
        r(&VID_LAPPED),
        r(&VID_EPOCHS),
        r(&VID_HDR_FAILS),
        r(&VID_BYTES),
        r(&SVC_TRUNC_RESETS),
    )
}
