//! Touch hit facts (docs/TOUCH.md): the per-contact capture table behind
//! frame() argument 4.
//!
//! A host with input.touch resolves the bounds hit for each contact ONCE, on
//! the frame the contact appears, against the committed layout — the world
//! the user was looking at when the finger landed — and carries that node id
//! for the contact's lifetime (UIKit's implicit capture, host edition). The
//! guest never issues a hit query on the touch path; `Ui::touch_hits` is the
//! one entry hosts call right before invoking the guest frame.
//!
//! Wire packing (framework/src/touch.ts is the decoding twin): legacy form
//! bit31=0, x:9 y:9 id:8; wide form bit31=1, x:10 y:10 id:8 (append-only,
//! detected per contact word).

const WIDE_MARKER: u32 = 0x8000_0000;

/// (id, x, y) from one packed contact word — either packing form.
pub fn decode(packed: u32) -> (u8, f32, f32) {
    let (coord_bits, mask) = if packed & WIDE_MARKER != 0 {
        (10u32, 0x3ffu32)
    } else {
        (9u32, 0x1ffu32)
    };
    let x = packed & mask;
    let y = (packed >> coord_bits) & mask;
    let id = (packed >> (coord_bits * 2)) & 0xff;
    (id as u8, x as f32, y as f32)
}

/// Contact-id -> hit-at-down slots. Eight is the wire cap for simultaneous
/// contacts; ids themselves may exceed 8 (Vita's sceTouch cycles 0..127).
#[derive(Default)]
pub struct HitTable {
    pub(crate) ids: [u8; 8],
    pub(crate) hits: [i32; 8],
    pub(crate) live: [bool; 8],
}
