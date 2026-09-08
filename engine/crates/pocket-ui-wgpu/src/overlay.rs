//! A PocketJS guest over a Pocket3D frame. Applications provide JSON state
//! and consume JSON commands; the adapter owns viewport and pointer transport.

use crate::{UiRenderer, UiSurface};
use anyhow::{Context, Result, anyhow};
use pocket_mod::{Guest, qjs::Function};
use pocket3d::{
    gpu::Gpu,
    input::{Input, PointerEvent},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use winit::event::MouseButton;

pub struct UiOverlay {
    controls: BTreeMap<String, i32>,
    guest: Guest,
    surface: UiSurface,
    renderer: Option<(wgpu::TextureFormat, UiRenderer)>,
    size: (u32, u32),
    scale: f32,
}

impl UiOverlay {
    pub fn new(
        bundle: &str,
        pak: &[u8],
        size: (u32, u32),
        scale: f32,
        density: u32,
    ) -> Result<Self> {
        let scale = valid_scale(scale);
        let surface =
            UiSurface::new_with_density((size.0 as f32 / scale, size.1 as f32 / scale), density);
        surface.set_svc_allowlist(["pocket.overlay"]);
        surface.feed_pak(pak);
        let guest = Guest::new()?;
        surface.mount(&guest)?;
        guest.eval("overlay", bundle)?;
        anyhow::ensure!(
            guest.has_frame(),
            "PocketJS overlay bundle installed no frame handler"
        );
        surface.tick();
        Ok(Self {
            controls: BTreeMap::new(),
            guest,
            surface,
            renderer: None,
            size,
            scale,
        })
    }

    /// Resize layout and input together. Pak raster density is independent of
    /// the OS scale, so a density-2 bundle also works at 1x and fractional DPI.
    pub fn resize(&mut self, size: (u32, u32), scale: f32) -> Result<()> {
        let size = (size.0.max(1), size.1.max(1));
        let scale = valid_scale(scale);
        if self.size == size && self.scale == scale {
            return Ok(());
        }
        self.cancel_pointer();
        self.size = size;
        self.scale = scale;
        let (width, height) = (size.0 as f32 / scale, size.1 as f32 / scale);
        self.surface.with_ui(|ui| ui.set_viewport(width, height));
        self.guest.with(|ctx| -> Result<()> {
            let hook: Option<Function> = ctx.globals().get("__pocketResizeViewport")?;
            if let Some(hook) = hook {
                hook.call::<_, ()>((width, height))
                    .map_err(|e| anyhow!("overlay resize: {e}"))?;
            }
            Ok(())
        })?;
        self.surface.tick();
        Ok(())
    }

    pub fn logical_size(&self) -> (f32, f32) {
        (
            self.size.0 as f32 / self.scale,
            self.size.1 as f32 / self.scale,
        )
    }

    pub fn cancel_pointer(&self) {
        self.surface
            .svc_push(json!({"type":"pointer", "event":{"kind":"cancel"}}).to_string());
    }

    /// Consume each rendered frame once. Ordered edges retain a press and
    /// release that both arrived between two frames. A closed overlay should
    /// be cancelled and receive no further game input.
    pub fn frame(&mut self, input: &Input, state: &Value) -> Result<Vec<Value>> {
        self.surface
            .svc_push(json!({"type":"state", "value":state}).to_string());
        for event in input.pointer_events() {
            if let Some(event) = pointer_packet(*event, self.scale) {
                self.surface
                    .svc_push(json!({"type":"pointer", "event":event}).to_string());
            }
        }
        self.guest.frame(0)?;
        self.surface.tick();
        let mut commands = Vec::new();
        for line in self.surface.svc_drain() {
            let value: Value =
                serde_json::from_str(&line).context("invalid PocketJS overlay command")?;
            if value["type"] == "pocket.overlay.control" {
                if let (Some(name), Some(node)) = (value["name"].as_str(), value["node"].as_i64()) {
                    if value["remove"] == true {
                        if self.controls.get(name) == Some(&(node as i32)) {
                            self.controls.remove(name);
                        }
                    } else {
                        self.controls.insert(name.to_owned(), node as i32);
                    }
                }
            } else {
                commands.push(value);
            }
        }
        Ok(commands)
    }

    /// Screen-space bounds from the core's painted geometry. This cold
    /// diagnostic query supports coordinate-driven acceptance and inspectors.
    /// It returns None for controls that are no longer painted.
    pub fn control_bounds(&self, name: &str) -> Option<(f32, f32, f32, f32)> {
        let &node = self.controls.get(name)?;
        self.surface.with_ui(|ui| {
            ui.debug_inspect(node);
            ui.draw();
            let xy = ui.debug_rect_xy();
            let wh = ui.debug_rect_wh();
            ui.debug_inspect(0);
            if wh == -1 {
                return None;
            }
            Some((
                (xy as i16) as f32 * self.scale,
                ((xy >> 16) as i16) as f32 * self.scale,
                (wh & 0xffff) as f32 * self.scale,
                ((wh >> 16) & 0xffff) as f32 * self.scale,
            ))
        })
    }

    pub fn render(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        format: wgpu::TextureFormat,
    ) -> Result<()> {
        if self.renderer.as_ref().is_none_or(|(old, _)| *old != format) {
            self.renderer = Some((format, UiRenderer::new(gpu, format)));
        }
        let (_, renderer) = self.renderer.as_mut().unwrap();
        self.surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            renderer.render_words_scaled(
                gpu,
                ui,
                &words,
                encoder,
                view,
                self.size,
                self.scale,
                wgpu::LoadOp::Load,
            )
        })
    }
}

