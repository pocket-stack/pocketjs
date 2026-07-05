//! Native Video decode subsystem — the PSP side of the `<Video>` component.
//!
//! Design (DESIGN.md "Video"; grounded in the research dossier): a video node
//! carries an opaque decoder handle. The core emits a VIDEO_QUAD at the node's
//! laid-out rect; `ge.rs` binds THIS module's current front frame buffer as a
//! GE texture (zero-copy). Decode is offloaded to the **Media Engine** via the
//! high-level `scePsmfPlayer` (demux + H.264 + optional ATRAC3+ + A/V sync on
//! the player's own kernel/ME threads). We add ONE dedicated poll thread so
//! that `host0:`/PSPLink reads and the blocking `Get*Data` calls NEVER stall
//! the 60 Hz vblank worker.
//!
//! Threading contract:
//!   - The vblank worker (`main.rs`) only ever does an atomic load + a pointer
//!     read here (`surface()`), from the VIDEO_QUAD arm in `ge.rs`.
//!   - The poll thread is the SOLE `&mut *player` user; the worker touches only
//!     `Atomic*` fields + post-open-immutable buffer headers, accessed through a
//!     RAW pointer (`ctx_ptr`), never a `&mut VideoCtx` — so the two threads
//!     never hold aliasing `&mut`s to the same ctx.
//!   - Frames are triple-buffered; the poll thread publishes a ready index with
//!     a release store, the worker latches it with an acquire load, so the GE
//!     never samples a buffer mid-decode.
//!
//! HARDWARE-GATED (see DESIGN.md "Video" Phase-0): the exact player create-buffer
//! size, thread priorities, ConfigPlayer pixel mode, arena/ME partition headroom
//! and GE texture-cache freshness must be validated on real hardware + PSPLink.
//! Fully HLE'd by PPSSPP; the metal needs the AV modules loaded (main.rs).

use core::ffi::c_void;
use core::ptr;
use core::sync::atomic::{AtomicU32, Ordering};

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;

use pocketjs_core::spec::{video_cmd, video_state};
use psp::sys::{
    self, PsmfConfigMode, PsmfPlayer, PsmfPlayerData, PsmfPlayerMode, PsmfPlayerStatus,
    PsmfVideoData, SceUid, ThreadAttributes,
};

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------
// The active picture is 480x272 (the PSP panel + the ME AVC max). The GE needs
// a pow2-declared texture, so we bind a declared 512x512 with texture-buffer-
// width 512 and sample only the 480x272 sub-rect (u<=480, v<=272 texels). The
// player writes 480px rows at a 512px stride into `display_buf`; columns
// 480..511 and the guard rows below 272 are never sampled.

const ACTIVE_W: u32 = 480;
const ACTIVE_H: u32 = 272;
/// Texture-buffer width / declared pow2 side handed to the GE, and the pixel
/// stride passed to the player as `frame_width`.
const STRIDE_PX: u32 = 512;
/// Rows actually allocated per buffer: 272 active + guard rows (rounded to 288)
/// so a nearest-tap at the exact v=272 bottom edge can never read past the end.
const BUF_ROWS: u32 = 288;
const BYTES_PER_PX: u32 = 4; // Psm8888
const FRAME_BYTES: usize = (STRIDE_PX * BUF_ROWS * BYTES_PER_PX) as usize;

/// Triple buffering: 30 fps decode vs 60 fps present means the decoder cannot
/// lap the GE within a frame, but a third buffer removes any chance of the poll
/// thread touching the in-flight FRONT.
const NBUF: usize = 3;
const READY_NONE: u32 = NBUF as u32; // sentinel: no frame published yet

