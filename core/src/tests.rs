//! Core behavior tests (run with `cargo test` — the dev-dependency
//! self-reference turns the `std` feature on for the harness).

use alloc::vec::Vec;

use crate::{spec, style, Ui};

// ---- binary blob builders (bytes hand-assembled per spec.ts formats) --------

struct StyleSpec {
    base: Vec<(u8, u32)>,
    focus: Vec<(u8, u32)>,
    active: Vec<(u8, u32)>,
    /// (mask, dur_ms, delay_ms, easing)
    transition: Option<(u32, u16, u16, u8)>,
    /// (loop_frames, anim ids)
    animation: Option<(u16, Vec<u16>)>,
}

impl StyleSpec {
    fn new() -> StyleSpec {
        StyleSpec {
            base: Vec::new(),
            focus: Vec::new(),
            active: Vec::new(),
            transition: None,
            animation: None,
        }
    }
}

/// One baked-timeline segment: (t0, t1, from, to, easing, bezier).
struct SegSpec(u16, u16, u32, u32, u8, Option<[f32; 4]>);

/// One ANIM TABLE entry: header + (prop, segments) tracks.
struct AnimSpec {
    delay_frames: u16,
    period_frames: u16,
    iterations: u16,
    fill: u8,
    tracks: Vec<(u8, Vec<SegSpec>)>,
}

fn encode_styles(styles: &[StyleSpec]) -> Vec<u8> {
    encode_styles_with_anims(styles, &[])
}

fn encode_styles_with_anims(styles: &[StyleSpec], anims: &[AnimSpec]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&spec::style_table::MAGIC.to_le_bytes());
    out.extend_from_slice(&spec::style_table::VERSION.to_le_bytes());
    out.extend_from_slice(&(styles.len() as u16).to_le_bytes());
    out.extend_from_slice(&(anims.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]); // reserved
    for s in styles {
        let mut flags = 0u8;
        if !s.base.is_empty() {
            flags |= spec::style_table::VARIANT_BASE;
        }
        if !s.focus.is_empty() {
            flags |= spec::style_table::VARIANT_FOCUS;
        }
        if !s.active.is_empty() {
            flags |= spec::style_table::VARIANT_ACTIVE;
        }
        if s.transition.is_some() {
            flags |= spec::style_table::HAS_TRANSITION;
        }
        if s.animation.is_some() {
            flags |= spec::style_table::HAS_ANIMATION;
        }
        out.push(flags);
        if let Some((mask, dur, delay, easing)) = s.transition {
            out.extend_from_slice(&mask.to_le_bytes());
            out.extend_from_slice(&dur.to_le_bytes());
            out.extend_from_slice(&delay.to_le_bytes());
            out.push(easing);
            out.extend_from_slice(&[0, 0, 0]);
        }
        if let Some((loop_frames, ids)) = &s.animation {
            out.push(ids.len() as u8);
            out.extend_from_slice(&loop_frames.to_le_bytes());
            for id in ids {
                out.extend_from_slice(&id.to_le_bytes());
            }
        }
        for v in [&s.base, &s.focus, &s.active] {
            if v.is_empty() {
                continue;
            }
            out.push(v.len() as u8);
            for &(prop, value) in v {
                out.push(prop);
                out.push(0);
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    for a in anims {
        out.extend_from_slice(&a.delay_frames.to_le_bytes());
        out.extend_from_slice(&a.period_frames.to_le_bytes());
        out.extend_from_slice(&a.iterations.to_le_bytes());
        out.push(a.fill);
        out.push(a.tracks.len() as u8);
        for (prop, segs) in &a.tracks {
            out.push(*prop);
            out.push(segs.len() as u8);
            for SegSpec(t0, t1, from, to, easing, bezier) in segs {
                out.extend_from_slice(&t0.to_le_bytes());
                out.extend_from_slice(&t1.to_le_bytes());
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.push(*easing);
                out.push(0);
                if let Some(bz) = bezier {
                    for v in bz {
                        out.extend_from_slice(&v.to_bits().to_le_bytes());
                    }
                }
            }
        }
    }
    out
}

/// Synthetic font atlas: `glyphs` are (codepoint, gid, advance), sorted by
/// codepoint. Coverage cells are all-zero (metrics are what the tests exercise).
fn encode_atlas(
    slot: u8,
    cell_w: u8,
    cell_h: u8,
    baseline: u8,
    line_height: u8,
    glyph_count: u16,
    glyphs: &[(u32, u16, u8)],
) -> Vec<u8> {
    encode_atlas_version_density(
        spec::font_atlas::VERSION,
        1,
        slot,
        cell_w,
        cell_h,
        baseline,
        line_height,
        glyph_count,
        glyphs,
    )
}

#[allow(clippy::too_many_arguments)]
fn encode_atlas_version_density(
    version: u16,
    raster_density: u8,
    slot: u8,
    cell_w: u8,
    cell_h: u8,
    baseline: u8,
    line_height: u8,
    glyph_count: u16,
    glyphs: &[(u32, u16, u8)],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&(glyphs.len() as u16).to_le_bytes());
    out.push(cell_w);
    out.push(cell_h);
    out.push(baseline);
    out.push(line_height);
    out.push(slot);
    out.push(0); // flags
    out.push(raster_density);
    out.push(0); // reserved
    assert_eq!(glyphs.len(), glyph_count as usize, "test blob: glyphCount == cmap entries");
    for &(cp, gid, adv) in glyphs {
        out.extend_from_slice(&cp.to_le_bytes());
        out.extend_from_slice(&gid.to_le_bytes());
        out.push(adv);
        out.push(0);
    }
    let bytes_per_row = cell_w as usize * raster_density.max(1) as usize;
    let coverage_h = cell_h as usize * raster_density.max(1) as usize;
    out.extend_from_slice(&alloc::vec![0u8; glyph_count as usize * coverage_h * bytes_per_row]);
    out
}

fn abgr(r: u8, g: u8, b: u8, a: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32
}

// ---- DrawList decoding helpers ------------------------------------------------

fn decode_xy(word: u32) -> (i32, i32) {
    ((word & 0xffff) as u16 as i16 as i32, (word >> 16) as u16 as i16 as i32)
}

fn decode_wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

/// Walk a DrawList asserting the pinned CPU-clip invariant: every coordinate
/// in [0, SCREEN_W] x [0, SCREEN_H], rect extents in range, scissors
/// balanced, only known ops. Returns per-op counts (indexed by op code).
fn validate_drawlist(words: &[u32]) -> [u32; 8] {
    let (sw, sh) = (spec::SCREEN_W as i32, spec::SCREEN_H as i32);
    let xy_ok = |w: u32| {
        let (x, y) = decode_xy(w);
        assert!((0..=sw).contains(&x) && (0..=sh).contains(&y), "coord out of range: ({x},{y})");
    };
    let rect_ok = |xyw: u32, whw: u32| {
        xy_ok(xyw);
        let (x, y) = decode_xy(xyw);
        let (w, h) = decode_wh(whw);
        assert!(x + w <= sw && y + h <= sh, "rect exceeds screen: {x},{y} {w}x{h}");
    };
    let mut counts = [0u32; 8];
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < words.len() {
        let op = words[i];
        counts[op as usize] += 1;
        match op {
            spec::draw_op::RECT => {
                rect_ok(words[i + 1], words[i + 2]);
                i += 4;
            }
            spec::draw_op::GRAD_RECT => {
                rect_ok(words[i + 1], words[i + 2]);
                assert!(words[i + 5] <= 3, "bad GradDir");
                i += 6;
            }
            spec::draw_op::GLYPH_RUN => {
                let n = (words[i + 1] >> 16) as usize;
                assert!(n > 0, "empty glyph run emitted");
                for g in 0..n {
                    xy_ok(words[i + 3 + g * 2]);
                }
                i += 3 + 2 * n;
            }
            spec::draw_op::TEX_QUAD => {
                rect_ok(words[i + 2], words[i + 3]);
                for uv in 4..8 {
                    let f = f32::from_bits(words[i + uv]);
                    assert!((0.0..=1.0).contains(&f), "UV out of range: {f}");
                }
                i += 9;
            }
            spec::draw_op::SCISSOR => {
                rect_ok(words[i + 1], words[i + 2]);
                depth += 1;
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                depth -= 1;
                assert!(depth >= 0, "unbalanced SCISSOR_POP");
                i += 1;
            }
            spec::draw_op::TRI => {
                xy_ok(words[i + 1]);
                xy_ok(words[i + 2]);
                xy_ok(words[i + 3]);
                i += 7;
            }
            other => panic!("unknown draw op {other} at word {i}"),
        }
    }
    assert_eq!(depth, 0, "unbalanced SCISSOR/SCISSOR_POP");
    counts
}

// ---- tests ---------------------------------------------------------------------

#[test]
fn arena_id_reuse_and_stale_id_noop() {
    let mut ui = Ui::new();
    let a = ui.create_node(spec::NodeType::View as u8);
    assert!(a > 0);
    ui.insert_before(spec::ROOT_ID, a, 0);
    ui.destroy_node(a);
    // Slot is reused with a bumped generation -> different id, same slot.
    let b = ui.create_node(spec::NodeType::View as u8);
    assert_ne!(a, b);
    assert_eq!(a & spec::ID_SLOT_MASK as i32, b & spec::ID_SLOT_MASK as i32);
    // Ops on the stale id are silent no-ops and don't touch the new node.
    ui.set_prop(a, spec::prop::WIDTH, 123.0);
    ui.set_text(a, "stale");
    ui.destroy_node(a);
    assert!(ui.layout_of(a).is_none());
    assert!(ui.layout_of(b).is_some());
    assert_eq!(ui.animate(a, spec::prop::OPACITY, 0.0, 100, 0, 0), -1);
}

#[test]
fn insert_before_dom_move_semantics() {
    let mut ui = Ui::new();
    let mk = |ui: &mut Ui, h: f64| {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::HEIGHT, h);
        ui.insert_before(spec::ROOT_ID, n, 0);
        n
    };
    let a = mk(&mut ui, 10.0);
    let b = mk(&mut ui, 20.0);
    let c = mk(&mut ui, 30.0);
    ui.tick();
    // Column: a@0, b@10, c@30.
    assert_eq!(ui.layout_of(c).unwrap().1, 30.0);
    // Move c before a WITHOUT removing first (DOM move semantics).
    ui.insert_before(spec::ROOT_ID, c, a);
    ui.tick();
    // New order c, a, b: c@0, a@30, b@40.
    assert_eq!(ui.layout_of(c).unwrap().1, 0.0);
    assert_eq!(ui.layout_of(a).unwrap().1, 30.0);
    assert_eq!(ui.layout_of(b).unwrap().1, 40.0);
    // Move across parents: b into a wrapper -> gone from root flow.
    let wrap = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, wrap, 0);
    ui.insert_before(wrap, b, 0);
    ui.tick();
    assert_eq!(ui.layout_of(b).unwrap().1, 0.0); // now relative to wrap
    // Cycle guard: inserting an ancestor under its descendant is a no-op.
    ui.insert_before(b, wrap, 0);
    ui.tick();
    assert_eq!(ui.layout_of(wrap).unwrap().1, 40.0); // still under root, after c+a
}

