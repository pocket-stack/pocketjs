//! Keyboard/mouse state, fed by winit events or injected synthetically
//! (headless tests drive the same struct).

use std::collections::HashSet;

use glam::Vec2;
use winit::event::{DeviceEvent, ElementState, MouseButton, WindowEvent};
use winit::keyboard::{KeyCode, PhysicalKey};

#[derive(Default)]
pub struct Input {
    down: HashSet<KeyCode>,
    pressed: HashSet<KeyCode>,
    mouse_down: HashSet<u8>,
    mouse_pressed: HashSet<u8>,
    mouse_delta: Vec2,
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
            WindowEvent::Focused(false) => self.clear(),
            _ => {}
        }
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
    }

    /// Call once per rendered frame, after game logic consumed the state.
    pub fn end_frame(&mut self) {
        self.pressed.clear();
        self.mouse_pressed.clear();
        self.mouse_delta = Vec2::ZERO;
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
}
