//! DrawList decoding shared by every walker that needs operation boundaries.
//!
//! The DrawList is a flat `[u32]` stream (layout in `contracts/spec/spec.ts`).
//! [`Decoder`] splits it into operations, tracks the scissor stack the core
//! emitted, and reports each operation's conservative logical bounds under
//! the scissor in effect. The op set is closed per DrawList version, so an
//! unknown code is a malformed stream rather than something to skip.
//!
//! The damage tracker and hardware backends consume this decoder; the
//! software rasterizer keeps its own inline walk because it renders while it
//! walks.

use alloc::vec::Vec;

use crate::damage::DamageRect;
use crate::{spec, Ui};

/// Maximum nested scissor depth a DrawList may use.
pub const CLIP_DEPTH: usize = 32;

/// Why a DrawList could not be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// Unknown op code, truncated operation, or unbalanced scissor stack.
    Malformed,
}

/// One decoded DrawList operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Op<'a> {
    /// `spec::draw_op::*` code.
    pub code: u32,
    /// Word index of the header inside the DrawList.
    pub offset: usize,
    /// The operation's words, header included.
    pub words: &'a [u32],
    /// Conservative logical bounds under the scissor in effect (empty for
    /// SCISSOR_POP; the pushed rectangle for SCISSOR).
    pub bounds: DamageRect,
    /// Scissor in effect while this operation draws.
    pub clip: DamageRect,
}

/// Word count of the operation starting at `at`, or `None` when the header
/// is unknown or truncated.
pub fn op_len(words: &[u32], at: usize) -> Option<usize> {
    let code = *words.get(at)?;
    match code {
        spec::draw_op::RECT => Some(4),
        spec::draw_op::GRAD_RECT => Some(6),
        spec::draw_op::GLYPH_RUN => {
            let count = (words.get(at + 1).copied()? >> 16) as usize;
            3usize.checked_add(count.checked_mul(2)?)
        }
        spec::draw_op::TEX_QUAD => Some(9),
        spec::draw_op::SCISSOR => Some(3),
        spec::draw_op::SCISSOR_POP => Some(1),
        spec::draw_op::TRI => Some(7),
        spec::draw_op::TEX_TRI => Some(12),
        spec::draw_op::TEXT_RUN => {
            // 8 header words + ceil(byteLen/4) packed UTF-8 words.
            let bytes = *words.get(at + 7)? as usize;
            8usize.checked_add(bytes.div_ceil(4))
        }
        spec::draw_op::SURFACE_QUAD => Some(9),
        _ => None,
    }
}

/// Streaming DrawList decoder with scissor tracking.
pub struct Decoder<'a> {
    words: &'a [u32],
    index: usize,
    screen: DamageRect,
    clip: DamageRect,
    stack: [DamageRect; CLIP_DEPTH],
    depth: usize,
}

impl<'a> Decoder<'a> {
    /// Start decoding `words` inside the logical `screen` rectangle.
    pub fn new(words: &'a [u32], screen: DamageRect) -> Self {
        Self {
            words,
            index: 0,
            screen,
            clip: screen,
            stack: [screen; CLIP_DEPTH],
            depth: 0,
        }
    }

    /// Scissor in effect for the next operation.
    pub fn clip(&self) -> DamageRect {
        self.clip
    }

    /// Decode the next operation; `Ok(None)` at the end of the stream.
    pub fn next(&mut self, ui: &Ui) -> Result<Option<Op<'a>>, DecodeError> {
        if self.index == self.words.len() {
            return Ok(None);
        }
        let start = self.index;
        let code = *self.words.get(start).ok_or(DecodeError::Malformed)?;
        let len = op_len(self.words, start).ok_or(DecodeError::Malformed)?;
        let end = start.checked_add(len).ok_or(DecodeError::Malformed)?;
        let words = self.words.get(start..end).ok_or(DecodeError::Malformed)?;
        self.index = end;
        let clip = self.clip;