/// Player working buffer. `scePsmfPlayerCreate` needs a large scratch/ring
/// buffer; the documented floor is ~0x285800. Rounded up for headroom. NOTE:
/// the arena rounds allocations up to a power-of-two class, so 3 MB actually
/// consumes a 4 MB block (arena.rs) — sized deliberately just over the floor.
const PLAYER_BUF_SIZE: usize = 0x0030_0000; // 3 MB (-> 4 MB arena class)
/// Priority of the player's INTERNAL read/demux/decode threads — below the
/// prio-32 render worker so they never preempt the 60 Hz present. (tunable)
const PLAYER_THREAD_PRIO: i32 = 0x2C; // 44
/// Priority of OUR poll thread — also below the render worker. (tunable)
const POLL_THREAD_PRIO: i32 = 0x28; // 40
const POLL_STACK: i32 = 48 * 1024;

/// One concurrent video keeps the arena budget realistic: player 4 MB + 3x1 MB
/// frame blocks (pow2 rounding) ≈ 7 MB. A second would ≈ double it and risk OOM
/// alongside the QuickJS heap + core + textures on a 32 MB PSP-1000.
const MAX_VIDEOS: usize = 1;

// PsmfPlayerData codec ids (PPSSPP / pspsdk): AVC video, ATRAC3+ audio.
const PSMF_VIDEO_CODEC_AVC: i32 = 0x0E;
const PSMF_AUDIO_CODEC_ATRAC3PLUS: i32 = 0x0F;
/// ConfigPlayer(PixelType, ...) value for ABGR8888 output (verify on HW).
const PSMF_PIXEL_TYPE_8888: i32 = 3;
/// ConfigPlayer(Loop, ...) attr — 0 ENABLES looping, 1 disables (pspsdk/PPSSPP).
const PSMF_LOOP_ON: i32 = 0;
const PSMF_LOOP_OFF: i32 = 1;

// ---------------------------------------------------------------------------
// Surface handed to ge.rs
// ---------------------------------------------------------------------------

/// The current front frame of a video, for the GE to bind as a texture.
pub struct Surface {
    /// Front buffer base pointer (already dcache-flushed by the decoder).
    pub ptr: *const u8,
    /// Sampled sub-rect (texels): 480x272.
    pub active_w: u32,
    pub active_h: u32,
    /// Declared pow2 texture side + texture-buffer-width (512).
    pub tex_dim: u32,
    pub stride_px: u32,
}

// ---------------------------------------------------------------------------
// Per-video context
// ---------------------------------------------------------------------------

struct VideoCtx {
    /// The player struct is ~64 KB (its temp_buf is 0x10000) — must live in the
    /// arena, never on a thread stack. Boxed = one arena allocation. Mutated
    /// ONLY by the poll thread (and by open/close, which never overlap it).
    player: Box<PsmfPlayer>,
    /// The large player working buffer (kept alive for the ctx lifetime).
    _work: Vec<u8>,
    /// NBUF frame buffers (arena). Their base pointers are stable after open.
    frames: [Vec<u8>; NBUF],
    /// Index of the latest fully decoded buffer (release/acquire published),
    /// or READY_NONE. The GE reads this to pick the FRONT.
    ready: AtomicU32,
    /// Pending command (VIDEO_CMD.*), consumed by the poll thread.
    command: AtomicU32,
    /// Coarse playback state | (ptsMs << 8), for `videoState`.
    status: AtomicU32,
    /// Our poll thread; -1 until started.
    thread: SceUid,
    loop_playback: bool,
    /// This ctx's slot index (passed to the poll thread as its argument).
    slot: u32,
}

static mut REG: [Option<VideoCtx>; MAX_VIDEOS] = [None];

/// Raw pointer to the ctx at `handle`, or null. Callers deref specific fields
/// (`(*p).ready` etc.) — this deliberately does NOT hand out a `&mut VideoCtx`,
/// so the worker's field reads never alias the poll thread's `&mut *player`.
#[inline]
unsafe fn ctx_ptr(handle: i32) -> *mut VideoCtx {
    let Ok(h) = usize::try_from(handle) else { return ptr::null_mut() };
    if h >= MAX_VIDEOS {
        return ptr::null_mut();
    }
    match REG[h].as_mut() {
        Some(c) => c as *mut VideoCtx,
        None => ptr::null_mut(),
    }
}