fn valid_scale(scale: f32) -> f32 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn pointer_packet(event: PointerEvent, scale: f32) -> Option<Value> {
    let (position, kind, down) = match event {
        PointerEvent::Move(pos) => (pos, "move", None),
        PointerEvent::Button {
            position,
            button: MouseButton::Left,
            down,
        } => (position, "button", Some(down)),
        PointerEvent::Button { .. } => return None,
        PointerEvent::Cancel => return Some(json!({"kind":"cancel"})),
    };
    let mut packet =
        json!({"kind":kind, "x":position.map(|p| p.x / scale), "y":position.map(|p| p.y / scale)});
    if let Some(down) = down {
        packet["down"] = json!(down);
    }
    Some(packet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket3d::input::Input;

    #[test]
    fn ordered_clicks_and_cancellation_reach_the_guest_at_both_scales() {
        let bundle = r#"
            ui.svcOpen("pocket.overlay");
            globalThis.frame = function() {
                const batch = ui.svcPoll();
                if (batch) for (const line of batch.split("\n")) if (line) ui.svcSend(line);
            };
        "#;
        for scale in [1.0, 2.0] {
            let mut overlay = UiOverlay::new(bundle, &[], (960, 600), scale, 2).unwrap();
            let mut input = Input::default();
            input.inject_cursor(200.0, 100.0);
            input.inject_mouse_button(MouseButton::Left, true);
            input.inject_mouse_button(MouseButton::Left, false);
            let received = overlay.frame(&input, &json!({"count":1})).unwrap();
            assert_eq!(received.len(), 4);
            assert_eq!(received[1]["event"]["x"], json!(200.0 / scale));
            assert_eq!(received[2]["event"]["down"], true);
            assert_eq!(received[3]["event"]["down"], false);
            input.end_frame();
            input.clear();
            let received = overlay.frame(&input, &Value::Null).unwrap();
            assert_eq!(received[1]["event"]["kind"], "cancel");
            overlay.resize((1200, 800), scale).unwrap();
            assert_eq!(overlay.logical_size(), (1200.0 / scale, 800.0 / scale));
        }
    }
}
