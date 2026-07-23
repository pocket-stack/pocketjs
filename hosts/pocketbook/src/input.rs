//! inkview events → PocketJS input state.
//!
//! Hardware keys map to the spec BTN bitmask (the same bits `uihost` uses);
//! the touchscreen maps to the framework's packed touch wire format
//! (`(id<<18)|(y<<9)|x`, framework/src/touch.ts) in LOGICAL viewport pixels.

use inkview::event::{Event, Key};
use pocketjs_core::spec::ANALOG_CENTER;

// spec BTN bits (contracts/spec/spec.ts; mirrored by uihost).
const BTN_SELECT: u32 = 0x0001;
const BTN_START: u32 = 0x0008;
const BTN_UP: u32 = 0x0010;
const BTN_RIGHT: u32 = 0x0020;
const BTN_DOWN: u32 = 0x0040;
const BTN_LEFT: u32 = 0x0080;
const BTN_LTRIGGER: u32 = 0x0100;
const BTN_RTRIGGER: u32 = 0x0200;
const BTN_CIRCLE: u32 = 0x2000;
const BTN_CROSS: u32 = 0x4000;

/// What the render loop should do after handling an event.
pub enum Outcome {
    Continue,
    Quit,
    /// A full redraw was requested (e.g. returning from background).
    FullRedraw,
}

pub struct Input {
    buttons: u32,
    /// Current contact in LOGICAL px (None = up). PocketBook is single-touch.
    touch: Option<(u32, u32)>,
    density: i32,
    ox: i32,
    oy: i32,
    logical_w: u32,
    logical_h: u32,
}

impl Input {
    pub fn new(density: u32, ox: i32, oy: i32, logical_w: u32, logical_h: u32) -> Self {
        Self {
            buttons: 0,
            touch: None,
            density: density as i32,
            ox,
            oy,
            logical_w,
            logical_h,
        }
    }

    pub fn on_event(&mut self, ev: Event) -> Outcome {
        match ev {
            Event::Exit => Outcome::Quit,
            Event::Show => Outcome::FullRedraw,
            Event::KeyDown { key } | Event::KeyRepeat { key } => {
                self.buttons |= key_bit(key);
                Outcome::Continue
            }
            Event::KeyUp { key } => {
                self.buttons &= !key_bit(key);
                Outcome::Continue
            }
            Event::PointerDown { x, y } | Event::PointerMove { x, y } => {
                self.touch = Some(self.to_logical(x, y));
                Outcome::Continue
            }
            Event::PointerUp { .. } => {
                self.touch = None;
                Outcome::Continue
            }
            _ => Outcome::Continue,
        }
    }

    /// Physical screen px → logical viewport px (≤511/axis by construction).
    fn to_logical(&self, x: i32, y: i32) -> (u32, u32) {
        let lx = ((x - self.ox) / self.density).clamp(0, self.logical_w as i32 - 1) as u32;
        let ly = ((y - self.oy) / self.density).clamp(0, self.logical_h as i32 - 1) as u32;
        (lx, ly)
    }

    /// (buttons, analog, packed touches) for `Guest::frame_with_touches`.
    pub fn snapshot(&self) -> (u32, u32, Vec<u32>) {
        let touches = self
            .touch
            .map(|(x, y)| vec![pack_touch(0, x, y)])
            .unwrap_or_default();
        (self.buttons, ANALOG_CENTER, touches)
    }
}

/// framework/src/touch.ts `__packTouch`: `(id<<18)|(y<<9)|x`.
fn pack_touch(id: u32, x: u32, y: u32) -> u32 {
    ((id & 0xff) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)
}

fn key_bit(key: Key) -> u32 {
    match key {
        Key::Up => BTN_UP,
        Key::Down => BTN_DOWN,
        Key::Left | Key::Prev | Key::Prev2 => BTN_LEFT,   // page-turn = prev
        Key::Right | Key::Next | Key::Next2 => BTN_RIGHT, // page-turn = next
        Key::Ok => BTN_CROSS,
        Key::Back => BTN_CIRCLE,
        Key::Menu => BTN_START,
        Key::Home => BTN_SELECT,
        Key::Plus => BTN_RTRIGGER,
        Key::Minus => BTN_LTRIGGER,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_packs_id_y_x() {
        assert_eq!(pack_touch(0, 10, 20), (20 << 9) | 10);
        assert_eq!(pack_touch(3, 1, 2), (3 << 18) | (2 << 9) | 1);
        // 9-bit clamp at the wire level:
        assert_eq!(pack_touch(0, 511, 511), (511 << 9) | 511);
    }

    #[test]
    fn keys_set_and_clear_button_bits() {
        let mut input = Input::new(2, 0, 0, 480, 320);
        assert_eq!(input.on_event_matches_key(Key::Ok), BTN_CROSS);
        input.apply_key_down(Key::Ok);
        assert_eq!(input.snapshot().0 & BTN_CROSS, BTN_CROSS);
        input.apply_key_up(Key::Ok);
        assert_eq!(input.snapshot().0 & BTN_CROSS, 0);
    }

    #[test]
    fn pointer_maps_physical_to_logical() {
        // density 2, offset (1, 0), logical 511×379.
        let mut input = Input::new(2, 1, 0, 511, 379);
        input.on_event(Event::PointerDown { x: 103, y: 41 });
        let (_, _, touches) = input.snapshot();
        assert_eq!(touches.len(), 1);
        // logical = (physical - offset) / density = (103-1)/2=51, 41/2=20.
        assert_eq!(touches[0], pack_touch(0, 51, 20));
        input.on_event(Event::PointerUp { x: 103, y: 41 });
        assert!(input.snapshot().2.is_empty());
    }

    // Test helpers (avoid needing to construct full Events for key tests).
    impl Input {
        fn on_event_matches_key(&self, key: Key) -> u32 {
            key_bit(key)
        }
        fn apply_key_down(&mut self, key: Key) {
            self.buttons |= key_bit(key);
        }
        fn apply_key_up(&mut self, key: Key) {
            self.buttons &= !key_bit(key);
        }
    }
}