// ---------------------------------------------------------------------------
// Public API (called from ffi.rs on the JS thread, except `surface` from ge.rs)
// ---------------------------------------------------------------------------

/// Open a decoder for a host-fs stream. `path` is a NUL-terminated byte string
/// (e.g. `host0:/clip.pmf\0`). Returns a handle (>= 0) or -1 on failure.
pub unsafe fn open(path: *const u8, loop_playback: bool) -> i32 {
    // Find a free slot.
    let mut slot = usize::MAX;
    for (i, s) in REG.iter().enumerate() {
        if s.is_none() {
            slot = i;
            break;
        }
    }
    if slot == usize::MAX {
        return -1;
    }

    // Allocate the working + frame buffers from the arena.
    let work: Vec<u8> = vec![0u8; PLAYER_BUF_SIZE];
    let frames: [Vec<u8>; NBUF] = [
        vec![0u8; FRAME_BYTES],
        vec![0u8; FRAME_BYTES],
        vec![0u8; FRAME_BYTES],
    ];
    // Flush the zero-init dirty cache lines ONCE now, before the ME ever DMAs
    // into these buffers — so the poll loop's post-decode invalidate never
    // writes stale zeros over freshly decoded pixels.
    for f in &frames {
        sys::sceKernelDcacheWritebackInvalidateRange(f.as_ptr() as *const c_void, FRAME_BYTES as u32);
    }
    let player: Box<PsmfPlayer> = Box::new(core::mem::zeroed::<PsmfPlayer>());

    let mut c = VideoCtx {
        player,
        _work: work,
        frames,
        ready: AtomicU32::new(READY_NONE),
        command: AtomicU32::new(video_cmd::PLAY),
        status: AtomicU32::new(video_state::IDLE),
        thread: SceUid(-1),
        loop_playback,
        slot: slot as u32,
    };

    // scePsmfPlayerCreate: pass [bufferAddr, bufferSize, threadPriority] as the
    // create-data triple.
    let create_data: [u32; 3] = [
        c._work.as_mut_ptr() as u32,
        PLAYER_BUF_SIZE as u32,
        PLAYER_THREAD_PRIO as u32,
    ];
    if sys::scePsmfPlayerCreate(&mut *c.player, create_data.as_ptr()) < 0 {
        c.status.store(video_state::ERROR, Ordering::Relaxed);
        return -1;
    }
    if sys::scePsmfPlayerSetPsmf(&mut *c.player, path) < 0 {
        sys::scePsmfPlayerDelete(&mut *c.player);
        return -1;
    }
    // ABGR8888 frames (the only format ge.rs binds beside 4444); loop mode.
    sys::scePsmfPlayerConfigPlayer(&mut *c.player, PsmfConfigMode::PixelType, PSMF_PIXEL_TYPE_8888);
    sys::scePsmfPlayerConfigPlayer(
        &mut *c.player,
        PsmfConfigMode::Loop,
        if loop_playback { PSMF_LOOP_ON } else { PSMF_LOOP_OFF },
    );

    // Start playback. v1 is SILENT with a VIDEO-ONLY PMF: audio_stream_num = -1
    // selects no audio stream (declaring one that doesn't exist can fail Start,
    // and an undrained audio ring stalls video). v2: real ATRAC3+ stream drained
    // via GetAudioData -> sceAudioOutput2, audio-clock master. (verify on HW)
    let data = PsmfPlayerData {
        video_codec: PSMF_VIDEO_CODEC_AVC,
        video_stream_num: 0,
        audio_codec: PSMF_AUDIO_CODEC_ATRAC3PLUS,
        audio_stream_num: -1,
        play_mode: 0,
        play_speed: 0,
    };
    if sys::scePsmfPlayerStart(&mut *c.player, &data, 0) < 0 {
        sys::scePsmfPlayerReleasePsmf(&mut *c.player);
        sys::scePsmfPlayerDelete(&mut *c.player);
        return -1;
    }
    c.status.store(video_state::PLAYING, Ordering::Relaxed);

    // Install the ctx BEFORE creating the thread (the thread reads REG[slot]).
    // Create does NOT start the thread, so there is no read before we finish
    // wiring `thread` below.
    REG[slot] = Some(c);

    // Spawn the poll thread; hand it the slot index as its start argument.
    let tid = sys::sceKernelCreateThread(
        b"pocketjs_video\0".as_ptr(),
        poll_main,
        POLL_THREAD_PRIO,
        POLL_STACK,
        ThreadAttributes::USER,
        ptr::null_mut(),
    );
    if tid.0 < 0 {
        // Could not spawn: tear the player down (scoped borrow) and free the
        // slot. The borrow must end BEFORE the `REG[slot] = None` write.
        if let Some(inst) = REG[slot].as_mut() {
            sys::scePsmfPlayerStop(&mut *inst.player);
            sys::scePsmfPlayerReleasePsmf(&mut *inst.player);
            sys::scePsmfPlayerDelete(&mut *inst.player);
        }
        REG[slot] = None;
        return -1;
    }
    REG[slot].as_mut().unwrap().thread = tid;
    let mut arg = slot as u32;
    sys::sceKernelStartThread(tid, 4, &mut arg as *mut u32 as *mut c_void);
    slot as i32
}