#[test]
fn style_resolution_with_focus_variant() {
    let mut ui = Ui::new();
    let red = abgr(255, 0, 0, 255);
    let green = abgr(0, 255, 0, 255);
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::BG_COLOR, red), (spec::prop::WIDTH, 100f32.to_bits())];
    s.focus = alloc::vec![(spec::prop::BG_COLOR, green)];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    assert_eq!(ui.resolved_style(n).unwrap().width, 100.0);
    ui.set_focus(n);
    assert_eq!(ui.focused(), n);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, green);
    ui.set_focus(0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    // Dynamic override sits on top of every variant.
    let blue = abgr(0, 0, 255, 255);
    ui.set_prop(n, spec::prop::BG_COLOR, blue as f64);
    ui.set_focus(n);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, blue);
    // Destroying the focused node clears focus.
    ui.destroy_node(n);
    assert_eq!(ui.focused(), 0);
}

#[test]
fn set_style_diff_spawns_transition() {
    let mut ui = Ui::new();
    let red = abgr(255, 0, 0, 255);
    let blue = abgr(0, 0, 255, 255);
    let bg_bit = 16; // spec.ts ANIMATABLE order: bgColor = bit 16
    assert_eq!(spec::ANIM_BIT[spec::prop::BG_COLOR as usize], bg_bit as u8);
    let mut s0 = StyleSpec::new();
    s0.base = alloc::vec![(spec::prop::BG_COLOR, red)];
    let mut s1 = StyleSpec::new();
    s1.base = alloc::vec![(spec::prop::BG_COLOR, blue)];
    s1.transition = Some((1 << bg_bit, 300, 0, spec::Easing::Linear as u8)); // 18 frames
    assert!(ui.load_styles(&encode_styles(&[s0, s1])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    ui.set_style(n, 1);
    // Transition holds the OLD value at spawn (from = current appearance).
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    for _ in 0..9 {
        ui.tick(); // halfway through 18 frames
    }
    let mid = ui.resolved_style(n).unwrap().bg_color;
    assert_ne!(mid, red);
    assert_ne!(mid, blue);
    let midpoint = crate::anim::interp(red, blue, 0.5, true);
    assert_eq!(mid, midpoint);
    for _ in 0..20 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, blue);
    // Props NOT in the mask never tween: swap back to s0 — bgColor tweens,
    // but a style without a transition block snaps.
    ui.set_style(n, 0);
    ui.tick();
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
}

#[test]
fn first_style_assignment_skips_transition_from_defaults() {
    let mut ui = Ui::new();
    let blue = abgr(0, 0, 255, 255);
    let green = abgr(0, 255, 0, 255);
    let bg_bit = spec::ANIM_BIT[spec::prop::BG_COLOR as usize] as u32;

    let mut s0 = StyleSpec::new();
    s0.base = alloc::vec![(spec::prop::BG_COLOR, blue)];
    s0.transition = Some((1 << bg_bit, 300, 0, spec::Easing::Linear as u8));
    let mut s1 = StyleSpec::new();
    s1.base = alloc::vec![(spec::prop::BG_COLOR, green)];
    s1.transition = Some((1 << bg_bit, 300, 0, spec::Easing::Linear as u8));
    assert!(ui.load_styles(&encode_styles(&[s0, s1])));

    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, blue);

    ui.set_style(n, 1);
    assert_eq!(
        ui.resolved_style(n).unwrap().bg_color,
        blue,
        "subsequent style changes still transition from the old appearance",
    );
}

#[test]
fn fixed_dt_animation_is_deterministic() {
    fn run() -> Vec<Vec<u32>> {
        let mut ui = Ui::new();
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 60.0);
        ui.set_prop(n, spec::prop::HEIGHT, 40.0);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(200, 100, 50, 255) as f64);
        ui.insert_before(spec::ROOT_ID, n, 0);
        ui.animate(n, spec::prop::TRANSLATE_X, 300.0, 500, spec::Easing::OutBack as u8, 32);
        ui.animate(n, spec::prop::ROTATE, 65.0, 400, spec::Easing::Spring as u8, 0);
        ui.animate(n, spec::prop::BG_COLOR, abgr(10, 220, 30, 255) as f64, 250, spec::Easing::EaseInOut as u8, 0);
        let mut frames = Vec::new();
        for _ in 0..70 {
            ui.tick();
            frames.push(ui.draw().words.clone());
        }
        frames
    }
    let a = run();
    let b = run();
    assert_eq!(a, b, "two identical runs must produce byte-equal DrawLists");
    for f in &a {
        validate_drawlist(f);
    }
    // The rotated frames must actually exercise the TRI path.
    let tri_frames = a
        .iter()
        .filter(|f| validate_drawlist(f)[spec::draw_op::TRI as usize] > 0)
        .count();
    assert!(tri_frames > 0, "rotation should emit TRI ops");
}

#[test]
fn gap_column_layout_matches_hand_computed() {
    let mut ui = Ui::new();
    ui.set_prop(spec::ROOT_ID, spec::prop::GAP, 10.0);
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_T, 5.0);
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_L, 7.0);
    let mut kids = Vec::new();
    for h in [40.0, 50.0, 60.0] {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 100.0);
        ui.set_prop(n, spec::prop::HEIGHT, h);
        ui.insert_before(spec::ROOT_ID, n, 0);
        kids.push(n);
    }
    ui.tick();
    assert_eq!(ui.layout_of(spec::ROOT_ID).unwrap(), (0.0, 0.0, 480.0, 272.0));
    // Column: y = paddingT + sum(prev heights + gaps), x = paddingL.
    assert_eq!(ui.layout_of(kids[0]).unwrap(), (7.0, 5.0, 100.0, 40.0));
    assert_eq!(ui.layout_of(kids[1]).unwrap(), (7.0, 55.0, 100.0, 50.0));
    assert_eq!(ui.layout_of(kids[2]).unwrap(), (7.0, 115.0, 100.0, 60.0));
}

#[test]
fn absolute_child_does_not_consume_flex_space() {
    let mut ui = Ui::new();
    ui.set_prop(spec::ROOT_ID, spec::prop::FLEX_DIR, spec::FlexDir::Row as u32 as f64);

    let app = ui.create_node(0);
    ui.set_prop(app, spec::prop::WIDTH, 480.0);
    ui.set_prop(app, spec::prop::HEIGHT, 272.0);
    ui.insert_before(spec::ROOT_ID, app, 0);

    let overlay = ui.create_node(0);
    ui.set_prop(overlay, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(overlay, spec::prop::INSET_T, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_R, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_B, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_L, 0.0);
    ui.insert_before(spec::ROOT_ID, overlay, 0);

    ui.tick();
    assert_eq!(ui.layout_of(app).unwrap(), (0.0, 0.0, 480.0, 272.0));
    assert_eq!(ui.layout_of(overlay).unwrap(), (0.0, 0.0, 480.0, 272.0));
}

#[test]
fn empty_text_nodes_are_excluded_from_layout() {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    )));
    ui.set_prop(spec::ROOT_ID, spec::prop::GAP, 10.0);
    // align-items start so the text node keeps its measured width instead of
    // stretching to the column's cross size.
    ui.set_prop(spec::ROOT_ID, spec::prop::ALIGN, spec::Align::Start as u32 as f64);
    let a = ui.create_node(0);
    ui.set_prop(a, spec::prop::HEIGHT, 20.0);
    ui.insert_before(spec::ROOT_ID, a, 0);
    let t = ui.create_node(spec::NodeType::Text as u8); // Solid <Show> marker
    ui.insert_before(spec::ROOT_ID, t, 0);
    let b = ui.create_node(0);
    ui.set_prop(b, spec::prop::HEIGHT, 20.0);
    ui.insert_before(spec::ROOT_ID, b, 0);
    ui.tick();
    // The empty text node consumes NO space and NO gap [R]: b sits at 30.
    assert_eq!(ui.layout_of(b).unwrap().1, 30.0);
    assert_eq!(ui.layout_of(t).unwrap(), (0.0, 0.0, 0.0, 0.0));
    // replace_text makes it participate: one line of "AB" = 11x10.
    ui.replace_text(t, "AB");
    ui.tick();
    let (_, ty, tw, th) = ui.layout_of(t).unwrap();
    assert_eq!((ty, tw, th), (30.0, 11.0, 10.0));
    assert_eq!(ui.layout_of(b).unwrap().1, 50.0);
    // And back to empty -> excluded again.
    ui.replace_text(t, "");
    ui.tick();
    assert_eq!(ui.layout_of(b).unwrap().1, 30.0);
}

#[test]
fn drawlist_clip_invariant_offscreen_rects() {
    let mut ui = Ui::new();
    // Partially off every edge + fully off + rotated partially off.
    let cases: [(f64, f64, f64); 5] = [
        (450.0, 250.0, 0.0),   // off bottom-right
        (-30.0, -20.0, 0.0),   // off top-left
        (600.0, 10.0, 0.0),    // fully off right
        (400.0, -30.0, 45.0),  // rotated, off top-right
        (-40.0, 240.0, 30.0),  // rotated, off bottom-left
    ];
    for (tx, ty, rot) in cases {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 100.0);
        ui.set_prop(n, spec::prop::HEIGHT, 60.0);
        ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(n, spec::prop::INSET_T, 0.0);
        ui.set_prop(n, spec::prop::INSET_L, 0.0);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(255, 255, 255, 255) as f64);
        ui.set_prop(n, spec::prop::BORDER_COLOR, abgr(0, 0, 0, 255) as f64);
        ui.set_prop(n, spec::prop::BORDER_WIDTH, 3.0);
        ui.set_prop(n, spec::prop::TRANSLATE_X, tx);
        ui.set_prop(n, spec::prop::TRANSLATE_Y, ty);
        ui.set_prop(n, spec::prop::ROTATE, rot);
        ui.insert_before(spec::ROOT_ID, n, 0);
    }
    // A gradient clipped at the screen edge must re-interpolate, not clamp.
    let g = ui.create_node(0);
    ui.set_prop(g, spec::prop::WIDTH, 200.0);
    ui.set_prop(g, spec::prop::HEIGHT, 40.0);
    ui.set_prop(g, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(g, spec::prop::INSET_T, 0.0);
    ui.set_prop(g, spec::prop::INSET_L, 0.0);
    ui.set_prop(g, spec::prop::GRAD_FROM, abgr(0, 0, 0, 255) as f64);
    ui.set_prop(g, spec::prop::GRAD_TO, abgr(200, 200, 200, 255) as f64);
    ui.set_prop(g, spec::prop::GRAD_DIR, spec::GradDir::ToRight as u32 as f64);
    ui.set_prop(g, spec::prop::TRANSLATE_X, 380.0); // visible span = half
    ui.insert_before(spec::ROOT_ID, g, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert!(counts[spec::draw_op::RECT as usize] > 0);
    assert!(counts[spec::draw_op::TRI as usize] > 0, "rotated offscreen boxes clip into TRIs");
    assert!(counts[spec::draw_op::GRAD_RECT as usize] > 0);
    // Find the gradient and check the endpoint re-interpolation: the rect
    // spans x 380..580, the clip keeps 380..480 = fractions 0.0..0.5, so the
    // from-color is untouched and the to-color becomes lerp(from, to, 0.5).
    let mut i = 0usize;
    let mut found = false;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => {
                let (x, _) = decode_xy(words[i + 1]);
                let (w, _) = decode_wh(words[i + 2]);
                assert_eq!((x, w), (380, 100));
                assert_eq!(words[i + 3], abgr(0, 0, 0, 255)); // from untouched (clip starts at 0.0)
                let expected = crate::anim::interp(abgr(0, 0, 0, 255), abgr(200, 200, 200, 255), 0.5, true);
                assert_eq!(words[i + 4], expected, "gradient to-color re-interpolated over the clip");
                found = true;
                i += 6;
            }
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert!(found, "gradient rect must survive the clip");
}

#[test]
fn rounded_boxes_emit_subpixel_edge_coverage() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 36.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.5);
    ui.set_prop(n, spec::prop::INSET_L, 10.5);
    ui.set_prop(n, spec::prop::RADIUS, 10.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(37, 99, 235, 255) as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert!(counts[spec::draw_op::RECT as usize] > 0);
    // Flat rounded boxes now render their corners as four baked-disc
    // TEX_QUAD sprites (O(1) per box; the AA lives in the disc texture) +
    // solid RECT bands. Assert the corner sprites and that the baked disc
    // actually carries partial coverage alpha.
    let mut corner_quads = 0usize;
    let mut disc_tex = None;
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => {
                corner_quads += 1;
                disc_tex = Some(words[i + 1] as i32);
                i += 9;
            }
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert_eq!(corner_quads, 4, "four corner sprites per rounded box");
    let view = ui.texture(disc_tex.unwrap()).expect("baked disc texture");
    assert_eq!(view.psm, spec::psm::PSM_8888);
    let mut partial = false;
    for px in view.pixels.chunks_exact(4).take((view.w * view.w) as usize) {
        if px[3] > 0 && px[3] < 255 {
            partial = true;
            break;
        }
    }
    assert!(partial, "the baked disc must carry antialiased coverage alpha");
}

