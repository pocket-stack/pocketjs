//! Device diagnostic counters (spec OP.debugStats) — the PSP stats.rs shape
//! with a `net` section for the WiFi transport. Counters are u32 and
//! free-running; readers diff two snapshots over a known window. Field names
//! are the devtools wire contract — extend, never rename.

use core::sync::atomic::{AtomicI32, AtomicU32, Ordering};

/// Starved 4 ms waits in the audio output thread (free-running while paused).
pub static AUDIO_STARVED: AtomicU32 = AtomicU32::new(0);
/// Most recent negative sceAudioOutOpenPort result (0 = never failed).
pub static AUDIO_LAST_RESERVE_ERR: AtomicI32 = AtomicI32::new(0);
/// Source sample frames accepted into the RAM ring.
pub static AUDIO_PUSHED_FRAMES: AtomicU32 = AtomicU32::new(0);

/// Frames committed to the plane texture (on-screen fps numerator).
pub static VID_PRESENTED: AtomicU32 = AtomicU32::new(0);
/// Epoch resyncs observed (seek/resume discontinuities).
pub static VID_EPOCHS: AtomicU32 = AtomicU32::new(0);

/// WIRE transport bytes in/out (wrap at 4 GiB; diff for throughput).
pub static NET_RX_BYTES: AtomicU32 = AtomicU32::new(0);
pub static NET_TX_BYTES: AtomicU32 = AtomicU32::new(0);
/// Completed connections that later dropped (reconnect count).
pub static NET_RECONNECTS: AtomicU32 = AtomicU32::new(0);
/// Video slots accepted into the RAM ring.
pub static NET_SLOTS_RX: AtomicU32 = AtomicU32::new(0);
/// Side-file cache LRU evictions.
pub static FILE_CACHE_EVICTS: AtomicU32 = AtomicU32::new(0);

/// One JSON snapshot (the devtools "devStats" payload).
pub fn json() -> String {
    let r = |c: &AtomicU32| c.load(Ordering::Relaxed);
    format!(
        concat!(
            "{{\"app\":\"{}\",\"bundle\":\"{}\",",
            "\"audio\":{{\"starved\":{},\"lastReserveErr\":{},\"pushedFrames\":{}}},",
            "\"vid\":{{\"presented\":{},\"epochs\":{}}},",
            "\"net\":{{\"rxBytes\":{},\"txBytes\":{},\"reconnects\":{},",
            "\"slotsRx\":{},\"fileEvicts\":{}}}}}"
        ),
        env!("POCKETJS_APP_NAME"),
        env!("POCKETJS_BUNDLE_HASH"),
        r(&AUDIO_STARVED),
        AUDIO_LAST_RESERVE_ERR.load(Ordering::Relaxed),
        r(&AUDIO_PUSHED_FRAMES),
        r(&VID_PRESENTED),
        r(&VID_EPOCHS),
        r(&NET_RX_BYTES),
        r(&NET_TX_BYTES),
        r(&NET_RECONNECTS),
        r(&NET_SLOTS_RX),
        r(&FILE_CACHE_EVICTS),
    )
}