/// Queue a control command for the poll thread. Close is handled inline
/// (joins the thread + frees the ctx) so buffers are reclaimed deterministically.
pub unsafe fn control(handle: i32, cmd: u32, _arg: i32) {
    if cmd == video_cmd::CLOSE {
        close(handle);
        return;
    }
    let p = ctx_ptr(handle);
    if !p.is_null() {
        (*p).command.store(cmd, Ordering::Relaxed);
    }
}

/// Packed playback status for `videoState`: state | (ptsMs << 8).
pub unsafe fn state(handle: i32) -> u32 {
    let p = ctx_ptr(handle);
    if p.is_null() {
        return video_state::ERROR;
    }
    (*p).status.load(Ordering::Relaxed)
}

/// The current front frame for the GE to bind. `None` until the first frame is
/// decoded (the VIDEO_QUAD arm then draws nothing / a placeholder).
///
/// Called from the vblank worker (ge.rs) — a pure atomic load + pointer read;
/// touches only `ready` (atomic) and the FRONT buffer's stable base pointer,
/// never `&mut` and never `scePsmfPlayer*`.
pub unsafe fn surface(handle: i32) -> Option<Surface> {
    let p = ctx_ptr(handle);
    if p.is_null() {
        return None;
    }
    let idx = (*p).ready.load(Ordering::Acquire);
    if idx >= NBUF as u32 {
        return None;
    }
    Some(Surface {
        ptr: (*p).frames[idx as usize].as_ptr(),
        active_w: ACTIVE_W,
        active_h: ACTIVE_H,
        tex_dim: STRIDE_PX,
        stride_px: STRIDE_PX,
    })
}

/// Tear a decoder down: signal the poll thread to exit, join it, delete the
/// player, drop the ctx (frees all arena buffers).
pub unsafe fn close(handle: i32) {
    let p = ctx_ptr(handle);
    if p.is_null() {
        return;
    }
    let slot = (*p).slot as usize;
    let tid = (*p).thread;
    (*p).command.store(video_cmd::CLOSE, Ordering::Relaxed);
    if tid.0 >= 0 {
        // The poll thread checks `command` each iteration and exits on Close.
        // After WaitThreadEnd it no longer runs, so the teardown below is the
        // sole accessor of this ctx.
        sys::sceKernelWaitThreadEnd(tid, ptr::null_mut());
        sys::sceKernelDeleteThread(tid);
    }
    sys::scePsmfPlayerStop(&mut *(*p).player);
    sys::scePsmfPlayerReleasePsmf(&mut *(*p).player);
    sys::scePsmfPlayerDelete(&mut *(*p).player);
    REG[slot] = None; // drops _work + frames (arena free)
}