#[test]
fn rounded_corner_masks_follow_raster_density_without_changing_layout() {
    let mut ui = Ui::new_with_raster_density(2);
    assert_eq!(ui.raster_density(), 2);
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 36.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.0);
    ui.set_prop(n, spec::prop::INSET_L, 10.0);
    ui.set_prop(n, spec::prop::RADIUS, 10.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(37, 99, 235, 255) as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();

    let words = ui.draw().words.clone();
    let i = words.iter().position(|&word| word == spec::draw_op::TEX_QUAD).unwrap();
    let view = ui.texture(words[i + 1] as i32).expect("density-scaled disc texture");
    assert_eq!((view.w, view.h), (64, 64), "20px disc at 2x is padded to 64px");
    assert_eq!(decode_wh(words[i + 3]), (10, 10), "DrawList geometry stays logical");
    assert_eq!(f32::from_bits(words[i + 6]), 20.0 / 64.0, "UV selects one 2x quadrant");
}

#[test]
#[should_panic(expected = "raster density must be an integer from 1 through 255")]
fn ui_rejects_zero_raster_density() {
    let _ = Ui::new_with_raster_density(0);
}

#[test]
fn transparent_rounded_border_draws_an_outline_not_square_strips() {
    let mut ui = Ui::new();
    let blue = abgr(37, 99, 235, 255);
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 20.0);
    ui.set_prop(n, spec::prop::HEIGHT, 12.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.0);
    ui.set_prop(n, spec::prop::INSET_L, 10.0);
    ui.set_prop(n, spec::prop::RADIUS, 6.0);
    ui.set_prop(n, spec::prop::BORDER_COLOR, blue as f64);
    ui.set_prop(n, spec::prop::BORDER_WIDTH, 1.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();

    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert!(counts[spec::draw_op::RECT as usize] > 0);

    let mut covers_top_mid = false;
    let mut covers_left_mid = false;
    let mut covers_outer_corner = false;
    let mut covers_center = false;
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => {
                let (x, y) = decode_xy(words[i + 1]);
                let (w, h) = decode_wh(words[i + 2]);
                let c = words[i + 3];
                let covers = |px: i32, py: i32| px >= x && px < x + w && py >= y && py < y + h;
                if c & 0x00ff_ffff == blue & 0x00ff_ffff && c >> 24 > 0 {
                    covers_top_mid |= covers(20, 10);
                    covers_left_mid |= covers(10, 16);
                    covers_outer_corner |= covers(10, 10);
                    covers_center |= covers(20, 16);
                }
                i += 4;
            }
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert!(covers_top_mid, "top edge should be present");
    assert!(covers_left_mid, "left edge should be present");
    assert!(!covers_outer_corner, "rounded transparent border must not draw square outer corners");
    assert!(!covers_center, "transparent border must not fill the center");
}

#[test]
fn rounded_gradients_emit_rect_coverage_spans() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 120.0);
    ui.set_prop(n, spec::prop::HEIGHT, 12.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 20.0);
    ui.set_prop(n, spec::prop::INSET_L, 20.0);
    ui.set_prop(n, spec::prop::RADIUS, 6.0);
    ui.set_prop(n, spec::prop::GRAD_FROM, abgr(251, 191, 36, 255) as f64);
    ui.set_prop(n, spec::prop::GRAD_TO, abgr(217, 119, 6, 255) as f64);
    ui.set_prop(n, spec::prop::GRAD_DIR, spec::GradDir::ToRight as u32 as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert!(counts[spec::draw_op::RECT as usize] > 0);
    assert_eq!(
        counts[spec::draw_op::GRAD_RECT as usize], 0,
        "rounded gradients must not rely on 1px-high GRAD_RECT triangle strips"
    );
}

#[test]
fn overflow_hidden_emits_balanced_intersected_scissors() {
    let mut ui = Ui::new();
    let outer = ui.create_node(0);
    ui.set_prop(outer, spec::prop::WIDTH, 100.0);
    ui.set_prop(outer, spec::prop::HEIGHT, 80.0);
    ui.set_prop(outer, spec::prop::OVERFLOW, spec::Overflow::Hidden as u32 as f64);
    ui.insert_before(spec::ROOT_ID, outer, 0);
    let inner = ui.create_node(0);
    ui.set_prop(inner, spec::prop::WIDTH, 300.0); // overflows outer
    ui.set_prop(inner, spec::prop::HEIGHT, 300.0);
    ui.set_prop(inner, spec::prop::OVERFLOW, spec::Overflow::Hidden as u32 as f64);
    ui.set_prop(inner, spec::prop::SHRINK, 0.0);
    ui.insert_before(outer, inner, 0);
    let leaf = ui.create_node(0);
    ui.set_prop(leaf, spec::prop::WIDTH, 500.0);
    ui.set_prop(leaf, spec::prop::HEIGHT, 500.0);
    ui.set_prop(leaf, spec::prop::SHRINK, 0.0);
    ui.set_prop(leaf, spec::prop::BG_COLOR, abgr(9, 9, 9, 255) as f64);
    ui.insert_before(inner, leaf, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::SCISSOR as usize], 2);
    assert_eq!(counts[spec::draw_op::SCISSOR_POP as usize], 2);
    // Every scissor rect is pre-intersected with the enclosing ones: the
    // inner scissor must equal the outer 100x80 (300x300 ∩ 100x80).
    let mut rects = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::SCISSOR => {
                rects.push((decode_xy(words[i + 1]), decode_wh(words[i + 2])));
                i += 3;
            }
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            _ => i += 1,
        }
    }
    assert_eq!(rects, alloc::vec![((0, 0), (100, 80)), ((0, 0), (100, 80))]);
    // The leaf rect is clipped inside them.
    // (validate_drawlist already guarantees range; check tighter bound:)
    let mut i = 0usize;
    let mut depth = 0;
    while i < words.len() {
        match words[i] {
            spec::draw_op::SCISSOR => {
                depth += 1;
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                depth -= 1;
                i += 1;
            }
            spec::draw_op::RECT => {
                if depth == 2 {
                    let (x, y) = decode_xy(words[i + 1]);
                    let (w, h) = decode_wh(words[i + 2]);
                    assert!(x + w <= 100 && y + h <= 80, "leaf rect not clipped to scissor");
                }
                i += 4;
            }
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            _ => i += 1,
        }
    }
}

#[test]
fn text_measurement_against_synthetic_atlas() {
    let mut ui = Ui::new();
    let blob = encode_atlas(
        2,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    );
    assert!(ui.load_font_atlas(&blob));
    // Bad blobs are rejected.
    assert!(!ui.load_font_atlas(&blob[..10]));
    assert!(!ui.load_font_atlas(&[0u8; 64]));
    assert_eq!(ui.measure_text("AB", 2), 11.0);
    assert_eq!(ui.measure_text("ABA", 2), 17.0);
    assert_eq!(ui.measure_text("AB\nA", 2), 11.0); // max line
    assert_eq!(ui.measure_text("", 2), 0.0);
    assert_eq!(ui.measure_text("A", 0), 0.0); // unregistered slot
    // cmap miss -> tofu (gid 0) + miss counter, advance = cell width.
    assert_eq!(ui.glyph_misses(), 0);
    assert_eq!(ui.measure_text("Z", 2), 8.0);
    assert_eq!(ui.glyph_misses(), 1);
    // Atlas accessor exposes glyph bitmaps for the backends.
    let atlas = ui.font_atlas(2).unwrap();
    assert_eq!(atlas.lookup('B' as u32), Some((2, 5)));
    assert_eq!(atlas.glyph_rows(1).len(), 64); // cellH * cellW coverage bytes
}

#[test]
fn font_atlas_v3_scales_coverage_without_scaling_layout_metrics() {
    let glyphs = &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)];
    let mut ui = Ui::new();
    let mut hd = encode_atlas_version_density(
        spec::font_atlas::VERSION,
        2,
        2,
        8,
        8,
        7,
        10,
        3,
        glyphs,
    );
    // gid 1, logical pixel (0,0): four density-2 samples reduce to their
    // rounded mean, not the top-left sample.
    let bitmap_off = spec::font_atlas::HEADER_SIZE
        + glyphs.len() * spec::font_atlas::CMAP_ENTRY_SIZE;
    let coverage_w = 16usize;
    let coverage_h = 16usize;
    let gid_1 = bitmap_off + coverage_w * coverage_h;
    hd[gid_1] = 0;
    hd[gid_1 + 1] = 64;
    hd[gid_1 + coverage_w] = 128;
    hd[gid_1 + coverage_w + 1] = 255;
    assert!(ui.load_font_atlas(&hd));
    let atlas = ui.font_atlas(2).unwrap();
    assert_eq!(atlas.raster_density, 2);
    assert_eq!((atlas.cell_w, atlas.cell_h), (8, 8));
    assert_eq!((atlas.coverage_width(), atlas.coverage_height()), (16, 16));
    assert_eq!(atlas.bytes_per_row(), 16);
    assert_eq!(atlas.glyph_rows(1).len(), 16 * 16);
    assert_eq!(atlas.logical_coverage(1, 0, 0), 112);
    assert_eq!(atlas.logical_coverage(1, 8, 0), 0, "out-of-range is transparent");
    // Advances, line height, and therefore app layout stay in logical px.
    assert_eq!(ui.measure_text("AB", 2), 11.0);

    // v2 used header bytes 14..15 as zeroed reserved bytes. New cores load it
    // as density 1 so already-built packs remain compatible.
    let mut legacy = encode_atlas_version_density(2, 0, 3, 8, 8, 7, 10, 3, glyphs);
    let legacy_gid_1 = bitmap_off + 8 * 8;
    legacy[legacy_gid_1] = 173;
    assert!(ui.load_font_atlas(&legacy));
    let legacy_atlas = ui.font_atlas(3).unwrap();
    assert_eq!(legacy_atlas.raster_density, 1);
    assert_eq!((legacy_atlas.coverage_width(), legacy_atlas.coverage_height()), (8, 8));
    assert_eq!(legacy_atlas.glyph_rows(1).len(), 8 * 8);
    assert_eq!(legacy_atlas.logical_coverage(1, 0, 0), 173);
    assert_eq!(ui.measure_text("AB", 3), 11.0);

    // Density zero has no meaning in v3, and truncation is checked against
    // density-scaled coverage rather than only logical cell dimensions.
    let invalid_density = encode_atlas_version_density(
        spec::font_atlas::VERSION,
        0,
        4,
        8,
        8,
        7,
        10,
        3,
        glyphs,
    );
    assert!(!ui.load_font_atlas(&invalid_density));
    assert!(!ui.load_font_atlas(&hd[..hd.len() - 1]));
}

