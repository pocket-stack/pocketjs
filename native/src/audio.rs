//! PCM output for the video plane (spec.ts STREAM audio ring): one SRC
//! hardware channel fed by a dedicated thread from an in-RAM SPSC ring.
//!
//! Split of labor: the MAIN thread does all usbhostfs file IO (vid.rs tops
//! this ring up from the stream file inside videoTick's budget — two threads
//! on one USB pipe would contend) and the AUDIO thread only ever moves RAM
//! into `sceAudioSRCOutputBlocking`, which parks it in the kernel until the
//! hardware drains each block. The SRC channel resamples to 44.1 kHz in
//! hardware, so the tuned-for-USB 22.05 kHz stream costs no CPU here.
//!
//! Single writer (main thread) + single reader (audio thread) over absolute
//! frame counters; release/acquire pairs publish the PCM bytes with the
//! counter. `flush()` (seek/epoch change) is writer-side: it advances the
//! read cursor, and a racing reader at worst outputs one already-consumed
//! block — a click, not corruption.

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use psp::sys::{self, AudioOutputFrequency, ThreadAttributes};
use psp::Align16;

/// One sceAudioSRCOutputBlocking block, in sample frames (~46 ms at 22.05 kHz).
const BLOCK_FRAMES: usize = 1024;
/// In-RAM ring capacity in sample frames (~740 ms at 22.05 kHz, 64 KB stereo).
const RING_FRAMES: usize = 16 * 1024;

static mut RING: [i16; RING_FRAMES * 2] = [0; RING_FRAMES * 2];
static mut OUT: Align16<[i16; BLOCK_FRAMES * 2]> = Align16([0; BLOCK_FRAMES * 2]);

/// Absolute sample-frame counters (wrap-around via modulo; usize wraps after
/// ~54 years of 22.05 kHz audio, which outlives the battery).
static WRITE_POS: AtomicUsize = AtomicUsize::new(0);
static READ_POS: AtomicUsize = AtomicUsize::new(0);
static RUN: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicBool = AtomicBool::new(false);

fn freq(sample_rate: u32) -> Option<AudioOutputFrequency> {
    Some(match sample_rate {
        48000 => AudioOutputFrequency::Khz48,
        44100 => AudioOutputFrequency::Khz44_1,
        32000 => AudioOutputFrequency::Khz32,
        24000 => AudioOutputFrequency::Khz24,
        22050 => AudioOutputFrequency::Khz22_05,
        16000 => AudioOutputFrequency::Khz16,
        12000 => AudioOutputFrequency::Khz12,
        11025 => AudioOutputFrequency::Khz11_025,
        8000 => AudioOutputFrequency::Khz8,
        _ => return None,
    })
}

unsafe extern "C" fn audio_thread(_argc: usize, _argv: *mut c_void) -> i32 {
    while RUN.load(Ordering::Acquire) {
        let read = READ_POS.load(Ordering::Relaxed);
        let avail = WRITE_POS.load(Ordering::Acquire).wrapping_sub(read);
        if avail < BLOCK_FRAMES {
            // Starved (paused stream, USB stall): sleep instead of pushing
            // silence, so resume latency is one block, not a queue of hush.
            sys::sceKernelDelayThread(4_000);
            continue;
        }
        for i in 0..BLOCK_FRAMES {
            let src = ((read + i) % RING_FRAMES) * 2;
            OUT.0[i * 2] = RING[src];
            OUT.0[i * 2 + 1] = RING[src + 1];
        }
        READ_POS.store(read.wrapping_add(BLOCK_FRAMES), Ordering::Release);
        sys::sceAudioSRCOutputBlocking(
            sys::AUDIO_VOLUME_MAX as i32,
            OUT.0.as_mut_ptr() as *mut c_void,
        );
    }
    sys::sceAudioSRCChRelease();
    LIVE.store(false, Ordering::Release);
    0
}

/// Reserve the SRC channel at the stream's rate and start the output thread.
/// Rates outside the hardware's SRC table are refused (the video still plays,
/// silently). Idempotent-hostile: stop() any previous session first.
pub unsafe fn start(sample_rate: u32) -> bool {
    let Some(f) = freq(sample_rate) else { return false };
    if LIVE.load(Ordering::Acquire) {
        stop();
    }
    WRITE_POS.store(0, Ordering::Relaxed);
    READ_POS.store(0, Ordering::Relaxed);
    if sys::sceAudioSRCChReserve(BLOCK_FRAMES as i32, f, 2) < 0 {
        return false;
    }
    RUN.store(true, Ordering::Release);
    let id = sys::sceKernelCreateThread(
        b"pocketjs_audio\0".as_ptr(),
        audio_thread,
        16, // above the JS worker (32): a missed block is audible, a late frame is not
        32 * 1024,
        ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if id.0 < 0 {
        RUN.store(false, Ordering::Release);
        sys::sceAudioSRCChRelease();
        return false;
    }
    LIVE.store(true, Ordering::Release);
    sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
    true
}

/// Signal the thread down and wait for it to release the channel (bounded:
/// one blocking output is ~46 ms; give it a generous 500 ms then move on).
pub unsafe fn stop() {
    if !LIVE.load(Ordering::Acquire) {
        return;
    }
    RUN.store(false, Ordering::Release);
    for _ in 0..125 {
        if !LIVE.load(Ordering::Acquire) {
            return;
        }
        sys::sceKernelDelayThread(4_000);
    }
}

/// Sample frames the ring can still accept (writer-side budgeting).
pub fn free_frames() -> usize {
    let queued = WRITE_POS
        .load(Ordering::Relaxed)
        .wrapping_sub(READ_POS.load(Ordering::Acquire));
    RING_FRAMES - queued.min(RING_FRAMES)
}

/// Queue interleaved s16 PCM (mono is upmixed to both ears). Frames beyond
/// free_frames() are dropped — the writer checks first, so a drop means a
/// flush raced in, and losing stale audio is the right outcome.
pub unsafe fn push(pcm: &[i16], channels: u32) {
    let frames = match channels {
        1 => pcm.len(),
        2 => pcm.len() / 2,
        _ => return,
    };
    let n = frames.min(free_frames());
    let write = WRITE_POS.load(Ordering::Relaxed);
    for i in 0..n {
        let dst = ((write + i) % RING_FRAMES) * 2;
        if channels == 1 {
            RING[dst] = pcm[i];
            RING[dst + 1] = pcm[i];
        } else {
            RING[dst] = pcm[i * 2];
            RING[dst + 1] = pcm[i * 2 + 1];
        }
    }
    WRITE_POS.store(write.wrapping_add(n), Ordering::Release);
}

/// Drop everything queued (seek/epoch discontinuity): jump the read cursor
/// to the write cursor. See the module header for the benign race.
pub fn flush() {
    READ_POS.store(WRITE_POS.load(Ordering::Relaxed), Ordering::Release);
}