/// Close every open video (teardown on unmount / exit).
pub unsafe fn stop_all() {
    for i in 0..MAX_VIDEOS {
        if REG[i].is_some() {
            close(i as i32);
        }
    }
}

// ---------------------------------------------------------------------------
// Poll thread
// ---------------------------------------------------------------------------

/// One poll thread per open video. Advances the player, pulls the freshly
/// decoded frame into a BACK buffer, dcache-invalidates it (the ME wrote it via
/// DMA behind the CPU cache; the buffer was pre-flushed at open so this never
/// clobbers pixels), then publishes it as the new FRONT.
unsafe extern "C" fn poll_main(_argc: usize, argv: *mut c_void) -> i32 {
    let slot = if argv.is_null() { 0 } else { *(argv as *const u32) as usize };
    let p = if slot < MAX_VIDEOS { ctx_ptr(slot as i32) } else { ptr::null_mut() };
    if p.is_null() {
        return 0;
    }
    // Rotating write cursor: never write the buffer currently published as FRONT.
    let mut write: u32 = 0;
    let mut paused = false;

    loop {
        let cmd = (*p).command.load(Ordering::Relaxed);
        if cmd == video_cmd::CLOSE {
            break;
        }
        if cmd == video_cmd::PAUSE {
            if !paused {
                // Actually pause the player's clock (not just stop pulling) so
                // resume doesn't jump forward in time / overflow the rings.
                sys::scePsmfPlayerChangePlayMode(&mut *(*p).player, PsmfPlayerMode::Pause, 0);
                paused = true;
                let pts = (*p).status.load(Ordering::Relaxed) & !0xff;
                (*p).status.store(video_state::PAUSED | pts, Ordering::Relaxed);
            }
            sys::sceKernelDelayThread(16_000); // ~1 frame; yield and re-check
            continue;
        }
        if paused {
            sys::scePsmfPlayerChangePlayMode(&mut *(*p).player, PsmfPlayerMode::Play, 0);
            paused = false;
        }

        // Finished (non-looping): the player's Loop config re-arms internally
        // when looping, so we only observe Finished when loop is off.
        let st = sys::scePsmfPlayerGetCurrentStatus(&mut *(*p).player);
        if matches!(st, PsmfPlayerStatus::PlayingFinished) && !(*p).loop_playback {
            let pts = (*p).status.load(Ordering::Relaxed) & !0xff;
            (*p).status.store(video_state::ENDED | pts, Ordering::Relaxed);
            sys::sceKernelDelayThread(16_000);
            continue;
        }

        sys::scePsmfPlayerUpdate(&mut *(*p).player);

        // Choose a BACK buffer != the published FRONT.
        let front = (*p).ready.load(Ordering::Relaxed);
        if write == front {
            write = (write + 1) % NBUF as u32;
        }
        let back = write as usize;

        let mut vd = PsmfVideoData {
            frame_width: STRIDE_PX as i32,
            display_buf: (*p).frames[back].as_mut_ptr() as u32,
            display_pts: 0,
        };
        let r = sys::scePsmfPlayerGetVideoData(&mut *(*p).player, &mut vd);
        if r >= 0 {
            // Invalidate so the GE (which samples RAM) sees the ME's DMA output,
            // not stale cache. Writeback-invalidate is alignment-safe and, since
            // the CPU never writes these buffers post-open, carries no dirty
            // lines to clobber the frame with.
            sys::sceKernelDcacheWritebackInvalidateRange(
                (*p).frames[back].as_ptr() as *const c_void,
                FRAME_BYTES as u32,
            );
            // Publish the new FRONT (release: pairs with surface()'s acquire).
            (*p).ready.store(back as u32, Ordering::Release);
            write = (back as u32 + 1) % NBUF as u32;
            let pts_ms = vd.display_pts / 90; // 90 kHz PTS -> ms
            (*p).status.store(video_state::PLAYING | (pts_ms << 8), Ordering::Relaxed);
        } else {
            // NO_MORE_DATA / warm-up: back off briefly and retry.
            sys::sceKernelDelayThread(8_000);
        }
    }
    0
}