#[test]
fn glyph_runs_render_with_alignment_and_color() {
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    let color = abgr(10, 20, 30, 255);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::WIDTH, 51.0);
    ui.set_prop(t, spec::prop::TEXT_COLOR, color as f64);
    ui.set_prop(t, spec::prop::TEXT_ALIGN, spec::TextAlign::Right as u32 as f64);
    // Mixed run: element text + text-node child concatenate.
    ui.set_text(t, "A");
    let child = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(child, "B");
    ui.insert_before(t, child, 0);
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    // One run, 2 glyphs, right-aligned in 51px: line w = 11 -> x0 = 40.
    let i = words.iter().position(|&w| w == spec::draw_op::GLYPH_RUN).unwrap();
    assert_eq!(words[i + 1], 2 << 16); // slot 0, n = 2
    assert_eq!(words[i + 2], color);
    assert_eq!(decode_xy(words[i + 3]), (40, 1)); // y: (10 - 8) / 2 = 1
    assert_eq!(words[i + 4], 1); // gid 'A'
    assert_eq!(decode_xy(words[i + 5]), (46, 1));
    assert_eq!(words[i + 6], 2); // gid 'B'
}

#[test]
fn explicit_animate_lifecycle() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    // 10 frames linear 100 -> 200 (layout-dirtying: width relayouts).
    let aid = ui.animate(n, spec::prop::WIDTH, 200.0, 167, spec::Easing::Linear as u8, 0);
    assert!(aid > 0);
    for _ in 0..5 {
        ui.tick();
    }
    let mid = ui.resolved_style(n).unwrap().width;
    assert!(mid > 100.0 && mid < 200.0);
    assert_eq!(ui.layout_of(n).unwrap().2, crate::layout::roundf(mid)); // relayouted this frame
    // Cancel freezes the current value (as a dynamic override).
    ui.cancel_anim(aid);
    let frozen = ui.resolved_style(n).unwrap().width;
    assert_eq!(frozen, mid);
    for _ in 0..10 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().width, frozen);
    // Stale anim id: no-op.
    ui.cancel_anim(aid);
    // Run one to completion: final value persists as an override.
    let aid2 = ui.animate(n, spec::prop::WIDTH, 300.0, 100, spec::Easing::EaseOut as u8, 0);
    assert!(aid2 > 0);
    for _ in 0..20 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().width, 300.0);
    assert_eq!(ui.layout_of(n).unwrap().2, 300.0);
    // Non-animatable prop is rejected.
    assert_eq!(ui.animate(n, spec::prop::FLEX_DIR, 1.0, 100, 0, 0), -1);
}

#[test]
fn explicit_animate_retargets_same_prop_from_current_value() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 0.0);
    ui.insert_before(spec::ROOT_ID, n, 0);

    let first = ui.animate(n, spec::prop::WIDTH, 100.0, 600, spec::Easing::Linear as u8, 0);
    assert!(first > 0);
    for _ in 0..9 {
        ui.tick();
    }
    let mid = ui.resolved_style(n).unwrap().width;
    assert_eq!(mid, 25.0);

    let second = ui.animate(n, spec::prop::WIDTH, 200.0, 600, spec::Easing::Linear as u8, 0);
    assert!(second > 0);
    assert_eq!(ui.resolved_style(n).unwrap().width, mid);
    ui.cancel_anim(first); // stale id: the second animation killed the first.

    for _ in 0..18 {
        ui.tick();
    }
    let retargeted_mid = ui.resolved_style(n).unwrap().width;
    assert!(
        (retargeted_mid - 112.5).abs() < 0.001,
        "second animation must start from the interrupted value, got {retargeted_mid}",
    );
}

#[test]
fn destroy_subtree_frees_anims_and_slots() {
    let mut ui = Ui::new();
    let parent = ui.create_node(0);
    let child = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, parent, 0);
    ui.insert_before(parent, child, 0);
    ui.set_focus(child);
    let aid = ui.animate(child, spec::prop::OPACITY, 0.0, 1000, 0, 0);
    assert!(aid > 0);
    ui.destroy_node(parent);
    assert_eq!(ui.focused(), 0);
    assert!(ui.layout_of(parent).is_none());
    assert!(ui.layout_of(child).is_none());
    // The track died with the subtree: cancel is a no-op, ticks don't panic.
    ui.cancel_anim(aid);
    for _ in 0..3 {
        ui.tick();
        validate_drawlist(&ui.draw().words.clone());
    }
}

#[test]
fn opacity_multiplies_down_the_subtree() {
    let mut ui = Ui::new();
    let outer = ui.create_node(0);
    ui.set_prop(outer, spec::prop::WIDTH, 100.0);
    ui.set_prop(outer, spec::prop::HEIGHT, 100.0);
    ui.set_prop(outer, spec::prop::OPACITY, 0.5);
    ui.insert_before(spec::ROOT_ID, outer, 0);
    let inner = ui.create_node(0);
    ui.set_prop(inner, spec::prop::WIDTH, 50.0);
    ui.set_prop(inner, spec::prop::HEIGHT, 50.0);
    ui.set_prop(inner, spec::prop::OPACITY, 0.5);
    ui.set_prop(inner, spec::prop::BG_COLOR, abgr(100, 100, 100, 255) as f64);
    ui.insert_before(outer, inner, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::RECT).unwrap();
    let a = words[i + 3] >> 24;
    // 255 * 0.5 * 0.5 ≈ 64 (rounding via +0.5 in scale_alpha).
    assert_eq!(a, 64);
}

#[test]
fn zindex_orders_siblings_stably() {
    let mut ui = Ui::new();
    let mk = |ui: &mut Ui, z: f64, r: u8| {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 10.0);
        ui.set_prop(n, spec::prop::HEIGHT, 10.0);
        ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(n, spec::prop::INSET_T, 0.0);
        ui.set_prop(n, spec::prop::INSET_L, 0.0);
        ui.set_prop(n, spec::prop::Z_INDEX, z);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(r, 0, 0, 255) as f64);
        ui.insert_before(spec::ROOT_ID, n, 0);
    };
    mk(&mut ui, 1.0, 1); // insertion order 1, z 1
    mk(&mut ui, 0.0, 2); // insertion order 2, z 0
    mk(&mut ui, 0.0, 3); // insertion order 3, z 0 (stable after r=2)
    mk(&mut ui, -1.0, 4); // negative z paints first
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let mut reds = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => {
                reds.push((words[i + 3] & 0xff) as u8);
                i += 4;
            }
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            _ => i += 1,
        }
    }
    assert_eq!(reds, alloc::vec![4, 2, 3, 1]);
}

#[test]
fn image_tex_quad_clips_with_uv_reinterpolation() {
    let mut ui = Ui::new();
    let pixels = alloc::vec![0xffu8; 16 * 16 * 4];
    let tex = ui.upload_texture(&pixels, 16, 16, spec::psm::PSM_8888);
    assert_eq!(tex, 0);
    // Validation failures.
    assert_eq!(ui.upload_texture(&pixels, 17, 16, spec::psm::PSM_8888), -1);
    assert_eq!(ui.upload_texture(&pixels, 1024, 16, spec::psm::PSM_8888), -1);
    assert_eq!(ui.upload_texture(&pixels[..8], 16, 16, spec::psm::PSM_8888), -1);
    assert_eq!(ui.upload_texture(&pixels, 16, 16, 99), -1);
    let view = ui.texture(tex).unwrap();
    assert_eq!(
        (view.pixels.len(), view.w, view.h, view.psm),
        (1024, 16, 16, spec::psm::PSM_8888)
    );
    assert!(view.palette.is_none() && !view.linear);
    assert_eq!(view.pixels.as_ptr() as usize % 16, 0, "texture pixels must be 16-byte aligned");

    let img = ui.create_node(spec::NodeType::Image as u8);
    ui.set_prop(img, spec::prop::WIDTH, 100.0);
    ui.set_prop(img, spec::prop::HEIGHT, 100.0);
    ui.set_prop(img, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(img, spec::prop::INSET_T, 0.0);
    ui.set_prop(img, spec::prop::INSET_L, 0.0);
    ui.set_prop(img, spec::prop::TRANSLATE_X, 430.0); // half off right: u1 = 0.5
    ui.set_image(img, tex);
    ui.insert_before(spec::ROOT_ID, img, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
    assert_eq!(words[i + 1], tex as u32);
    assert_eq!(decode_xy(words[i + 2]), (430, 0));
    assert_eq!(decode_wh(words[i + 3]), (50, 100));
    assert_eq!(f32::from_bits(words[i + 4]), 0.0); // u0
    assert_eq!(f32::from_bits(words[i + 6]), 0.5); // u1
    assert_eq!(f32::from_bits(words[i + 7]), 1.0); // v1
}

#[test]
fn root_is_a_full_screen_flex_column() {
    let mut ui = Ui::new();
    ui.tick();
    assert_eq!(ui.layout_of(spec::ROOT_ID).unwrap(), (0.0, 0.0, 480.0, 272.0));
    let r = ui.resolved_style(spec::ROOT_ID).unwrap();
    assert_eq!(r.flex_dir, spec::FlexDir::Col as u8);
    // Root cannot be destroyed.
    ui.destroy_node(spec::ROOT_ID);
    assert!(ui.layout_of(spec::ROOT_ID).is_some());
}

#[test]
fn full_percent_sentinel_maps_to_100_percent() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, -1.0); // w-full
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 40.0));
}

#[test]
fn style_table_parse_rejects_garbage() {
    let mut ui = Ui::new();
    assert!(!ui.load_styles(&[1, 2, 3]));
    assert!(!ui.load_styles(&[0u8; 32]));
    let good = encode_styles(&[StyleSpec::new()]);
    assert!(ui.load_styles(&good));
    assert!(!ui.load_styles(&good[..good.len() - 1 + 0][..6])); // truncated header
    // A record with a style id past the table resolves as unstyled.
    // (Compare via raw prop bits — Resolved holds NANs, so PartialEq lies.)
    let n = ui.create_node(0);
    ui.set_style(n, 99);
    let r = ui.resolved_style(n).unwrap();
    let d = style::Resolved::default();
    for prop in 0u16..=255 {
        assert_eq!(r.get_bits(prop as u8), d.get_bits(prop as u8), "prop {prop}");
    }
}

