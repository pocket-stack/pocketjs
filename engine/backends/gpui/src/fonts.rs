//! The font slot table and the native text measurer.
//!
//! Measurement and painting MUST agree glyph-for-glyph, so both sides build
//! their [`gpui::Font`] through one [`TextConfig`]. Ligatures, contextual
//! alternates and kerning are disabled: app editor math measures prefixes
//! through the `measureText` op (apps/note/layout.ts, apps/im/wrap.ts), and
//! prefix sums only equal shaped positions when advances are additive.
//! Complex scripts still shape correctly — only the discretionary
//! substitutions are off.

use std::sync::Arc;

use gpui::{
    px, Font, FontFeatures, FontStyle, FontWeight, SharedString, TextRun, WindowTextSystem,
};
use pocketjs_core::text::MeasureFn;

/// Slot -> px mirror of the compiler's slot registry
/// (framework/compiler/tailwind.ts FONT_PX: slots 0..6 regular, 7..13 bold,
/// 14/15 the 54 px display pair) — the same hand-mirror note-widget's
/// cjk.rs keeps.
const FONT_PX: [f32; 7] = [12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 36.0];
const LARGE_PX: f32 = 54.0;

/// (font px, bold) for a font slot; unknown slots read as slot 1 (14 px).
pub fn slot_px(slot: u8) -> (f32, bool) {
    match slot {
        0..=6 => (FONT_PX[slot as usize], false),
        7..=13 => (FONT_PX[(slot - 7) as usize], true),
        14 => (LARGE_PX, false),
        15 => (LARGE_PX, true),
        _ => (FONT_PX[1], false),
    }
}

/// The one shaping configuration measurement and painting share.
#[derive(Clone)]
pub struct TextConfig {
    /// Font family (the host registers Inter from assets/fonts by default;
    /// ".SystemUIFont" is the gpui spelling of the system face).
    pub family: SharedString,
}

impl TextConfig {
    pub fn new(family: impl Into<SharedString>) -> TextConfig {
        TextConfig { family: family.into() }
    }

    pub fn font(&self, bold: bool) -> Font {
        Font {
            family: self.family.clone(),
            // Additive advances (see module doc): no ligatures, no kerning.
            features: FontFeatures(Arc::new(vec![
                ("liga".into(), 0),
                ("calt".into(), 0),
                ("kern".into(), 0),
            ])),
            fallbacks: None,
            weight: if bold { FontWeight::BOLD } else { FontWeight::NORMAL },
            style: FontStyle::Normal,
        }
    }

    pub fn run(&self, len: usize, bold: bool, color: gpui::Hsla) -> TextRun {
        TextRun {
            len,
            font: self.font(bold),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }
}

/// Default line height for a slot: ceil(ascent + descent), the native
/// counterpart of the baked atlas header's `lineHeight`
/// (framework/compiler/bake-font.ts rounds ascent + descent + lineGap).
pub fn slot_line_height(ts: &WindowTextSystem, cfg: &TextConfig, slot: u8) -> f32 {
    let (size, bold) = slot_px(slot);
    let font_id = ts.resolve_font(&cfg.font(bold));
    let ascent = f32::from(ts.ascent(font_id, px(size)));
    let descent = f32::from(ts.descent(font_id, px(size)));
    (ascent + descent).ceil()
}

/// Build the core text measurer (installed via `UiSurface::set_text_measure`
/// BEFORE the guest mounts). Same `'\n'`-only break contract as the baked
/// `Fonts::measure_run`; tracking never reaches this path (the core routes
/// tracked runs to the baked pair — see engine/core/src/text.rs).
pub fn native_measure(ts: Arc<WindowTextSystem>, cfg: TextConfig) -> MeasureFn {
    Box::new(move |text: &str, slot: u8, _tracking: f32, line_h: f32| {
        let (size, bold) = slot_px(slot);
        let lh = if line_h.is_nan() { slot_line_height(&ts, &cfg, slot) } else { line_h };
        let mut max_w = 0.0f32;
        let mut lines = 0u32;
        for line in text.split('\n') {
            lines += 1;
            if line.is_empty() {
                continue;
            }
            let run = cfg.run(line.len(), bold, gpui::black());
            let shaped = ts.layout_line(line, px(size), &[run], None);
            max_w = max_w.max(f32::from(shaped.width));
        }
        (max_w, lines as f32 * lh)
    })
}
