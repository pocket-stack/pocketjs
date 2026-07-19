#![no_std]
#![no_main]

//! pocket-drive: a Tesla-dash-style night drive through a real city on a
//! real PSP. Open map data (OpenStreetMap buildings + streets, cooked to
//! simple extruded meshes by `cooker/cook.ts`) streams in tile by tile
//! around a car that follows a baked route past real landmarks; new blocks
//! rise from the ground as they load.
//!
//! Pack source: a `.pdrv` on the memory stick (true sceIo async streaming)
//! or, when absent, a pack embedded at build time via DRIVE_PACK (loads are
//! then borrowed with a small simulated latency, keeping the choreography).
//!
//! Controls: analog = look around · CROSS = boost · SQUARE = brake ·
//! START = pause. With DRIVE_CAP_START/N baked, presented frames dump to
//! ms0:/dc_cap/fNNNN.raw and the app exits — the gu-demo capture contract.

extern crate alloc;

mod car;
mod pack;
mod scene;
mod stream;

use core::ffi::c_void;

use alloc::vec::Vec;
use glam::Vec3;
use pocket3d_gu::{Camera3d, FramePool};
use psp::sys::{
    self, ClearBuffer, CtrlButtons, CtrlMode, DisplayPixelFormat, DisplaySetBufSync,
    GuContextType, GuState, GuSyncBehavior, GuSyncMode, IoOpenFlags, SceUid, TexturePixelFormat,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

use crate::stream::{Source, Streamer};

psp::module!("pocket_drive", 1, 1);

static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

// 16-byte aligned so the GE can read embedded tile payloads in place.
static PACK: Align16<[u8; include_bytes!(concat!(env!("OUT_DIR"), "/city.pdrv")).len()]> =
    Align16(*include_bytes!(concat!(env!("OUT_DIR"), "/city.pdrv")));

static CAP_START: &str = env!("DRIVE_CAP_START");
static CAP_N: &str = env!("DRIVE_CAP_N");

const PACK_PATHS: [&[u8]; 3] = [
    b"ms0:/pocket-drive/manhattan.pdrv\0",
    b"ms0:/PSP/GAME/pocket-drive/manhattan.pdrv\0",
    b"host0:/dist/drive/manhattan.pdrv\0",
];

const INTRO_FRAMES: u32 = 220;
const INTRO_BLEND: u32 = 70;
const DRIVE_START: u32 = 150;
const CHASE_DIST: f32 = 46.0;
const CHASE_HEIGHT: f32 = 18.0;
const CHASE_PITCH: f32 = -0.12;
const TRAFFIC: usize = 16;

fn cap_window() -> (u32, u32) {
    let parse = |s: &str, d: u32| s.parse::<u32>().unwrap_or(d);
    (parse(CAP_START, u32::MAX), parse(CAP_N, 0))
}

fn psp_main() {
    unsafe {
        psp::enable_home_button();
        init_graphics();
        sys::sceCtrlSetSamplingCycle(0);
        sys::sceCtrlSetSamplingMode(CtrlMode::Analog);

        let mut streamer = match open_pack() {
            Ok(s) => s,
            Err(e) => halt(e),
        };
        let total = streamer.route(streamer.route_len() - 1).s;

        // Cars: player on the ribbon line, traffic staggered both ways.
        let player_mesh = car::build_car(car::PLAYER_BODY);
        let traffic_meshes: Vec<Vec<scene::Vert32>> = car::TRAFFIC_BODIES
            .iter()
            .map(|&c| car::build_car(c))
            .collect();
        pocket3d_gu::writeback(vert_bytes(&player_mesh));
        for m in &traffic_meshes {
            pocket3d_gu::writeback(vert_bytes(m));
        }
        let mut player = car::Follower::new(0.0, 1.0, 0.0, 64.0);
        let mut traffic: Vec<car::Follower> = (0..TRAFFIC)
            .map(|i| {
                let dir = if i % 2 == 0 { 1.0 } else { -1.0 };
                let s0 = total * (i as f32 + 0.4) / TRAFFIC as f32;
                car::Follower::new(s0, dir, 7.0, 46.0 + (i % 4) as f32 * 5.0)
            })
            .collect();

        let mut pool = FramePool::new();
        let (cap_start, cap_n) = cap_window();
        let mut frame: u32 = 0;
        let mut paused = false;
        let mut prev_buttons = CtrlButtons::empty();
        let mut cam_yaw: f32 = 0.0;
        let mut look_yaw: f32 = 0.0;
        let mut look_pitch: f32 = 0.0;
        let dt = 1.0 / 60.0;

        loop {
            // ---- input ----
            let mut pad = sys::SceCtrlData::default();
            sys::sceCtrlReadBufferPositive(&mut pad, 1);
            if pad.buttons.contains(CtrlButtons::START)
                && !prev_buttons.contains(CtrlButtons::START)
            {
                paused = !paused;
            }
            prev_buttons = pad.buttons;
            let throttle = if pad.buttons.contains(CtrlButtons::CROSS) {
                1.9
            } else if pad.buttons.contains(CtrlButtons::SQUARE) {
                0.22
            } else {
                1.0
            };
            let ax = (pad.lx as f32 - 128.0) / 127.0;
            let ay = (pad.ly as f32 - 128.0) / 127.0;
            let look_x = if ax.abs() > 0.18 { ax } else { 0.0 };
            let look_y = if ay.abs() > 0.18 { ay } else { 0.0 };
            look_yaw += (look_x * -1.1 - look_yaw) * 0.10;
            look_pitch += (look_y * -0.26 - look_pitch) * 0.10;

            // ---- simulate ----
            let driving = frame >= DRIVE_START && !paused;
            if driving {
                player.update(&streamer, total, throttle, dt);
                for t in traffic.iter_mut() {
                    t.update(&streamer, total, 1.0, dt);
                }
            }
            let (car_pos, car_yaw) = player.pose(&streamer);

            // ---- camera ----
            let cam = camera(frame, car_pos, car_yaw, &mut cam_yaw, look_yaw, look_pitch);

            // ---- stream ----
            let (hx, hz) = (-libm::sinf(car_yaw), -libm::cosf(car_yaw));
            streamer.update(car_pos.x, car_pos.z, hx, hz, frame);

            // ---- record ----
            sys::sceGuStart(GuContextType::Direct, core::ptr::addr_of_mut!(LIST) as *mut c_void);
            pocket3d_gu::begin_3d(&cam);
            scene::pass_begin();
            scene::backdrop(&mut pool, &cam);
            let stats = scene::draw_tiles(&streamer, &cam, frame);
            scene::draw_ribbon(&mut pool, &streamer, player.s, total);
            for (i, t) in traffic.iter().enumerate() {
                let (p, yaw) = t.pose(&streamer);
                car::draw_car(&traffic_meshes[i % traffic_meshes.len()], p, yaw);
            }
            car::draw_car(&player_mesh, car_pos, car_yaw);
            scene::pass_end();
            pocket3d_gu::end_3d();
            sys::sceGuFinish();
            sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
            sys::sceDisplayWaitVblankStart();
            sys::sceGuSwapBuffers();
            pool.reset();

            // On-screen stats corrupt captures (dprintln repaints the whole
            // debug console into the framebuffer) — opt in via `--features
            // stats` for PSPLINK/bring-up sessions only.
            #[cfg(feature = "stats")]
            if frame % 300 == 0 {
                psp::dprintln!(
                    "[drive] f={} tiles={} tris={} resident={} loads={} v={}",
                    frame,
                    stats.tiles,
                    stats.tris,
                    streamer.resident,
                    streamer.loads,
                    player.speed() as i32
                );
            }
            #[cfg(not(feature = "stats"))]
            let _ = &stats;

            if frame >= cap_start && frame < cap_start.saturating_add(cap_n) {
                cap_dump(frame - cap_start);
                if frame + 1 == cap_start + cap_n {
                    sys::sceKernelExitGame();
                }
            }
            frame = frame.wrapping_add(1);
        }
    }
}

/// Intro orbit around the parked car, blending into the chase camera as it
/// pulls away; afterwards a smoothed chase with analog look-around.
fn camera(
    frame: u32,
    car_pos: Vec3,
    car_yaw: f32,
    cam_yaw: &mut f32,
    look_yaw: f32,
    look_pitch: f32,
) -> Camera3d {
    // Chase pose (always computed so the blend target is live).
    let delta = wrap_angle(car_yaw - *cam_yaw);
    *cam_yaw += delta * 0.075;
    let yaw = *cam_yaw + look_yaw;
    let fwd = Vec3::new(-libm::sinf(yaw), 0.0, -libm::cosf(yaw));
    let chase_pos = car_pos - fwd * CHASE_DIST + Vec3::new(0.0, CHASE_HEIGHT, 0.0);
    let chase = (chase_pos, yaw, CHASE_PITCH + look_pitch);

    let cam = if frame < INTRO_FRAMES {
        // Slow orbit, drifting down toward the chase height.
        let t = frame as f32 / INTRO_FRAMES as f32;
        let a = 2.4 + frame as f32 * 0.006;
        let radius = 95.0 - 25.0 * t;
        let height = 46.0 - 20.0 * t;
        let pos = car_pos + Vec3::new(libm::sinf(a) * radius, height, libm::cosf(a) * radius);
        let d = car_pos + Vec3::new(0.0, 6.0, 0.0) - pos;
        let dxz = libm::sqrtf(d.x * d.x + d.z * d.z);
        let orbit = (pos, libm::atan2f(-d.x, -d.z), libm::atan2f(d.y, dxz));
        *cam_yaw = car_yaw; // keep the chase yaw settled for the handoff
        let blend_start = INTRO_FRAMES - INTRO_BLEND;
        if frame >= blend_start {
            let bt = (frame - blend_start) as f32 / INTRO_BLEND as f32;
            let bt = bt * bt * (3.0 - 2.0 * bt);
            (
                orbit.0.lerp(chase.0, bt),
                orbit.1 + wrap_angle(chase.1 - orbit.1) * bt,
                orbit.2 + (chase.2 - orbit.2) * bt,
            )
        } else {
            orbit
        }
    } else {
        chase
    };

    Camera3d {
        pos: cam.0,
        yaw: cam.1,
        pitch: cam.2,
        fov_y: 72f32.to_radians(),
        ..Camera3d::default()
    }
}

fn wrap_angle(a: f32) -> f32 {
    let mut a = a;
    while a > core::f32::consts::PI {
        a -= core::f32::consts::TAU;
    }
    while a < -core::f32::consts::PI {
        a += core::f32::consts::TAU;
    }
    a
}

fn vert_bytes(v: &[scene::Vert32]) -> &[u8] {
    unsafe { core::slice::from_raw_parts(v.as_ptr() as *const u8, core::mem::size_of_val(v)) }
}

/// Prefer a memory-stick pack (real streaming); fall back to the embedded
/// one. Leaks the meta prefix — it lives for the whole run anyway.
unsafe fn open_pack() -> Result<Streamer, &'static str> {
    for path in PACK_PATHS {
        let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o444);
        if fd.0 < 0 {
            continue;
        }
        let mut hdr = [0u8; pack::HEADER];
        if sys::sceIoRead(fd, hdr.as_mut_ptr() as *mut c_void, pack::HEADER as u32)
            != pack::HEADER as i32
        {
            sys::sceIoClose(fd);
            continue;
        }
        let info = pack::parse_header(&hdr)?;
        let len = pack::meta_len(&info);
        let mut meta = pack::AlignedBuf::new(len);
        sys::sceIoLseek32(fd, 0, sys::IoWhence::Set);
        if sys::sceIoRead(fd, meta.as_mut_ptr() as *mut c_void, len as u32) != len as i32 {
            sys::sceIoClose(fd);
            continue;
        }
        let meta_slice: &'static [u8] =
            core::slice::from_raw_parts(meta.as_mut_ptr(), len);
        core::mem::forget(meta);
        psp::dprintln!("[drive] streaming from file pack");
        return Ok(Streamer::new(info, meta_slice, Source::File(fd)));
    }

    let data: &'static [u8] = &PACK.0;
    if data.is_empty() {
        return Err("no city pack: put manhattan.pdrv on ms0:/pocket-drive/ or build with DRIVE_PACK");
    }
    pocket3d_gu::writeback(data);
    let info = pack::parse_header(data)?;
    psp::dprintln!("[drive] using embedded pack");
    Ok(Streamer::new(info, data, Source::Embedded(data)))
}