#[test]
fn scale_only_transform_stays_axis_aligned() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.set_prop(n, spec::prop::HEIGHT, 50.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(1, 2, 3, 255) as f64);
    ui.set_prop(n, spec::prop::SCALE, 0.5);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::TRI as usize], 0);
    let i = words.iter().position(|&w| w == spec::draw_op::RECT).unwrap();
    // Scaled 0.5 about center: 100x50 -> 50x25 at (25, 12.5->13 rounded).
    assert_eq!(decode_xy(words[i + 1]), (25, 13));
    assert_eq!(decode_wh(words[i + 2]), (50, 25));
}

#[test]
fn scale_x_transform_is_paint_only_and_can_anchor_left() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(1, 2, 3, 255) as f64);
    ui.set_prop(n, spec::prop::SCALE_X, 0.5);
    // Scaling is about center. Offset left by half the lost width to keep the
    // progress fill anchored at x=0 while the right edge moves.
    ui.set_prop(n, spec::prop::TRANSLATE_X, -25.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 100.0);

    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::TRI as usize], 0);
    let i = words.iter().position(|&w| w == spec::draw_op::RECT).unwrap();
    assert_eq!(decode_xy(words[i + 1]), (0, 0));
    assert_eq!(decode_wh(words[i + 2]), (50, 20));
}

#[test]
fn root_cannot_be_reparented_under_a_detached_node() {
    let mut ui = Ui::new();
    // A DETACHED parent defeats the ancestor-walk cycle guard; the explicit
    // root-as-child reject must keep slot 1 alive forever.
    let x = ui.create_node(0);
    ui.insert_before(x, spec::ROOT_ID, 0);
    ui.destroy_node(x);
    ui.tick();
    assert!(ui.layout_of(spec::ROOT_ID).is_some(), "root died");
    // The core still works: a new child under the root lays out.
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 40.0));
    // Also via an ATTACHED parent (plain cycle guard case).
    ui.insert_before(n, spec::ROOT_ID, 0);
    ui.tick();
    assert_eq!(ui.layout_of(spec::ROOT_ID).unwrap(), (0.0, 0.0, 480.0, 272.0));
}

#[test]
fn any_negative_size_is_the_size_full_sentinel() {
    // spec.ts: "Any negative width/height value is treated as this sentinel".
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, -2.0);
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 40.0));
    ui.set_prop(n, spec::prop::HEIGHT, -0.5);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 272.0));
}

#[test]
fn size_full_sentinel_is_not_animatable() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 200.0);
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    // animate() TO the sentinel: no-op, returns -1, width stays put.
    assert_eq!(ui.animate(n, spec::prop::WIDTH, -1.0, 500, spec::Easing::Linear as u8, 0), -1);
    for _ in 0..5 {
        ui.tick();
    }
    assert_eq!(ui.layout_of(n).unwrap().2, 200.0);
    // animate() FROM the sentinel: also a no-op.
    ui.set_prop(n, spec::prop::WIDTH, -1.0);
    assert_eq!(ui.animate(n, spec::prop::WIDTH, 100.0, 500, spec::Easing::Linear as u8, 0), -1);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 480.0);
    // Style transitions between a pixel width and w-full spawn NO width
    // track: the variant swap snaps.
    let mut s0 = StyleSpec::new();
    s0.base = alloc::vec![(spec::prop::WIDTH, 160f32.to_bits())];
    let mut s1 = StyleSpec::new();
    s1.base = alloc::vec![(spec::prop::WIDTH, (-1f32).to_bits())];
    s1.transition = Some((0xffff_ffff, 300, 0, spec::Easing::Linear as u8));
    assert!(ui.load_styles(&encode_styles(&[s0, s1])));
    let m = ui.create_node(0);
    ui.set_prop(m, spec::prop::HEIGHT, 10.0);
    ui.insert_before(spec::ROOT_ID, m, 0);
    ui.set_style(m, 0);
    ui.tick();
    assert_eq!(ui.layout_of(m).unwrap().2, 160.0);
    ui.set_style(m, 1);
    assert_eq!(ui.resolved_style(m).unwrap().width, -1.0, "snap, not a tween");
    ui.tick();
    assert_eq!(ui.layout_of(m).unwrap().2, 480.0);
}

#[test]
fn huge_durations_do_not_overflow() {
    assert!(crate::anim::ms_to_frames(u32::MAX) >= 1); // would panic pre-fix
    assert_eq!(crate::anim::ms_to_frames(100_000_000), 6_000_000);
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    let aid = ui.animate(n, spec::prop::OPACITY, 0.0, u32::MAX, 0, u32::MAX);
    assert!(aid > 0);
    for _ in 0..3 {
        ui.tick();
    }
}

#[test]
fn auto_endpoints_snap_instead_of_tweening_nan() {
    let mut ui = Ui::new();
    // Transition from an AUTO (NaN) width to a pixel width: browsers snap;
    // pre-fix the tween held NaN for the whole duration.
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::WIDTH, 200f32.to_bits())];
    s.transition = Some((0xffff_ffff, 300, 0, spec::Easing::Linear as u8));
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 480.0); // stretched auto width
    ui.set_style(n, 0);
    let w = ui.resolved_style(n).unwrap().width;
    assert_eq!(w, 200.0, "snap to target, no NaN mid-flight (got {w})");
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 200.0);
    // Explicit animate() from auto: no track, target written as an override.
    let m = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, m, 0);
    assert_eq!(ui.animate(m, spec::prop::HEIGHT, 50.0, 300, spec::Easing::Linear as u8, 0), -1);
    ui.tick();
    assert_eq!(ui.layout_of(m).unwrap().3, 50.0);
}

#[test]
fn insert_past_max_tree_depth_is_a_noop() {
    // Tree-level: the over-limit insert returns false.
    let mut t = crate::tree::Tree::new();
    let mut parent = spec::ROOT_ID;
    for depth in 1..=spec::MAX_TREE_DEPTH {
        let n = t.alloc(0);
        assert!(t.insert_before(parent, n, 0), "insert at depth {depth} must succeed");
        parent = n;
    }
    let over = t.alloc(0);
    assert!(!t.insert_before(parent, over, 0), "insert past MAX_TREE_DEPTH must no-op");
    // Ui-level smoke: the capped chain still ticks/draws safely.
    let mut ui = Ui::new();
    let mut parent = spec::ROOT_ID;
    for _ in 1..=spec::MAX_TREE_DEPTH {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(8, 8, 8, 255) as f64);
        ui.insert_before(parent, n, 0);
        parent = n;
    }
    let over = ui.create_node(0);
    ui.insert_before(parent, over, 0); // silent no-op
    ui.tick();
    validate_drawlist(&ui.draw().words.clone());
    assert!(ui.layout_of(parent).is_some());
}

#[test]
fn set_image_negative_clears_the_binding() {
    let mut ui = Ui::new();
    let pixels = alloc::vec![0xffu8; 16 * 16 * 4];
    let tex = ui.upload_texture(&pixels, 16, 16, spec::psm::PSM_8888);
    assert_eq!(tex, 0, "texture handles are 0-based");
    let img = ui.create_node(spec::NodeType::Image as u8);
    ui.set_prop(img, spec::prop::WIDTH, 32.0);
    ui.set_prop(img, spec::prop::HEIGHT, 32.0);
    ui.insert_before(spec::ROOT_ID, img, 0);
    ui.set_image(img, tex);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 1);
    // Unknown positive handles are still ignored (binding kept)...
    ui.set_image(img, 99);
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 1);
    // ...but any negative handle CLEARS (renderer.ts sends -1 for src="").
    ui.set_image(img, -1);
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 0);
}

#[test]
fn cmap_xoff_shifts_glyph_cells_left() {
    // A synthetic atlas whose 'A' carries xoff=2 (negative-LSB bake shift):
    // the emitted cell must sit at pen - 2 while advances are unaffected.
    let mut blob = encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    );
    // Patch cmap byte +7 (xoff) of the 'A' entry (entry index 1: sorted by
    // codepoint 'A' < 'B' < 0xfffd).
    let a_entry = spec::font_atlas::HEADER_SIZE + spec::font_atlas::CMAP_ENTRY_SIZE;
    blob[a_entry + 7] = 2;
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&blob));
    assert_eq!(ui.measure_text("AB", 0), 11.0, "xoff must not change advances");
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_L, 10.0);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::TEXT_COLOR, abgr(255, 255, 255, 255) as f64);
    ui.set_text(t, "AB");
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::GLYPH_RUN).unwrap();
    assert_eq!(decode_xy(words[i + 3]).0, 10 - 2, "'A' cell shifted left by its xoff");
    assert_eq!(decode_xy(words[i + 5]).0, 10 + 6, "'B' (xoff 0) at the plain pen position");
}

/// Two runs of a whole interaction script (styles, focus transitions,
/// springs, text edits) must be byte-identical — the golden-test bedrock.
#[test]
fn end_to_end_determinism_script() {
    fn run() -> Vec<u32> {
        let mut ui = Ui::new();
        let mut s0 = StyleSpec::new();
        s0.base = alloc::vec![
            (spec::prop::WIDTH, 80f32.to_bits()),
            (spec::prop::HEIGHT, 30f32.to_bits()),
            (spec::prop::BG_COLOR, abgr(30, 41, 59, 255)),
        ];
        s0.focus = alloc::vec![(spec::prop::BG_COLOR, abgr(129, 140, 248, 255))];
        s0.transition = Some((0xffff_ffff, 150, 0, spec::Easing::SpringBouncy as u8));
        ui.load_styles(&encode_styles(&[s0]));
        ui.load_font_atlas(&encode_atlas(
            0,
            8,
            8,
            7,
            10,
            3,
            &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
        ));
        let card = ui.create_node(0);
        ui.set_style(card, 0);
        ui.insert_before(spec::ROOT_ID, card, 0);
        let label = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(label, "AB");
        ui.insert_before(card, label, 0);
        let mut all = Vec::new();
        for f in 0..40u32 {
            if f == 5 {
                ui.set_focus(card);
            }
            if f == 20 {
                ui.set_focus(0);
            }
            if f == 25 {
                ui.replace_text(label, "BA\nA");
            }
            ui.tick();
            all.extend_from_slice(&ui.draw().words);
        }
        all
    }
    let a = run();
    assert!(!a.is_empty());
    assert_eq!(a, run());
}

// ---- baked keyframe timelines ------------------------------------------------

/// translateX 0 -> 60 px over 60 frames (linear), 30-frame delay, fill both.
fn slide_anim() -> AnimSpec {
    AnimSpec {
        delay_frames: 30,
        period_frames: 60,
        iterations: 1,
        fill: spec::style_table::ANIM_FILL_BACKWARDS | spec::style_table::ANIM_FILL_FORWARDS,
        tracks: alloc::vec![(
            spec::prop::TRANSLATE_X,
            alloc::vec![SegSpec(0, 60, 0f32.to_bits(), 60f32.to_bits(), spec::Easing::Linear as u8, None)],
        )],
    }
}

