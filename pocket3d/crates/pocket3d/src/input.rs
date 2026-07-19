//! Keyboard/mouse state, fed by winit events or injected synthetically
//! (headless tests drive the same struct).

use std::collections::HashSet;

use glam::Vec2;
use winit::event::{DeviceEvent, ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::keyboard::{Key, KeyCode, NamedKey, PhysicalKey};

/// One text-editing keystroke, in press order, key repeats included. The
/// per-frame stream a text-editing widget consumes ([`Input::edits`]) —
/// distinct from the held-state model (`key_down`/`key_pressed`), which
/// ignores repeats on purpose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKey {
    /// A typed character (winit's logical `KeyEvent::text`, so shift and
    /// layout are already applied). Control characters never appear here.
    Char(char),
    Backspace,
    Delete,
    Enter,
    Tab,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Escape,
}

#[derive(Default)]
pub struct Input {
    down: HashSet<KeyCode>,
    pressed: HashSet<KeyCode>,
    mouse_down: HashSet<u8>,
    mouse_pressed: HashSet<u8>,
    mouse_delta: Vec2,
    cursor: Option<Vec2>,
    edits: Vec<EditKey>,
    scroll: Vec2,
    /// A super/command chord is held — edit consumers usually skip
    /// `Char` events while true (they are shortcuts, not typing).
    super_down: bool,
}

fn button_id(b: MouseButton) -> u8 {
    match b {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
        MouseButton::Other(n) => (5 + (n % 250)) as u8,
    }
}

