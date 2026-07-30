//! Strip-vs-full parity: `render_strip` must produce, for any horizontal
//! band, exactly the bytes a full render puts in that band — the invariant
//! transactional display hosts rely on when they reassemble a frame from
//! reusable strips.
//!
//! The matrix covers every DrawList op family (RECT, GRAD_RECT both axes,
//! SCISSOR, TRI, TEX_QUAD 8888, TEX_TRI, GLYPH_RUN, SRM-eligible 5650
//! TEX_QUAD), all-software fallback via a declining PPA, SRM-through-PPA
//! strip locality and band splits, scale 2, per-row strips, offset windows,
//! and repeat determinism across mask reallocation.

use pocketjs_core::raster::render_scaled_rgb565;
use pocketjs_core::{spec, Ui};
use pocketjs_esp32p4_ppa::{PpaOps, Rect, Renderer, RendererConfig, SrmTransform};

fn xy_word(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}

fn wh_word(w: u16, h: u16) -> u32 {
    w as u32 | ((h as u32) << 16)
}

/// Declines every op: forces the renderer through the software window
/// fallback (`render_scaled_rgb565_window_over`) for every op family.
struct NoPpa;

impl PpaOps for NoPpa {
    fn fill_rgb565(&mut self, _: &mut [u16], _: u32, _: u32, _: Rect, _: u16) -> bool {
        false
    }
    fn blend_a8_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: &[u8],
        _: Rect,
        _: [u8; 3],
        _: u8,
    ) -> bool {
        false
    }
    fn srm_psm5650_to_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: &[u8],
        _: u32,
        _: u32,
        _: Rect,
        _: Rect,
        _: SrmTransform,
    ) -> bool {
        false
    }
}

/// Accepts only one-to-one SRM copies (software emulation, mirroring the
/// crate's MockPpa), declines fills/blends — probes SRM strip locality.
#[derive(Default)]
struct SrmOnlyPpa {
    srm_calls: u32,
    last_destination_rect: Rect,
}

impl PpaOps for SrmOnlyPpa {
    fn fill_rgb565(&mut self, _: &mut [u16], _: u32, _: u32, _: Rect, _: u16) -> bool {
        false
    }
    fn blend_a8_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: &[u8],
        _: Rect,
        _: [u8; 3],
        _: u8,
    ) -> bool {
        false
    }
    fn srm_psm5650_to_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        _height: u32,
        source: &[u8],
        source_width: u32,
        _source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
        transform: SrmTransform,
    ) -> bool {
        if transform.mirror_x
            || transform.mirror_y
            || source_rect.w != destination_rect.w
            || source_rect.h != destination_rect.h
        {
            return false;
        }
        self.srm_calls += 1;
        self.last_destination_rect = destination_rect;
        for dy in 0..destination_rect.h {
            let sy = source_rect.y + dy;
            for dx in 0..destination_rect.w {
                let sx = source_rect.x + dx;
                let source_index = (sy * source_width + sx) as usize * 2;
                let psm5650 = u16::from_le_bytes([source[source_index], source[source_index + 1]]);
                let rgb565 =
                    ((psm5650 & 0x001f) << 11) | (psm5650 & 0x07e0) | ((psm5650 & 0xf800) >> 11);
                let destination_index = (destination_rect.y + dy) as usize * width as usize
                    + (destination_rect.x + dx) as usize;
                destination[destination_index] = rgb565;
            }
        }
        true
    }
}

fn density_two_font() -> Vec<u8> {
    let coverage = [
        0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 255,
    ];
    let mut atlas = Vec::new();
    atlas.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    atlas.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    atlas.extend_from_slice(&1u16.to_le_bytes());
    atlas.extend_from_slice(&[2, 2, 2, 2, 0, 0, 2, 0]);
    atlas.extend_from_slice(&65u32.to_le_bytes());
    atlas.extend_from_slice(&0u16.to_le_bytes());
    atlas.extend_from_slice(&[2, 0]);
    atlas.extend_from_slice(&coverage);
    atlas
}

fn renderer(scale: u32) -> Renderer {
    Renderer::new(RendererConfig {
        scale,
        min_fill_pixels: 1,
        min_blend_pixels: 1,
        min_srm_pixels: 1,
    })
    .unwrap()
}