#[test]
fn baked_timeline_plays_delays_and_fills() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::WIDTH, 10f32.to_bits())];
    s.animation = Some((0, alloc::vec![0]));
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[slide_anim()])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    // t = 0 (during the delay): backwards fill pins the first-frame value.
    ui.tick();
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 0.0);
    // t = 60 = delay + 30: halfway through the 60-frame linear segment.
    for _ in 0..60 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 30.0);
    // Way past the end: forwards fill holds the final value.
    for _ in 0..120 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 60.0);
}

#[test]
fn timeline_loop_restarts_the_choreography() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.animation = Some((120, alloc::vec![0])); // loop every 120 frames
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[slide_anim()])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    for _ in 0..100 {
        ui.tick(); // t = 99: finished (delay 30 + period 60), forwards-filled
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 60.0);
    for _ in 0..22 {
        ui.tick(); // t = 121 -> wrapped clock t = 1: back in the delay phase
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 0.0);
    for _ in 0..59 {
        ui.tick(); // last eval at wrapped t = 60: halfway through the segment again
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 30.0);
}

#[test]
fn timeline_list_precedence_matches_css() {
    // A: opacity 0 -> 1 over frames 0..30 (fill both).
    // B: opacity 1 -> 0 over 30 frames, delayed 60, fill forwards only.
    let fade_in = AnimSpec {
        delay_frames: 0,
        period_frames: 30,
        iterations: 1,
        fill: spec::style_table::ANIM_FILL_BACKWARDS | spec::style_table::ANIM_FILL_FORWARDS,
        tracks: alloc::vec![(
            spec::prop::OPACITY,
            alloc::vec![SegSpec(0, 30, 0f32.to_bits(), 1f32.to_bits(), spec::Easing::Linear as u8, None)],
        )],
    };
    let fade_out = AnimSpec {
        delay_frames: 60,
        period_frames: 30,
        iterations: 1,
        fill: spec::style_table::ANIM_FILL_FORWARDS,
        tracks: alloc::vec![(
            spec::prop::OPACITY,
            alloc::vec![SegSpec(0, 30, 1f32.to_bits(), 0f32.to_bits(), spec::Easing::Linear as u8, None)],
        )],
    };
    let mut s = StyleSpec::new();
    s.animation = Some((0, alloc::vec![0, 1]));
    let mut ui = Ui::new();
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[fade_in, fade_out])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    // t = 15: A halfway (0.5); B inactive (delay, no backwards fill) -> A wins.
    for _ in 0..16 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 0.5);
    // t = 45: A finished (fill 1.0); B still inactive -> A's fill shows.
    for _ in 0..30 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 1.0);
    // t = 75: B halfway (0.5) and later in the list -> B wins over A's fill.
    for _ in 0..30 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 0.5);
    // t = 120: both filled -> the later entry (B, 0.0) wins.
    for _ in 0..45 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 0.0);
}

#[test]
fn set_style_restarts_timelines() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.animation = Some((0, alloc::vec![0]));
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[slide_anim()])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    for _ in 0..70 {
        ui.tick();
    }
    assert!(ui.resolved_style(n).unwrap().translate_x > 0.0);
    // Re-applying the style restarts the choreography from frame 0.
    ui.set_style(n, 0);
    ui.tick();
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 0.0);
}

#[test]
fn cubic_bezier_is_sane() {
    use crate::anim::cubic_bezier;
    assert_eq!(cubic_bezier(0.42, 0.0, 0.58, 1.0, 0.0), 0.0);
    assert_eq!(cubic_bezier(0.42, 0.0, 0.58, 1.0, 1.0), 1.0);
    // ease-in-out is symmetric: y(0.5) = 0.5.
    let mid = cubic_bezier(0.42, 0.0, 0.58, 1.0, 0.5);
    assert!((mid - 0.5).abs() < 1e-3, "mid = {mid}");
    // Monotonic over a coarse sweep.
    let mut prev = 0.0f32;
    for i in 0..=20 {
        let y = cubic_bezier(0.25, 0.1, 0.25, 1.0, i as f32 / 20.0);
        assert!(y >= prev - 1e-4, "not monotonic at {i}: {y} < {prev}");
        prev = y;
    }
}

#[test]
fn negative_insets_are_offsets_not_size_full() {
    // inset: -10 on an auto-sized absolute child must OUTSET the parent box
    // by 10px per side (CSS stretch), not resolve to the SIZE_FULL sentinel.
    let mut ui = Ui::new();
    let mut wrapper = StyleSpec::new();
    wrapper.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::INSET_L, 130f32.to_bits()),
        (spec::prop::INSET_T, 50f32.to_bits()),
        (spec::prop::WIDTH, 60f32.to_bits()),
        (spec::prop::HEIGHT, 60f32.to_bits()),
    ];
    let mut pulse = StyleSpec::new();
    pulse.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::INSET_T, (-10f32).to_bits()),
        (spec::prop::INSET_R, (-10f32).to_bits()),
        (spec::prop::INSET_B, (-10f32).to_bits()),
        (spec::prop::INSET_L, (-10f32).to_bits()),
    ];
    let mut mark = StyleSpec::new();
    mark.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::INSET_R, 0f32.to_bits()),
        (spec::prop::INSET_T, 0f32.to_bits()),
        (spec::prop::WIDTH, 20f32.to_bits()),
        (spec::prop::HEIGHT, 10f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[wrapper, pulse, mark])));
    let w = ui.create_node(0);
    let p = ui.create_node(0);
    let m = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, w, 0);
    ui.insert_before(w, p, 0);
    ui.insert_before(p, m, 0);
    ui.set_style(w, 0);
    ui.set_style(p, 1);
    ui.set_style(m, 2);
    ui.tick();
    assert_eq!(ui.layout_of(w).unwrap(), (130.0, 50.0, 60.0, 60.0));
    // stretched: 60 + 10px outset per side, positioned at (-10, -10)
    assert_eq!(ui.layout_of(p).unwrap(), (-10.0, -10.0, 80.0, 80.0));
    // right-anchored mark: x = 80 - 20
    assert_eq!(ui.layout_of(m).unwrap(), (60.0, 0.0, 20.0, 10.0));
}

// ---- 3D + arc rendering smoke tests --------------------------------------------

#[test]
fn perspective_subtree_emits_depth_sorted_tris() {
    let mut ui = Ui::new();
    let mut root = StyleSpec::new();
    root.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 100f32.to_bits()),
        (spec::prop::HEIGHT, 100f32.to_bits()),
        (spec::prop::PERSPECTIVE, 200f32.to_bits()),
    ];
    let mut face = StyleSpec::new();
    face.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 50f32.to_bits()),
        (spec::prop::HEIGHT, 50f32.to_bits()),
        (spec::prop::INSET_L, 25f32.to_bits()),
        (spec::prop::INSET_T, 25f32.to_bits()),
        (spec::prop::BG_COLOR, 0xff88_8888u32),
        (spec::prop::ROTATE_Y, 45f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[root, face])));
    let r = ui.create_node(0);
    let f = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, r, 0);
    ui.insert_before(r, f, 0);
    ui.set_style(r, 0);
    ui.set_style(f, 1);
    ui.tick();
    let words = ui.draw().words.clone();
    // A rotateY'd face must land on the TRI path (perspective projection).
    let mut i = 0;
    let mut tris = 0;
    while i < words.len() {
        let op = words[i];
        i += match op {
            x if x == spec::draw_op::RECT => 4,
            x if x == spec::draw_op::GRAD_RECT => 6,
            x if x == spec::draw_op::TRI => {
                tris += 1;
                7
            }
            x if x == spec::draw_op::GLYPH_RUN => {
                let n = (words[i + 1] >> 16) as usize;
                3 + 2 * n
            }
            x if x == spec::draw_op::TEX_QUAD => 9,
            x if x == spec::draw_op::SCISSOR => 3,
            _ => 1, // SCISSOR_POP
        };
    }
    assert!(tris >= 2, "expected projected face triangles, got {tris}");
}

#[test]
fn arc_primitive_emits_coverage_rects() {
    let mut ui = Ui::new();
    let mut arc = StyleSpec::new();
    arc.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 40f32.to_bits()),
        (spec::prop::HEIGHT, 40f32.to_bits()),
        (spec::prop::INSET_L, 10f32.to_bits()),
        (spec::prop::INSET_T, 10f32.to_bits()),
        (spec::prop::BG_COLOR, 0xffff_ffffu32),
        (spec::prop::ARC_START, 45f32.to_bits()),
        (spec::prop::ARC_SWEEP, 180f32.to_bits()),
        (spec::prop::ARC_WIDTH, 5f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[arc])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let mut rects = 0;
    let mut i = 0;
    while i < words.len() {
        let op = words[i];
        i += match op {
            x if x == spec::draw_op::RECT => {
                rects += 1;
                4
            }
            x if x == spec::draw_op::GRAD_RECT => 6,
            x if x == spec::draw_op::TRI => 7,
            x if x == spec::draw_op::GLYPH_RUN => {
                let c = (words[i + 1] >> 16) as usize;
                3 + 2 * c
            }
            x if x == spec::draw_op::TEX_QUAD => 9,
            x if x == spec::draw_op::SCISSOR => 3,
            _ => 1,
        };
    }
    // The half-ring rasterizes into many small coverage runs (not one box).
    assert!(rects > 20, "expected arc coverage runs, got {rects}");
}

// ---- DevTools ops (spec ops 18..22, DEVTOOLS.md) ----------------------------

#[test]
fn debug_pause_freezes_and_step_advances_one_frame() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.base = alloc::vec![
        (spec::prop::WIDTH, 40f32.to_bits()),
        (spec::prop::HEIGHT, 40f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    ui.tick();
    // 600 ms linear width anim: ~4.4 px per 1/60 frame — visible per tick.
    assert!(ui.animate(n, spec::prop::WIDTH, 200.0, 600, spec::Easing::Linear as u8, 0) >= 0);
    ui.tick();
    ui.draw();
    let w1 = ui.layout_of(n).unwrap().2;
    assert!(w1 > 40.0, "anim should have started, got {w1}");

    ui.debug_pause(true);
    assert!(ui.debug_paused());
    for _ in 0..5 {
        ui.tick();
    }
    ui.draw();
    assert_eq!(ui.layout_of(n).unwrap().2, w1, "paused world must hold");

    ui.debug_step();
    ui.tick(); // armed: advances exactly one frame
    ui.tick(); // not armed: no-op again
    ui.draw();
    let w2 = ui.layout_of(n).unwrap().2;
    assert!(w2 > w1, "step must advance one frame");

    ui.debug_pause(false);
    ui.tick();
    ui.draw();
    assert!(ui.layout_of(n).unwrap().2 > w2, "resume must run again");
}

#[test]
fn debug_inspect_overlays_and_reports_world_rect() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 40f32.to_bits()),
        (spec::prop::HEIGHT, 40f32.to_bits()),
        (spec::prop::INSET_L, 10f32.to_bits()),
        (spec::prop::INSET_T, 10f32.to_bits()),
        (spec::prop::BG_COLOR, 0xff20_4060u32),
    ];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    ui.tick();
    let baseline = ui.draw().words.len();
    assert_eq!(ui.debug_rect_xy(), -1, "no inspect target yet");

    ui.debug_inspect(n);
    assert_eq!(ui.debug_rect_xy(), -1, "rect only captured by draw()");
    let overlaid = ui.draw().words.len();
    // Overlay = translucent fill + 4 edge rects = 5 RECT ops = 20 words.
    assert_eq!(overlaid, baseline + 20, "highlight overlay must be appended");
    assert_eq!(ui.debug_rect_xy(), 10 | (10 << 16));
    assert_eq!(ui.debug_rect_wh(), 40 | (40 << 16));

    ui.debug_inspect(0);
    assert_eq!(ui.draw().words.len(), baseline, "overlay must clear");
    assert_eq!(ui.debug_rect_xy(), -1);
    assert_eq!(ui.debug_rect_wh(), -1);
}

