#![no_std]
#![no_main]

//! gu-demo: fly a camera through a cooked `.p3d` map with the pocket3d-gu
//! renderer. The bring-up vehicle for the PSP 3D backend — no game, no
//! QuickJS, just world rendering with PVS culling and the sky backdrop.
//!
//! The camera tours the map's CT spawn points (hold each ~1.6 s while
//! yawing), which covers most of a CS map's sightlines deterministically.
//! With GU_DEMO_CAP_START/N baked, presented frames are dumped to
//! ms0:/dc_cap/fNNNN.raw (512-stride RGBA) and the app exits after the
//! window — same contract as the PocketJS e2e capture builds.

extern crate alloc;

use core::ffi::c_void;

use glam::Vec3;
use pocket3d_bsp::cooked;
use pocket3d_gu::{sky, Camera3d, FramePool, WorldRenderer};
use psp::sys::{
    self, ClearBuffer, DisplayPixelFormat, DisplaySetBufSync, GuContextType, GuState,
    GuSyncBehavior, GuSyncMode, IoOpenFlags, TexturePixelFormat,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

psp::module!("gudemo", 1, 1);

static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

// 16-byte aligned so the GE can read vertices/indices/texels in place.
static MAP_P3D: Align16<[u8; include_bytes!(concat!(env!("OUT_DIR"), "/map.p3d")).len()]> =
    Align16(*include_bytes!(concat!(env!("OUT_DIR"), "/map.p3d")));

static CAP_START: &str = env!("GU_DEMO_CAP_START");
static CAP_N: &str = env!("GU_DEMO_CAP_N");

fn cap_window() -> (u32, u32) {
    let parse = |s: &str, d: u32| s.parse::<u32>().unwrap_or(d);
    (parse(CAP_START, u32::MAX), parse(CAP_N, 0))
}

fn psp_main() {
    unsafe {
        psp::enable_home_button();
        init_graphics();

        let map = match cooked::read(&MAP_P3D.0) {
            Ok(m) => m,
            Err(e) => halt(e),
        };
        pocket3d_gu::writeback(&MAP_P3D.0);

        let spawns = if map.ct_spawns.is_empty() {
            halt("map has no CT spawns");
        } else {
            map.ct_spawns.clone()
        };
        let mut world = WorldRenderer::new(map);
        let mut pool = FramePool::new();
        let sky_params = sky::SkyParams::default();

        let (cap_start, cap_n) = cap_window();
        let mut frame: u32 = 0;
        const HOLD: u32 = 96;
        loop {
            let spawn = spawns[(frame / HOLD) as usize % spawns.len()];
            let cam = Camera3d {
                pos: spawn.pos + Vec3::new(0.0, 28.0, 0.0),
                yaw: spawn.yaw + (frame % HOLD) as f32 * 0.015,
                pitch: -0.05,
                ..Camera3d::default()
            };

            sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);
            pocket3d_gu::begin_3d(&cam);
            sky::draw(&mut pool, &cam, &sky_params);
            world.draw(&mut pool, &cam);
            pocketjs_dbg_overlay(world.last_faces, world.last_tris);
            pocket3d_gu::end_3d();
            sys::sceGuFinish();
            sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
            sys::sceDisplayWaitVblankStart();
            sys::sceGuSwapBuffers();
            pool.reset();

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

/// Hook for an on-screen debug readout; kept silent for deterministic
/// captures (stats are visible via psplink stdout when needed).
fn pocketjs_dbg_overlay(_faces: u32, _tris: u32) {}

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
    sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);
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

/// Dump the display framebuffer to ms0:/dc_cap/fNNNN.raw (same layout as
/// the PocketJS capture path; PPSSPP maps ms0: to ~/.ppsspp).
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
    psp::dprintln!("[gu-demo halt] {}", msg);
    loop {
        sys::sceDisplayWaitVblankStart();
    }
}
