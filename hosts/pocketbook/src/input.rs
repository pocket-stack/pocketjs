//! inkview events → PocketJS input state.
//!
//! Hardware keys map to the spec BTN bitmask (the same bits `uihost` uses);
//! the touchscreen maps to the framework's packed touch wire format
//! (`(id<<18)|(y<<9)|x`, framework/src/touch.ts) in LOGICAL viewport pixels.

use inkview::event::{Event, Key};
use pocketjs_core::spec::{btn, ANALOG_CENTER};

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
    ox: i32,
    oy: i32,
    logical_w: u32,
    logical_h: u32,
    /// Displayed width on the panel (after scale-to-fit).
    disp_w: u32,
    /// Displayed height on the panel (after scale-to-fit).
    disp_h: u32,
}

impl Input {
    pub fn new(ox: i32, oy: i32, logical_w: u32, logical_h: u32, disp_w: u32, disp_h: u32) -> Self {
        Self {
            buttons: 0,
            touch: None,
            ox,
            oy,
            logical_w,
            logical_h,
            disp_w,
            disp_h,
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
    /// Maps through the displayed area: screen → render → logical.
    fn to_logical(&self, x: i32, y: i32) -> (u32, u32) {
        let lx = ((x - self.ox).max(0) as u32 * self.logical_w / self.disp_w)
            .clamp(0, self.logical_w - 1);
        let ly = ((y - self.oy).max(0) as u32 * self.logical_h / self.disp_h)
            .clamp(0, self.logical_h - 1);
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
        Key::Up => btn::UP,
        Key::Down => btn::DOWN,
        Key::Left | Key::Prev | Key::Prev2 => btn::LEFT, // page-turn = prev
        Key::Right | Key::Next | Key::Next2 => btn::RIGHT, // page-turn = next
        Key::Ok => btn::CROSS,
        Key::Back => btn::CIRCLE,
        Key::Menu => btn::START,
        Key::Home => btn::SELECT,
        Key::Plus => btn::RTRIGGER,
        Key::Minus => btn::LTRIGGER,
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
        let mut input = Input::new(0, 0, 480, 320, 960, 640);
        assert_eq!(input.on_event_matches_key(Key::Ok), btn::CROSS);
        input.apply_key_down(Key::Ok);
        assert_eq!(input.snapshot().0 & btn::CROSS, btn::CROSS);
        input.apply_key_up(Key::Ok);
        assert_eq!(input.snapshot().0 & btn::CROSS, 0);
    }

    #[test]
    fn pointer_maps_physical_to_logical() {
        // No scaling: disp = logical * density = 511*2 × 379*2 = 1022×758,
        // offset (1, 0), logical 511×379.
        let mut input = Input::new(1, 0, 511, 379, 1022, 758);
        input.on_event(Event::PointerDown { x: 103, y: 41 });
        let (_, _, touches) = input.snapshot();
        assert_eq!(touches.len(), 1);
        // logical = (physical - offset) * logical / disp = (103-1)*511/1022=51, 41*379/758=20.
        assert_eq!(touches[0], pack_touch(0, 51, 20));
        input.on_event(Event::PointerUp { x: 103, y: 41 });
        assert!(input.snapshot().2.is_empty());
    }

    #[test]
    fn pointer_maps_with_scaling() {
        // Scaled: render 960×544 on panel 758×1024 → disp 758×429, ox=0, oy=297.
        // logical 480×272.
        let mut input = Input::new(0, 297, 480, 272, 758, 429);
        // Touch at panel (379, 512) → render (379*960/758, (512-297)*544/429)
        //   = (480, 272) → logical (480*480/960, 272*272/544) = (240, 136).
        // But via our formula: lx = 379*480/758 = 240, ly = (512-297)*272/429 = 215*272/429 = 136.
        input.on_event(Event::PointerDown { x: 379, y: 512 });
        let (_, _, touches) = input.snapshot();
        assert_eq!(touches.len(), 1);
        assert_eq!(touches[0], pack_touch(0, 240, 136));
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