#[test]
fn debug_inspect_glides_between_targets() {
    let mut ui = Ui::new();
    let mk = |x: f32| {
        let mut s = StyleSpec::new();
        s.base = alloc::vec![
            (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
            (spec::prop::WIDTH, 40f32.to_bits()),
            (spec::prop::HEIGHT, 40f32.to_bits()),
            (spec::prop::INSET_L, x.to_bits()),
            (spec::prop::INSET_T, 10f32.to_bits()),
            (spec::prop::BG_COLOR, 0xff20_4060u32),
        ];
        s
    };
    assert!(ui.load_styles(&encode_styles(&[mk(10.0), mk(200.0)])));
    let a = ui.create_node(0);
    let b = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, a, 0);
    ui.insert_before(spec::ROOT_ID, b, 0);
    ui.set_style(a, 0);
    ui.set_style(b, 1);
    ui.tick();

    // Decode the fill rect (first overlay op) X from the appended words.
    let overlay_x = |ui: &mut Ui, baseline: usize| -> i32 {
        let words = &ui.draw().words;
        assert!(words.len() > baseline, "overlay must be present");
        let xy = words[baseline + 1]; // [RECT, xy, wh, color]
        ((xy & 0xffff) as u16) as i16 as i32
    };
    let baseline = ui.draw().words.len();

    ui.debug_inspect(a);
    assert_eq!(overlay_x(&mut ui, baseline), 10, "first appearance is instant");

    ui.debug_inspect(b);
    let x1 = overlay_x(&mut ui, baseline);
    assert!(x1 > 10 && x1 < 200, "glide starts between the boxes, got {x1}");
    let x2 = overlay_x(&mut ui, baseline);
    assert!(x2 > x1, "glide advances every draw, got {x1} -> {x2}");
    for _ in 0..30 {
        ui.draw();
    }
    assert_eq!(overlay_x(&mut ui, baseline), 200, "glide converges exactly");
    assert_eq!(ui.debug_rect_xy(), 200 | (10 << 16), "readback is the target, not the animation");

    ui.debug_inspect(0);
    assert_eq!(ui.draw().words.len(), baseline, "clear hides the overlay");
}

/// set_text rides the incremental style path — and skips relayout entirely
/// inside a FIXED cell (definite px width AND height), where the measure
/// result cannot move layout. Empty <-> non-empty stays structural (the
/// taffy leaf has to (dis)appear).
#[test]
fn set_text_relayout_scope() {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    )));
    let auto_t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(auto_t, "A");
    ui.insert_before(spec::ROOT_ID, auto_t, 0);
    let fixed_t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(fixed_t, spec::prop::WIDTH, 40.0);
    ui.set_prop(fixed_t, spec::prop::HEIGHT, 12.0);
    ui.set_text(fixed_t, "A");
    ui.insert_before(spec::ROOT_ID, fixed_t, 1);
    ui.tick();
    assert!(!ui.layout.needs(), "clean after tick");

    // Auto-sized: a size-changing swap must schedule (incremental) relayout.
    ui.set_text(auto_t, "AB");
    assert!(ui.layout.needs(), "auto cell swap relayouts");
    assert!(!ui.layout.dirty, "…but incrementally, not a full rebuild");
    ui.tick();

    // Fixed cell: the swap must NOT schedule any layout work…
    ui.set_text(fixed_t, "AB");
    assert!(!ui.layout.needs(), "fixed cell swap skips relayout");
    ui.tick();
    // …and paint still shows the new text (reads the tree, not the ctx).
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let runs = words.iter().filter(|&&w| w == spec::draw_op::GLYPH_RUN).count();
    assert_eq!(runs, 2, "both texts painted");

    // Empty <-> non-empty flips are structural (full rebuild).
    ui.set_text(fixed_t, "");
    assert!(ui.layout.dirty, "non-empty -> empty is structural");
    ui.tick();
    ui.set_text(fixed_t, "A");
    assert!(ui.layout.dirty, "empty -> non-empty is structural");
    ui.tick();
}

// ---- streamed textures: PackBits codec, CLUT8, IMG/TILESET entries, slots --

/// Test-local mirror of spec.ts packbitsEncode (runs >= 2 become run records
/// capped at 129; literal stretches break before the next run of >= 3).
fn packbits_encode(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < src.len() {
        let mut run = 1usize;
        while run < 129 && i + run < src.len() && src[i + run] == src[i] {
            run += 1;
        }
        if run >= 2 {
            out.push((126 + run) as u8);
            out.push(src[i]);
            i += run;
            continue;
        }
        let mut end = i + 1;
        while end < src.len() && end - i < 128 {
            let mut r = 1usize;
            while r < 3 && end + r < src.len() && src[end + r] == src[end] {
                r += 1;
            }
            if r >= 3 {
                break;
            }
            end += 1;
        }
        out.push((end - i - 1) as u8);
        out.extend_from_slice(&src[i..end]);
        i = end;
    }
    out
}

#[test]
fn packbits_decodes_hand_built_spec_vectors() {
    use crate::codec::packbits_decode;
    // Each vector is the exact spec.ts packbitsEncode output for its plain text.
    let mut one = [0u8; 1];
    assert!(packbits_decode(&[0, 5], &mut one)); // single literal
    assert_eq!(one, [5]);
    let mut run3 = [0u8; 3];
    assert!(packbits_decode(&[129, 7], &mut run3)); // run of 3
    assert_eq!(run3, [7, 7, 7]);
    let mut lits = [0u8; 3];
    assert!(packbits_decode(&[2, 1, 2, 3], &mut lits)); // 3-literal stretch
    assert_eq!(lits, [1, 2, 3]);
    // 2-runs stay literal (spec.ts: "2-runs are cheaper literal").
    let mut two_run = [0u8; 4];
    assert!(packbits_decode(&[3, 1, 2, 2, 3], &mut two_run));
    assert_eq!(two_run, [1, 2, 2, 3]);
    // Run capped at 129, then the leftover byte as a literal.
    let mut long = [0u8; 130];
    assert!(packbits_decode(&[255, 9, 0, 9], &mut long));
    assert!(long.iter().all(|&b| b == 9));
    // Mixed run + literal tail.
    let mut mixed = [0u8; 6];
    assert!(packbits_decode(&[130, 1, 1, 2, 3], &mut mixed));
    assert_eq!(mixed, [1, 1, 1, 1, 2, 3]);
    // Empty stream <-> empty output.
    assert!(packbits_decode(&[], &mut []));
    assert!(!packbits_decode(&[], &mut one));
}

#[test]
fn packbits_round_trips_against_the_encoder_mirror() {
    use crate::codec::packbits_decode;
    // Deterministic LCG pixel-ish data: long runs + noise, both paths hit.
    let mut src = Vec::new();
    let mut state = 0x1234_5678u32;
    while src.len() < 4096 {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let b = (state >> 24) as u8;
        let n = if state & 7 == 0 { (state >> 16 & 0xff) as usize + 1 } else { 1 };
        for _ in 0..n {
            src.push(b);
        }
    }
    src.truncate(4096);
    // Sanity-check the mirror against one spec.ts hand vector.
    assert_eq!(packbits_encode(&[1, 1, 1, 1, 2, 3]), alloc::vec![130, 1, 1, 2, 3]);
    let enc = packbits_encode(&src);
    assert!(enc.len() < src.len(), "the vector must actually compress");
    let mut dec = alloc::vec![0u8; src.len()];
    assert!(packbits_decode(&enc, &mut dec));
    assert_eq!(dec, src);
}

#[test]
fn packbits_rejects_malformed_streams_without_panicking() {
    use crate::codec::packbits_decode;
    let mut out = [0u8; 4];
    assert!(!packbits_decode(&[3, 1, 2], &mut out), "truncated literal payload");
    assert!(!packbits_decode(&[130], &mut out), "run without a value byte");
    assert!(!packbits_decode(&[255, 1], &mut out), "run overruns dst");
    assert!(!packbits_decode(&[5, 1, 2, 3, 4, 5, 6], &mut out), "literal overruns dst");
    assert!(!packbits_decode(&[128, 1], &mut out), "src exhausted before dst full");
    let mut two = [0u8; 2];
    assert!(!packbits_decode(&[128, 5, 0, 1], &mut two), "trailing bytes after exact fit");
    assert!(packbits_decode(&[128, 5], &mut two));
    assert_eq!(two, [5, 5]);
}

#[test]
fn t8_upload_carries_an_aligned_palette_and_raw_indices() {
    let mut ui = Ui::new();
    let mut data = Vec::new();
    let mut palette = [0u8; 1024];
    for i in 0..256 {
        palette[i * 4] = i as u8; // r = index
        palette[i * 4 + 3] = 255;
    }
    data.extend_from_slice(&palette);
    let indices: Vec<u8> = (0..64u32).map(|i| (i * 3 % 256) as u8).collect(); // 8x8
    data.extend_from_slice(&indices);
    let tex = ui.upload_texture(&data, 8, 8, spec::psm::PSM_T8);
    assert_eq!(tex, 0, "first slot at gen 0 is handle 0");
    let view = ui.texture(tex).unwrap();
    assert_eq!((view.w, view.h, view.psm, view.linear), (8, 8, spec::psm::PSM_T8, false));
    assert_eq!(view.pixels, &indices[..]);
    assert_eq!(view.pixels.as_ptr() as usize % 16, 0, "indices must be 16-byte aligned");
    let pal = view.palette.expect("T8 textures carry a palette");
    assert_eq!(pal.len(), 1024);
    assert_eq!(pal.as_ptr() as usize % 16, 0, "palette must be 16-byte aligned");
    assert_eq!((pal[4], pal[7]), (1, 255));
    // Undersized: palette alone, or palette + short index stream.
    assert_eq!(ui.upload_texture(&data[..1023], 8, 8, spec::psm::PSM_T8), -1);
    assert_eq!(ui.upload_texture(&data[..1024 + 63], 8, 8, spec::psm::PSM_T8), -1);
}

