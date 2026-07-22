//! Link-and-render smoke VPK for the reusable backend.

#[cfg(target_os = "vita")]
use pocket3d_vita::{begin_3d, end_3d, sky, Camera3d, FramePool};
#[cfg(target_os = "vita")]
use vita2d_sys as v2d;

#[cfg(target_os = "vita")]
fn main() {
    unsafe {
        assert_eq!(v2d::vita2d_init_advanced(4 * 1024 * 1024), 1);
        v2d::vita2d_set_vblank_wait(1);
        v2d::vita2d_set_clear_color(0xff00_0000);

        let camera = Camera3d::default();
        let sky = sky::SkyParams::default();
        let mut pool = FramePool::new();
        for _ in 0..300 {
            pool.reset();
            v2d::vita2d_start_drawing();
            v2d::vita2d_clear_screen();
            begin_3d(&camera);
            sky::draw(&mut pool, &camera, &sky);
            end_3d();
            v2d::vita2d_end_drawing();
            v2d::vita2d_swap_buffers();
        }

        v2d::vita2d_wait_rendering_done();
        pocket3d_vita::shutdown();
        v2d::vita2d_fini();
    }
}

#[cfg(not(target_os = "vita"))]
fn main() {}