        let bounds = match code {
            spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                logical_rect(words[1], words[2]).intersect(clip)
            }
            spec::draw_op::GLYPH_RUN => glyph_run_bounds(ui, words, clip),
            spec::draw_op::TEX_QUAD => logical_rect(words[2], words[3]).intersect(clip),
            spec::draw_op::SCISSOR => {
                if self.depth >= self.stack.len() {
                    return Err(DecodeError::Malformed);
                }
                self.stack[self.depth] = clip;
                self.depth += 1;
                self.clip = self.screen.intersect(logical_rect(words[1], words[2]));
                self.clip
            }
            spec::draw_op::SCISSOR_POP => {
                if self.depth == 0 {
                    return Err(DecodeError::Malformed);
                }
                self.depth -= 1;
                self.clip = self.stack[self.depth];
                DamageRect::empty()
            }
            spec::draw_op::TRI => triangle_bounds([words[1], words[2], words[3]], clip),
            spec::draw_op::TEX_TRI => triangle_bounds([words[2], words[5], words[8]], clip),
            // Native-text runs carry no glyph geometry a decoder can measure;
            // the core keeps every partially-clipped run inside a scissor, so
            // the current clip is a sound (conservative) bound.
            spec::draw_op::TEXT_RUN => clip,
            spec::draw_op::SURFACE_QUAD => logical_rect(words[6], words[7]).intersect(clip),
            _ => return Err(DecodeError::Malformed),
        };
        Ok(Some(Op {
            code,
            offset: start,
            words,
            bounds,
            clip,
        }))
    }

    /// True when every SCISSOR has been popped.
    pub fn is_balanced(&self) -> bool {
        self.depth == 0
    }
}

/// Decode a complete DrawList into operations, rejecting unknown codes,
/// truncated operations, and unbalanced scissors.
pub fn decode<'a>(
    ui: &Ui,
    words: &'a [u32],
    screen: DamageRect,
) -> Result<Vec<Op<'a>>, DecodeError> {
    let mut decoder = Decoder::new(words, screen);
    let mut operations = Vec::with_capacity(words.len() / 4);
    while let Some(operation) = decoder.next(ui)? {
        operations.push(operation);
    }
    if !decoder.is_balanced() {
        return Err(DecodeError::Malformed);
    }
    Ok(operations)
}