#[test]
fn upload_texture_flags_decodes_rle_and_marks_linear() {
    let mut ui = Ui::new();
    // T8: raw palette + RLE index stream (16 x byte 7 -> [140, 7]).
    let indices = [7u8; 16];
    let mut data = alloc::vec![0u8; 1024];
    data.extend_from_slice(&packbits_encode(&indices));
    let flags = spec::img::FLAG_RLE | spec::img::FLAG_LINEAR;
    let tex = ui.upload_texture_flags(&data, 4, 4, spec::psm::PSM_T8, flags);
    assert!(tex >= 0);
    let view = ui.texture(tex).unwrap();
    assert!(view.linear);
    assert_eq!(view.pixels, &indices[..]);
    // Truncated RLE stream -> -1 (must decode to EXACTLY w*h bytes).
    assert_eq!(
        ui.upload_texture_flags(&data[..1025], 4, 4, spec::psm::PSM_T8, spec::img::FLAG_RLE),
        -1
    );
    // Non-T8 RLE: the whole payload is the compressed pixel stream.
    let px8888 = [0xabu8; 2 * 2 * 4];
    let enc = packbits_encode(&px8888);
    let tex2 = ui.upload_texture_flags(&enc, 2, 2, spec::psm::PSM_8888, spec::img::FLAG_RLE);
    assert!(tex2 >= 0);
    let view2 = ui.texture(tex2).unwrap();
    assert_eq!(view2.pixels, &px8888[..]);
    assert!(view2.palette.is_none() && !view2.linear);
}

#[test]
fn img_entry_uploads_v1_and_v2_blobs_and_rejects_malformed() {
    let mut ui = Ui::new();
    // v2 T8 entry: header (w, h, psm, flags, reserved) + palette + RLE stream.
    let mut blob = Vec::new();
    blob.extend_from_slice(&4u16.to_le_bytes());
    blob.extend_from_slice(&4u16.to_le_bytes());
    blob.push(spec::psm::PSM_T8 as u8);
    blob.push(spec::img::FLAG_RLE);
    blob.extend_from_slice(&[0, 0]); // reserved
    blob.extend_from_slice(&[0u8; 1024]); // palette (never compressed)
    blob.extend_from_slice(&[142, 3]); // run of 16 x index 3
    let tex = ui.upload_img_entry(&blob);
    assert!(tex >= 0);
    let view = ui.texture(tex).unwrap();
    assert_eq!((view.w, view.h, view.psm), (4, 4, spec::psm::PSM_T8));
    assert_eq!(view.pixels, &[3u8; 16][..]);
    assert!(!view.linear);
    // v1 8888 entry (flags byte was reserved/0) still decodes identically.
    let mut v1 = Vec::new();
    v1.extend_from_slice(&2u16.to_le_bytes());
    v1.extend_from_slice(&2u16.to_le_bytes());
    v1.push(spec::psm::PSM_8888 as u8);
    v1.push(0);
    v1.extend_from_slice(&[0, 0]);
    v1.extend_from_slice(&[0xcdu8; 16]);
    let tex1 = ui.upload_img_entry(&v1);
    assert!(tex1 >= 0);
    assert_eq!(ui.texture(tex1).unwrap().pixels, &[0xcdu8; 16][..]);
    // Malformed: short header, truncated payload, bogus psm.
    assert_eq!(ui.upload_img_entry(&v1[..7]), -1);
    assert_eq!(ui.upload_img_entry(&v1[..20]), -1);
    let mut bad = v1.clone();
    bad[4] = 99;
    assert_eq!(ui.upload_img_entry(&bad), -1);
}

/// Build a tiny 2x2-tile TILESET blob (4x4 CLUT8 tiles, RLE + linear):
/// tile 0 = stream of index 5, tile 1 = ABSENT, tile 2 = SOLID(index 9),
/// tile 3 = stream of index 6.
fn tiny_tileset() -> Vec<u8> {
    use spec::tileset as ts;
    let mut blob = Vec::new();
    blob.extend_from_slice(&ts::MAGIC.to_le_bytes());
    blob.extend_from_slice(&ts::VERSION.to_le_bytes());
    blob.extend_from_slice(&(ts::FLAG_RLE | ts::FLAG_LINEAR).to_le_bytes());
    blob.extend_from_slice(&4u16.to_le_bytes()); // tileW
    blob.extend_from_slice(&4u16.to_le_bytes()); // tileH
    blob.extend_from_slice(&2u16.to_le_bytes()); // cols
    blob.extend_from_slice(&2u16.to_le_bytes()); // rows
    let palette_off = ts::HEADER_SIZE as u32;
    let dir_off = palette_off + 1024;
    let data_off = dir_off + 4 * ts::DIR_ENTRY_SIZE as u32;
    blob.extend_from_slice(&palette_off.to_le_bytes());
    blob.extend_from_slice(&dir_off.to_le_bytes());
    blob.extend_from_slice(&data_off.to_le_bytes());
    blob.extend_from_slice(&0u32.to_le_bytes()); // reserved
    assert_eq!(blob.len(), ts::HEADER_SIZE);
    let mut palette = [0u8; 1024];
    palette[5 * 4] = 0xaa; // distinctive red channel at index 5
    blob.extend_from_slice(&palette);
    for (off, len) in [(0u32, 2u32), (ts::ABSENT, 0), (9, 0), (2, 2)] {
        blob.extend_from_slice(&off.to_le_bytes());
        blob.extend_from_slice(&len.to_le_bytes());
    }
    blob.extend_from_slice(&[142, 5, 142, 6]); // two RLE streams: 16 x 5, 16 x 6
    blob
}

#[test]
fn tileset_tile_materializes_pixel_stream_tiles_only() {
    let mut ui = Ui::new();
    let blob = tiny_tileset();
    let t0 = ui.upload_tileset_tile(&blob, 0);
    assert!(t0 >= 0);
    let view = ui.texture(t0).unwrap();
    assert_eq!((view.w, view.h, view.psm), (4, 4, spec::psm::PSM_T8));
    assert!(view.linear, "tileset flags bit 1 maps to bilinear sampling");
    assert_eq!(view.pixels, &[5u8; 16][..]);
    assert_eq!(view.palette.unwrap()[5 * 4], 0xaa, "shared entry palette rides along");
    // ABSENT and SOLID tiles are the host's job (drawn as background/RECTs).
    assert_eq!(ui.upload_tileset_tile(&blob, 1), -1);
    assert_eq!(ui.upload_tileset_tile(&blob, 2), -1);
    let t3 = ui.upload_tileset_tile(&blob, 3);
    assert_eq!(ui.texture(t3).unwrap().pixels, &[6u8; 16][..]);
    assert_ne!(t0, t3, "each tile is its own slot");
}

#[test]
fn tileset_tile_rejects_malformed_blobs_without_panicking() {
    use spec::tileset as ts;
    let mut ui = Ui::new();
    let blob = tiny_tileset();
    assert_eq!(ui.upload_tileset_tile(&blob, 4), -1, "index out of range");
    assert_eq!(ui.upload_tileset_tile(&blob, u32::MAX), -1);
    assert_eq!(ui.upload_tileset_tile(&blob[..blob.len() - 1], 3), -1, "truncated stream");
    assert_eq!(ui.upload_tileset_tile(&blob[..ts::HEADER_SIZE], 0), -1, "header only");
    assert_eq!(ui.upload_tileset_tile(&[], 0), -1);
    let mut bad_magic = blob.clone();
    bad_magic[0] ^= 0xff;
    assert_eq!(ui.upload_tileset_tile(&bad_magic, 0), -1);
    let mut bad_version = blob.clone();
    bad_version[4] = 99;
    assert_eq!(ui.upload_tileset_tile(&bad_version, 0), -1);
    // Hostile offsets must be caught by bounds checks, not wrap/panic.
    let mut bad_pal = blob.clone();
    bad_pal[16..20].copy_from_slice(&u32::MAX.to_le_bytes()); // paletteOff
    assert_eq!(ui.upload_tileset_tile(&bad_pal, 0), -1);
    let mut bad_dir = blob.clone();
    bad_dir[20..24].copy_from_slice(&u32::MAX.to_le_bytes()); // dirOff
    assert_eq!(ui.upload_tileset_tile(&bad_dir, 0), -1);
    let mut bad_data = blob.clone();
    bad_data[24..28].copy_from_slice(&u32::MAX.to_le_bytes()); // dataOff
    assert_eq!(ui.upload_tileset_tile(&bad_data, 0), -1);
}

#[test]
fn freed_handles_go_stale_and_slots_reuse_under_a_new_generation() {
    let mut ui = Ui::new();
    let px = alloc::vec![0xffu8; 8 * 8 * 4];
    let a = ui.upload_texture(&px, 8, 8, spec::psm::PSM_8888);
    let b = ui.upload_texture(&px, 8, 8, spec::psm::PSM_8888);
    assert_eq!((a, b), (0, 1), "sequential uploads keep the old 0-based numbering");
    ui.free_texture(a);
    assert!(ui.texture(a).is_none(), "freed handle resolves to None");
    ui.free_texture(a); // double free: silent no-op
    assert!(ui.texture(b).is_some(), "other slots unaffected");
    // LIFO reuse of slot 0 under generation 1 -> a DIFFERENT handle.
    let c = ui.upload_texture(&px, 8, 8, spec::psm::PSM_8888);
    assert_ne!(c, a, "reused slot must not resurrect the old handle");
    assert!(c > 0, "handles stay positive (bit 31 clear)");
    assert_eq!(c as u32 & spec::TEX_SLOT_MASK, 0, "slot 0 reused LIFO");
    assert_eq!(c as u32 >> spec::TEX_SLOT_BITS, 1, "generation bumped");
    assert!(ui.texture(a).is_none(), "the stale handle stays dead after reuse");
    assert!(ui.texture(c).is_some());
    // set_image ignores the stale handle but honors the live one.
    let img = ui.create_node(spec::NodeType::Image as u8);
    ui.set_image(img, a);
    ui.set_image(img, c);
    // The wgpu sync walk sees live slots under their CURRENT handles.
    assert_eq!(ui.texture_slot_count(), 2);
    let (h0, _) = ui.texture_at(0).unwrap();
    assert_eq!(h0, c);
    let (h1, _) = ui.texture_at(1).unwrap();
    assert_eq!(h1, b);
    ui.free_texture(c);
    assert!(ui.texture_at(0).is_none(), "free slots are skipped by the walk");
    assert_eq!(ui.texture_slot_count(), 2, "slot storage never shrinks");
    assert!(ui.texture_at(2).is_none());
}

#[test]
fn disc_cache_survives_js_freeing_its_texture() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 36.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::RADIUS, 8.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(255, 0, 0, 255) as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let find_disc = |words: &[u32]| -> i32 {
        let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
        words[i + 1] as i32
    };
    let disc = find_disc(&ui.draw().words.clone());
    assert!(ui.texture(disc).is_some(), "corner disc is a live texture");
    // JS misuse: freeTexture on the internal disc slot. Must not panic; the
    // next draw re-validates, re-bakes, and emits a live handle again.
    ui.free_texture(disc);
    let disc2 = find_disc(&ui.draw().words.clone());
    assert_ne!(disc2, disc, "rebaked disc lives under a new generation");
    assert!(ui.texture(disc2).is_some());
    assert!(ui.texture(disc).is_none());
    // Steady state: the rebaked handle is reused, not rebaked per frame.
    assert_eq!(find_disc(&ui.draw().words.clone()), disc2);
    assert_eq!(ui.texture_slot_count(), 1, "the freed slot was reused LIFO");
}