/// A 16x10 frame touching every op family, with ops deliberately crossing
/// horizontal strip boundaries so sampling phase matters.
fn full_matrix_scene() -> (Ui, Vec<u32>) {
    let mut ui = Ui::new_with_raster_density(2);
    ui.set_viewport(16.0, 10.0);
    assert!(ui.load_font_atlas(&density_two_font()));

    let rgba_pixels: Vec<u8> = (0..16u32)
        .flat_map(|value| {
            [
                (value * 16) as u8,
                255 - (value * 16) as u8,
                (value * 7) as u8,
                255,
            ]
        })
        .collect();
    let tex_rgba = ui.upload_texture(&rgba_pixels, 4, 4, spec::psm::PSM_8888);
    assert!(tex_rgba >= 0);

    let psm5650_pixels: Vec<u8> = (0..16u32)
        .flat_map(|value| ((value * 4093) as u16).to_le_bytes())
        .collect();
    let tex_5650 = ui.upload_texture(&psm5650_pixels, 4, 4, spec::psm::PSM_5650);
    assert!(tex_5650 >= 0);

    let words = vec![
        // opaque background rect
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff20_1008,
        // translucent horizontal gradient over everything
        spec::draw_op::GRAD_RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0x8000_0040,
        0x80c0_8000,
        spec::GradDir::ToRight as u32,
        // opaque vertical gradient column (fill_opaque rows in the window target)
        spec::draw_op::GRAD_RECT,
        xy_word(12, 0),
        wh_word(4, 10),
        0xff00_2010,
        0xffff_f0c0,
        spec::GradDir::ToBottom as u32,
        // scissored translucent gouraud triangle crossing all strip bands
        spec::draw_op::SCISSOR,
        xy_word(1, 1),
        wh_word(14, 8),
        spec::draw_op::TRI,
        xy_word(2, 1),
        xy_word(14, 9),
        xy_word(2, 9),
        0x80ff_0000,
        0x8000_ff00,
        0x8000_00ff,
        spec::draw_op::SCISSOR_POP,
        // RGBA texture quad straddling band 0/1
        spec::draw_op::TEX_QUAD,
        tex_rgba as u32,
        xy_word(4, 2),
        wh_word(4, 4),
        0.0f32.to_bits(),
        0.0f32.to_bits(),
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        0xffff_ffff,
        // modulated translucent textured triangle straddling band 1/2
        spec::draw_op::TEX_TRI,
        tex_rgba as u32,
        xy_word(8, 3),
        0.0f32.to_bits(),
        0.0f32.to_bits(),
        xy_word(15, 3),
        1.0f32.to_bits(),
        0.0f32.to_bits(),
        xy_word(8, 9),
        0.0f32.to_bits(),
        1.0f32.to_bits(),
        0x80ff_ffff,
        // glyphs in band 0 and band 2
        spec::draw_op::GLYPH_RUN,
        1 << 16,
        0xff00_ffcc,
        xy_word(3, 0),
        0,
        spec::draw_op::GLYPH_RUN,
        1 << 16,
        0xffff_4080,
        xy_word(9, 7),
        0,
        // SRM-eligible opaque one-to-one 5650 quad straddling band 1/2
        spec::draw_op::TEX_QUAD,
        tex_5650 as u32,
        xy_word(0, 6),
        wh_word(4, 4),
        0.0f32.to_bits(),
        0.0f32.to_bits(),
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        0xffff_ffff,
    ];
    (ui, words)
}

fn full_reference(ui: &Ui, words: &[u32], width: usize, height: usize, scale: u32) -> Vec<u16> {
    let mut output = vec![0u16; width * height * (scale * scale) as usize];
    render_scaled_rgb565(ui, words, &mut output, scale);
    output
}

fn assemble_strips<O: PpaOps>(
    renderer: &mut Renderer,
    ui: &Ui,
    words: &[u32],
    width: usize,
    bands: &[(u32, u32)],
    scale: u32,
    ppa: &mut O,
) -> Vec<u16> {
    let physical_width = width * scale as usize;
    let total_rows: u32 = bands.iter().map(|&(_, h)| h).sum();
    let base_row = bands.iter().map(|&(y, _)| y).min().unwrap_or(0);
    let mut output = vec![0u16; physical_width * (total_rows * scale) as usize];
    for &(y, h) in bands {
        let mut strip = vec![0u16; physical_width * (h * scale) as usize];
        let region = Rect {
            x: 0,
            y,
            w: width as u32,
            h,
        };
        renderer
            .render_strip(ui, words, &mut strip, region, ppa)
            .unwrap_or_else(|| panic!("strip y={y} h={h} failed"));
        let dst = ((y - base_row) * scale) as usize * physical_width;
        output[dst..dst + strip.len()].copy_from_slice(&strip);
    }
    output
}

#[test]
fn uneven_strip_tiling_reassembles_the_full_frame_for_every_op_family() {
    let (ui, words) = full_matrix_scene();
    let full = full_reference(&ui, &words, 16, 10, 1);
    let mut renderer = renderer(1);
    let tiled = assemble_strips(
        &mut renderer,
        &ui,
        &words,
        16,
        &[(0, 3), (3, 4), (7, 3)],
        1,
        &mut NoPpa,
    );
    assert_eq!(
        tiled, full,
        "3-band tiling must be byte-identical to a full render"
    );
}

#[test]
fn one_pixel_row_strips_reassemble_the_full_frame() {
    let (ui, words) = full_matrix_scene();
    let full = full_reference(&ui, &words, 16, 10, 1);
    let mut renderer = renderer(1);
    let bands: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
    let tiled = assemble_strips(&mut renderer, &ui, &words, 16, &bands, 1, &mut NoPpa);
    assert_eq!(
        tiled, full,
        "1px strips must be byte-identical to a full render"
    );
}