/// Union of every glyph cell in a GLYPH_RUN, clipped; empty when the run's
/// color has zero alpha or the font slot is unloaded.
pub fn glyph_run_bounds(ui: &Ui, words: &[u32], clip: DamageRect) -> DamageRect {
    if words.len() < 3 || words[2] >> 24 == 0 {
        return DamageRect::empty();
    }
    let slot = (words[1] & 0xff) as u8;
    let Some(atlas) = ui.font_atlas(slot) else {
        return DamageRect::empty();
    };
    let mut bounds = DamageRect::empty();
    for glyph in words[3..].chunks_exact(2) {
        let gid = (glyph[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        let (x, y) = xy(glyph[0]);
        bounds = bounds.union(DamageRect::new(
            x,
            y,
            x + atlas.cell_w as i32,
            y + atlas.cell_h as i32,
        ));
    }
    bounds.intersect(clip)
}

/// Bounding box of three packed XY vertices, clipped.
pub fn triangle_bounds(vertices: [u32; 3], clip: DamageRect) -> DamageRect {
    let [(x0, y0), (x1, y1), (x2, y2)] = vertices.map(xy);
    DamageRect::new(
        x0.min(x1).min(x2),
        y0.min(y1).min(y2),
        x0.max(x1).max(x2),
        y0.max(y1).max(y2),
    )
    .intersect(clip)
}

/// Unpack an XY word (two i16 halves) into logical coordinates.
#[inline]
pub fn xy(word: u32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32,
        (word >> 16) as u16 as i16 as i32,
    )
}

/// Unpack a WH word (two u16 halves) into a logical size.
#[inline]
pub fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

/// Logical rectangle from an XY and a WH word.
#[inline]
pub fn logical_rect(xy_word: u32, wh_word: u32) -> DamageRect {
    let (x, y) = xy(xy_word);
    let (w, h) = wh(wh_word);
    DamageRect::new(x, y, x + w, y + h)
}

/// Pack logical coordinates into an XY word.
#[inline]
pub fn pack_xy(x: i32, y: i32) -> u32 {
    x as i16 as u16 as u32 | ((y as i16 as u16 as u32) << 16)
}

/// Pack a logical size into a WH word.
#[inline]
pub fn pack_wh(w: i32, h: i32) -> u32 {
    w as u16 as u32 | ((h as u16 as u32) << 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(w: i32, h: i32) -> DamageRect {
        DamageRect::new(0, 0, w, h)
    }

    #[test]
    fn decodes_every_op_with_scissor_aware_bounds() {
        let ui = Ui::new();
        let words = [
            spec::draw_op::RECT,
            pack_xy(-2, 1),
            pack_wh(6, 3),
            0xff11_2233,
            spec::draw_op::SCISSOR,
            pack_xy(4, 0),
            pack_wh(8, 8),
            spec::draw_op::TEXT_RUN,
            0,
            0,
            0,
            0,
            0,
            0xffff_ffff,
            5,
            0,
            0,
            spec::draw_op::SURFACE_QUAD,
            0,
            0,
            0,
            0,
            0,
            pack_xy(2, 2),
            pack_wh(4, 4),
            0,
            spec::draw_op::SCISSOR_POP,
        ];
        let ops = decode(&ui, &words, screen(16, 8)).unwrap();
        let codes: Vec<u32> = ops.iter().map(|op| op.code).collect();
        assert_eq!(
            codes,
            [
                spec::draw_op::RECT,
                spec::draw_op::SCISSOR,
                spec::draw_op::TEXT_RUN,
                spec::draw_op::SURFACE_QUAD,
                spec::draw_op::SCISSOR_POP,
            ]
        );
        assert_eq!(ops[0].offset, 0);
        assert_eq!(ops[0].bounds, DamageRect::new(0, 1, 4, 4));
        assert_eq!(ops[0].clip, screen(16, 8));
        assert_eq!(ops[1].bounds, DamageRect::new(4, 0, 12, 8));
        assert_eq!(ops[2].offset, 7);
        assert_eq!(ops[2].words.len(), 10);
        assert_eq!(ops[2].bounds, DamageRect::new(4, 0, 12, 8));
        assert_eq!(ops[3].bounds, DamageRect::new(4, 2, 6, 6));
        assert_eq!(ops[3].clip, DamageRect::new(4, 0, 12, 8));
        assert!(ops[4].bounds.is_empty());
        assert_eq!(op_len(&words, 7), Some(10));
        assert_eq!(op_len(&words, 17), Some(9));
    }

    #[test]
    fn rejects_unknown_codes_truncation_and_unbalanced_scissors() {
        let ui = Ui::new();
        assert_eq!(decode(&ui, &[99], screen(4, 4)), Err(DecodeError::Malformed));
        assert_eq!(
            decode(&ui, &[spec::draw_op::RECT, 0, 0], screen(4, 4)),
            Err(DecodeError::Malformed)
        );
        assert_eq!(
            decode(&ui, &[spec::draw_op::SCISSOR, 0, pack_wh(2, 2)], screen(4, 4)),
            Err(DecodeError::Malformed)
        );
        assert_eq!(
            decode(&ui, &[spec::draw_op::SCISSOR_POP], screen(4, 4)),
            Err(DecodeError::Malformed)
        );
        assert_eq!(op_len(&[spec::draw_op::GLYPH_RUN], 0), None);
        assert_eq!(op_len(&[spec::draw_op::GLYPH_RUN, 2 << 16], 0), Some(7));
    }
}