impl Input {
    pub fn on_window_event(&mut self, event: &WindowEvent) {
        match event {
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    match event.state {
                        ElementState::Pressed => {
                            if !event.repeat && self.down.insert(code) {
                                self.pressed.insert(code);
                            }
                        }
                        ElementState::Released => {
                            self.down.remove(&code);
                        }
                    }
                }
                // The edit stream: logical keys, repeats included.
                if event.state == ElementState::Pressed {
                    let named = match &event.logical_key {
                        Key::Named(NamedKey::Backspace) => Some(EditKey::Backspace),
                        Key::Named(NamedKey::Delete) => Some(EditKey::Delete),
                        Key::Named(NamedKey::Enter) => Some(EditKey::Enter),
                        Key::Named(NamedKey::Tab) => Some(EditKey::Tab),
                        Key::Named(NamedKey::ArrowLeft) => Some(EditKey::Left),
                        Key::Named(NamedKey::ArrowRight) => Some(EditKey::Right),
                        Key::Named(NamedKey::ArrowUp) => Some(EditKey::Up),
                        Key::Named(NamedKey::ArrowDown) => Some(EditKey::Down),
                        Key::Named(NamedKey::Home) => Some(EditKey::Home),
                        Key::Named(NamedKey::End) => Some(EditKey::End),
                        Key::Named(NamedKey::PageUp) => Some(EditKey::PageUp),
                        Key::Named(NamedKey::PageDown) => Some(EditKey::PageDown),
                        Key::Named(NamedKey::Escape) => Some(EditKey::Escape),
                        Key::Named(NamedKey::Super) => {
                            self.super_down = true;
                            None
                        }
                        _ => None,
                    };
                    if let Some(k) = named {
                        self.edits.push(k);
                    } else if let Some(text) = &event.text {
                        self.edits.extend(
                            text.chars().filter(|c| !c.is_control()).map(EditKey::Char),
                        );
                    }
                } else if matches!(&event.logical_key, Key::Named(NamedKey::Super)) {
                    self.super_down = false;
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                // Normalize to logical px; a line is worth ~20.
                self.scroll += match delta {
                    MouseScrollDelta::LineDelta(x, y) => Vec2::new(x * 20.0, y * 20.0),
                    MouseScrollDelta::PixelDelta(p) => Vec2::new(p.x as f32, p.y as f32),
                };
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let id = button_id(*button);
                match state {
                    ElementState::Pressed => {
                        if self.mouse_down.insert(id) {
                            self.mouse_pressed.insert(id);
                        }
                    }
                    ElementState::Released => {
                        self.mouse_down.remove(&id);
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = Some(Vec2::new(position.x as f32, position.y as f32));
            }
            WindowEvent::CursorLeft { .. } => self.cursor = None,
            WindowEvent::Focused(false) => self.clear(),
            _ => {}
        }
    }

    /// Cursor position in window pixels, `None` while outside the window.
    pub fn cursor(&self) -> Option<Vec2> {
        self.cursor
    }

    pub fn on_device_event(&mut self, event: &DeviceEvent) {
        if let DeviceEvent::MouseMotion { delta } = event {
            self.mouse_delta += Vec2::new(delta.0 as f32, delta.1 as f32);
        }
    }

    /// Forget everything held (focus loss, mode switches).
    pub fn clear(&mut self) {
        self.down.clear();
        self.pressed.clear();
        self.mouse_down.clear();
        self.mouse_pressed.clear();
        self.mouse_delta = Vec2::ZERO;
        self.edits.clear();
        self.scroll = Vec2::ZERO;
        self.super_down = false;
    }

    /// Call once per rendered frame, after game logic consumed the state.
    pub fn end_frame(&mut self) {
        self.pressed.clear();
        self.mouse_pressed.clear();
        self.mouse_delta = Vec2::ZERO;
        self.edits.clear();
        self.scroll = Vec2::ZERO;
    }

    /// This frame's text-editing keystrokes, in press order (repeats
    /// included). Cleared by `end_frame`.
    pub fn edits(&self) -> &[EditKey] {
        &self.edits
    }

    /// This frame's accumulated scroll-wheel delta in logical px
    /// (y positive = content up, winit convention). Cleared by `end_frame`.
    pub fn scroll(&self) -> Vec2 {
        self.scroll
    }

    /// A super/command key is currently held.
    pub fn super_down(&self) -> bool {
        self.super_down
    }

    pub fn key_down(&self, code: KeyCode) -> bool {
        self.down.contains(&code)
    }
    /// True only on the frame the key went down.
    pub fn key_pressed(&self, code: KeyCode) -> bool {
        self.pressed.contains(&code)
    }
    pub fn mouse_button_down(&self, button: MouseButton) -> bool {
        self.mouse_down.contains(&button_id(button))
    }
    pub fn mouse_button_pressed(&self, button: MouseButton) -> bool {
        self.mouse_pressed.contains(&button_id(button))
    }
    pub fn mouse_delta(&self) -> Vec2 {
        self.mouse_delta
    }

    // --- synthetic injection (headless scripting/tests) -------------------

    pub fn inject_key(&mut self, code: KeyCode, down: bool) {
        if down {
            if self.down.insert(code) {
                self.pressed.insert(code);
            }
        } else {
            self.down.remove(&code);
        }
    }

    pub fn inject_mouse_button(&mut self, button: MouseButton, down: bool) {
        let id = button_id(button);
        if down {
            if self.mouse_down.insert(id) {
                self.mouse_pressed.insert(id);
            }
        } else {
            self.mouse_down.remove(&id);
        }
    }

    pub fn inject_mouse_delta(&mut self, dx: f32, dy: f32) {
        self.mouse_delta += Vec2::new(dx, dy);
    }

    /// Place the cursor at a window-pixel position (scripted picking).
    pub fn inject_cursor(&mut self, x: f32, y: f32) {
        self.cursor = Some(Vec2::new(x, y));
    }

    /// Append a text-editing keystroke (scripted typing).
    pub fn inject_edit(&mut self, key: EditKey) {
        self.edits.push(key);
    }

    /// Add scroll-wheel delta in logical px (scripted scrolling).
    pub fn inject_scroll(&mut self, dx: f32, dy: f32) {
        self.scroll += Vec2::new(dx, dy);
    }
}