unsafe fn init_graphics() {
    let allocator = match get_vram_allocator() {
        Ok(a) => a,
        Err(_) => halt("vram allocator"),
    };
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let zbp = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm4444)
        .as_mut_ptr_from_zero();

    sys::sceGuInit();
    sys::sceGuStart(GuContextType::Direct, core::ptr::addr_of_mut!(LIST) as *mut c_void);
    sys::sceGuDrawBuffer(DisplayPixelFormat::Psm8888, fbp0 as _, BUF_WIDTH as i32);
    sys::sceGuDispBuffer(
        SCREEN_WIDTH as i32,
        SCREEN_HEIGHT as i32,
        fbp1 as _,
        BUF_WIDTH as i32,
    );
    sys::sceGuDepthBuffer(zbp as _, BUF_WIDTH as i32);
    sys::sceGuOffset(2048 - (SCREEN_WIDTH / 2), 2048 - (SCREEN_HEIGHT / 2));
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::ScissorTest);
    sys::sceGuShadeModel(psp::sys::ShadingModel::Smooth);
    sys::sceGuClearColor(0xff000000);
    sys::sceGuClearDepth(0);
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);
    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
}

/// Dump the display framebuffer to ms0:/dc_cap/fNNNN.raw (the shared
/// PocketJS capture layout; PPSSPP maps ms0: to its memstick root).
unsafe fn cap_dump(idx: u32) {
    if idx == 0 {
        sys::sceIoMkdir(b"ms0:/dc_cap\0".as_ptr(), 0o777);
    }
    let mut name: [u8; 22] = *b"ms0:/dc_cap/f0000.raw\0";
    let mut v = idx;
    let mut i = 16usize;
    loop {
        name[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if i == 13 {
            break;
        }
        i -= 1;
    }
    let mut top: *mut c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;
    let fd = sys::sceIoOpen(
        name.as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
        sys::sceIoClose(fd);
    }
}

unsafe fn halt(msg: &str) -> ! {
    psp::dprintln!("[drive halt] {}", msg);
    loop {
        sys::sceDisplayWaitVblankStart();
    }
}

// Keep the unused-field lint honest: SceUid is only constructed by sceIoOpen.
#[allow(dead_code)]
fn _uid_assert(u: SceUid) -> i32 {
    u.0
}