#[test]
fn scale_two_strip_tiling_reassembles_the_full_frame() {
    let (ui, words) = full_matrix_scene();
    let full = full_reference(&ui, &words, 16, 10, 2);
    let mut renderer = renderer(2);
    let tiled = assemble_strips(
        &mut renderer,
        &ui,
        &words,
        16,
        &[(0, 4), (4, 3), (7, 3)],
        2,
        &mut NoPpa,
    );
    assert_eq!(
        tiled, full,
        "scale-2 tiling must be byte-identical to a full render"
    );
}

#[test]
fn offset_window_matches_full_interior_and_leaves_exterior_untouched() {
    let (ui, words) = full_matrix_scene();
    let full = full_reference(&ui, &words, 16, 10, 1);
    let mut renderer = renderer(1);
    let region = Rect {
        x: 2,
        y: 1,
        w: 11,
        h: 5,
    };
    let untouched = 0x5aa5u16;
    let mut strip = vec![untouched; 16 * region.h as usize];
    renderer
        .render_strip(&ui, &words, &mut strip, region, &mut NoPpa)
        .unwrap();
    for local_y in 0..region.h as usize {
        let global_y = region.y as usize + local_y;
        for x in 0..16usize {
            let actual = strip[local_y * 16 + x];
            if x >= region.x as usize && x < (region.x + region.w) as usize {
                assert_eq!(actual, full[global_y * 16 + x], "pixel ({x},{global_y})");
            } else {
                assert_eq!(
                    actual, untouched,
                    "write escaped dirty x at ({x},{global_y})"
                );
            }
        }
    }
}

#[test]
fn rendering_the_same_strip_twice_is_byte_identical_despite_mask_churn() {
    let (ui, words) = full_matrix_scene();
    let mut renderer = renderer(1);
    let region = Rect {
        x: 0,
        y: 3,
        w: 16,
        h: 4,
    };
    let render_once = |renderer: &mut Renderer| {
        let mut strip = vec![0u16; 16 * 4];
        renderer
            .render_strip(&ui, &words, &mut strip, region, &mut NoPpa)
            .unwrap();
        strip
    };
    let first = render_once(&mut renderer);
    // churn the mask allocation with a taller and a 1px strip in between
    let mut tall = vec![0u16; 16 * 9];
    renderer
        .render_strip(
            &ui,
            &words,
            &mut tall,
            Rect {
                x: 0,
                y: 0,
                w: 16,
                h: 9,
            },
            &mut NoPpa,
        )
        .unwrap();
    let mut thin = vec![0u16; 16];
    renderer
        .render_strip(
            &ui,
            &words,
            &mut thin,
            Rect {
                x: 0,
                y: 9,
                w: 16,
                h: 1,
            },
            &mut NoPpa,
        )
        .unwrap();
    let second = render_once(&mut renderer);
    assert_eq!(
        first, second,
        "strip renders must be reproducible across mask churn"
    );
}

#[test]
fn srm_through_ppa_lands_in_strip_local_coordinates_and_matches_software() {
    let (ui, words) = full_matrix_scene();
    let full = full_reference(&ui, &words, 16, 10, 1);
    let mut renderer = renderer(1);
    let mut ppa = SrmOnlyPpa::default();
    // band y=6..10 contains the whole one-to-one 5650 quad (0,6)-(4,10)
    let region = Rect {
        x: 0,
        y: 6,
        w: 16,
        h: 4,
    };
    let mut strip = vec![0u16; 16 * 4];
    renderer
        .render_strip(&ui, &words, &mut strip, region, &mut ppa)
        .unwrap();
    assert!(ppa.srm_calls >= 1, "SRM path must engage for the 5650 quad");
    assert_eq!(
        ppa.last_destination_rect,
        Rect {
            x: 0,
            y: 0,
            w: 4,
            h: 4
        },
        "SRM destination must be strip-local"
    );
    for local_y in 0..4usize {
        let global_y = 6 + local_y;
        for x in 0..16usize {
            assert_eq!(
                strip[local_y * 16 + x],
                full[global_y * 16 + x],
                "pixel ({x},{global_y})"
            );
        }
    }
}

#[test]
fn split_srm_band_boundary_matches_software() {
    // Split the 5650 quad across two strips (y=6..8 and y=8..10): the SRM
    // source rect must advance with the band, not restart at the texture top.
    let (ui, words) = full_matrix_scene();
    let full = full_reference(&ui, &words, 16, 10, 1);
    let mut renderer = renderer(1);
    let mut ppa = SrmOnlyPpa::default();
    let tiled = assemble_strips(
        &mut renderer,
        &ui,
        &words,
        16,
        &[(6, 2), (8, 2)],
        1,
        &mut ppa,
    );
    assert!(ppa.srm_calls >= 2, "both half-bands must engage SRM");
    for local_y in 0..4usize {
        let global_y = 6 + local_y;
        for x in 0..16usize {
            assert_eq!(
                tiled[local_y * 16 + x],
                full[global_y * 16 + x],
                "pixel ({x},{global_y})"
            );
        }
    }
}
