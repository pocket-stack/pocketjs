//! pocket-mod — guest hosting for the Pocket runtime family.
//!
//! The mechanism half of the extension architecture (see docs/RUNTIMES.md):
//! a runtime is ⟨Cores, Surfaces, Guest⟩, and this crate owns the **Guest** —
//! one QuickJS realm evaluating one bundled product (an app, a game's mods,
//! or both), plus the plumbing every runtime shares:
//!
//!   - realm lifecycle: create, mount surfaces, eval the bundle;
//!   - surface mounting: a named namespace object on `globalThis`
//!     (`ui`, `strike`, …) populated with native op functions;
//!   - the guest turn: `frame(buttons, analog)` once per fixed-step tick,
//!     then the job queue drains (Law 3: one guest turn per host tick — the
//!     guest never owns a timer or a thread);
//!   - `console.*` routed to the host's `log` output.
//!
//! Cores never call the guest mid-tick; surfaces deliver facts as per-tick
//! event batches built through [`Guest::with`].
//!
//! The realm is deliberately capability-free: no filesystem, no network, no
//! process access. A guest can affect exactly what its mounted surfaces
//! express.

use anyhow::{Result, anyhow};
use rquickjs::{CatchResultExt, Context, Ctx, Function, Object, Runtime};

// Surface crates implement ops against the same rquickjs the guest uses.
pub use rquickjs as qjs;

/// Real-pointer edge kind in the versioned frame-input payload. Numeric
/// values are pinned to `framework/src/frame-input.ts::POINTER_EVENT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PointerEventKind {
    Move = 0,
    Down = 1,
    Up = 2,
    Leave = 3,
    Cancel = 4,
}

/// One ordered real-pointer edge. Coordinates are logical viewport pixels;
/// they remain ordinary f64 values on the JS wire (no 9/10-bit packing).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerEvent {
    pub kind: PointerEventKind,
    pub x: f64,
    pub y: f64,
    /// 0 is the primary button.
    pub button: u8,
    /// Bit 0 is Shift; future modifiers append bits.
    pub modifiers: u8,
}

impl PointerEvent {
    pub const fn at(kind: PointerEventKind, x: f64, y: f64) -> Self {
        Self {
            kind,
            x,
            y,
            button: 0,
            modifiers: 0,
        }
    }

    pub const fn boundary(kind: PointerEventKind) -> Self {
        Self::at(kind, 0.0, 0.0)
    }
}

/// Version 1 host input appended as frame() argument 5. The first four
/// positional tracks remain buttons, analog, touches, and touch hit facts.
pub struct FrameInput<'a> {
    pub pointer: &'a [PointerEvent],
}

/// One QuickJS realm hosting one guest program.
pub struct Guest {
    rt: Runtime,
    ctx: Context,
}

impl Guest {
    /// Create an empty realm with `console.*` installed. Mount surfaces and
    /// eval the product bundle next; drop and rebuild for a hot reload.
    pub fn new() -> Result<Guest> {
        let rt = Runtime::new()?;
        let ctx = Context::full(&rt)?;
        ctx.with(|ctx| install_console(&ctx))
            .map_err(|e| anyhow!("pocket-mod: installing console: {e}"))?;
        Ok(Guest { rt, ctx })
    }

    /// Run `f` with the realm's [`Ctx`]. Surface crates use this to build
    /// per-tick event payloads or to reach guest globals the helpers below
    /// don't cover.
    pub fn with<F, R>(&self, f: F) -> R
    where
        F: FnOnce(Ctx) -> R,
    {
        self.ctx.with(f)
    }

    /// Mount a surface: creates the namespace object, lets `build` populate
    /// it with op functions, and installs it as `globalThis.<name>`.
    pub fn mount<F>(&self, name: &str, build: F) -> Result<()>
    where
        F: for<'js> FnOnce(&Ctx<'js>, &Object<'js>) -> rquickjs::Result<()>,
    {
        self.ctx
            .with(|ctx| -> rquickjs::Result<()> {
                let ns = Object::new(ctx.clone())?;
                build(&ctx, &ns)?;
                ctx.globals().set(name, ns)?;
                Ok(())
            })
            .map_err(|e| anyhow!("pocket-mod: mounting surface '{name}': {e}"))
    }

    /// Evaluate a product bundle (an iife script, the PocketJS build output)
    /// as a global script. Exceptions come back as errors with the JS stack.
    pub fn eval(&self, label: &str, source: &str) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            ctx.eval::<(), _>(source.as_bytes())
                .catch(&ctx)
                .map_err(|e| anyhow!("pocket-mod: eval '{label}' failed: {e}"))?;
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// One guest turn at a centered analog nub — hosts without a stick call
    /// this and the guest sees `spec::ANALOG_CENTER`, so pre-analog tapes
    /// and goldens hold.
    pub fn frame(&self, buttons: u32) -> Result<()> {
        self.frame_with_analog(buttons, pocketjs_core::spec::ANALOG_CENTER)
    }

    /// One guest turn: call `globalThis.frame(buttons, analog)` if the
    /// bundle installed it, then drain the job queue. `analog` packs the nub
    /// as (x << 8) | y, each axis 0..255 with 128 = center. Call exactly
    /// once per fixed-step tick.
    pub fn frame_with_analog(&self, buttons: u32, analog: u32) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            let frame: Option<Function> = ctx.globals().get("frame").ok();
            if let Some(frame) = frame {
                frame
                    .call::<_, ()>((buttons, analog))
                    .catch(&ctx)
                    .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
            }
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// One guest turn with touch contacts. `touches` packs each contact as
    /// `(id << 18) | (y << 9) | x` (framework/src/touch.ts): 9 bits per axis
    /// (so logical coordinates must be ≤ 511), 8 bits of id, up to 8 contacts.
    /// A contact present in the array is down/move this frame; absent = released.
    /// Hosts without touch call [`Guest::frame`] / [`Guest::frame_with_analog`]
    /// instead; this is the 3-arg `globalThis.frame(buttons, analog, touches)`
    /// path for touch targets (Vita, PocketBook).
    pub fn frame_with_touches(&self, buttons: u32, analog: u32, touches: &[u32]) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            let frame: Option<Function> = ctx.globals().get("frame").ok();
            if let Some(frame) = frame {
                let arr = rquickjs::Array::new(ctx.clone())
                    .map_err(|e| anyhow!("pocket-mod: allocating touch array: {e}"))?;
                for (i, t) in touches.iter().enumerate() {
                    arr.set(i, *t)
                        .map_err(|e| anyhow!("pocket-mod: setting touch {i}: {e}"))?;
                }
                frame
                    .call::<_, ()>((buttons, analog, arr))
                    .catch(&ctx)
                    .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
            }
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// One guest turn with the versioned frame-input extension. Pointer
    /// events are ordered edges, so `[Down, Up]` in one slice preserves a
    /// complete fast click. Leave and Cancel are explicit and never inferred
    /// from a missing sampled level.
    pub fn frame_with_input(
        &self,
        buttons: u32,
        analog: u32,
        touches: &[u32],
        touch_hits: &[u32],
        input: &FrameInput<'_>,
    ) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            let frame: Option<Function> = ctx.globals().get("frame").ok();
            if let Some(frame) = frame {
                let touch_arr = rquickjs::Array::new(ctx.clone())
                    .map_err(|e| anyhow!("pocket-mod: allocating touch array: {e}"))?;
                for (i, value) in touches.iter().enumerate() {
                    touch_arr
                        .set(i, *value)
                        .map_err(|e| anyhow!("pocket-mod: setting touch {i}: {e}"))?;
                }
                let hit_arr = rquickjs::Array::new(ctx.clone())
                    .map_err(|e| anyhow!("pocket-mod: allocating touch-hit array: {e}"))?;
                for (i, value) in touch_hits.iter().enumerate() {
                    hit_arr
                        .set(i, *value)
                        .map_err(|e| anyhow!("pocket-mod: setting touch hit {i}: {e}"))?;
                }
                let payload = Object::new(ctx.clone())
                    .map_err(|e| anyhow!("pocket-mod: allocating frame input: {e}"))?;
                payload
                    .set("v", 1u8)
                    .map_err(|e| anyhow!("pocket-mod: setting frame input version: {e}"))?;
                let pointer = rquickjs::Array::new(ctx.clone())
                    .map_err(|e| anyhow!("pocket-mod: allocating pointer batch: {e}"))?;
                for (i, event) in input.pointer.iter().enumerate() {
                    let raw = rquickjs::Array::new(ctx.clone())
                        .map_err(|e| anyhow!("pocket-mod: allocating pointer event {i}: {e}"))?;
                    raw.set(0, event.kind as u8)
                        .map_err(|e| anyhow!("pocket-mod: setting pointer kind {i}: {e}"))?;
                    if !matches!(
                        event.kind,
                        PointerEventKind::Leave | PointerEventKind::Cancel
                    ) {
                        raw.set(1, event.x)
                            .map_err(|e| anyhow!("pocket-mod: setting pointer x {i}: {e}"))?;
                        raw.set(2, event.y)
                            .map_err(|e| anyhow!("pocket-mod: setting pointer y {i}: {e}"))?;
                        raw.set(3, event.button)
                            .map_err(|e| anyhow!("pocket-mod: setting pointer button {i}: {e}"))?;
                        raw.set(4, event.modifiers).map_err(|e| {
                            anyhow!("pocket-mod: setting pointer modifiers {i}: {e}")
                        })?;
                    }
                    pointer
                        .set(i, raw)
                        .map_err(|e| anyhow!("pocket-mod: setting pointer event {i}: {e}"))?;
                }
                payload
                    .set("pointer", pointer)
                    .map_err(|e| anyhow!("pocket-mod: setting pointer batch: {e}"))?;
                frame
                    .call::<_, ()>((buttons, analog, touch_arr, hit_arr, payload))
                    .catch(&ctx)
                    .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
            }
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// Drain the microtask/job queue (promise reactions). Job exceptions are
    /// logged, not fatal — matching how hosts treat stray rejections.
    pub fn drain_jobs(&self) {
        loop {
            match self.rt.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => {
                    log::error!(target: "guest", "pocket-mod: pending job threw: {e:?}");
                }
            }
        }
    }

    /// Whether the evaluated bundle installed `globalThis.frame`.
    pub fn has_frame(&self) -> bool {
        self.ctx
            .with(|ctx| ctx.globals().get::<_, Function>("frame").is_ok())
    }
}

/// `console.log/info/warn/error/debug` → the host's `log` crate, target
/// "guest". Arguments are stringified and space-joined, browser-style.
fn install_console(ctx: &Ctx) -> rquickjs::Result<()> {
    let console = Object::new(ctx.clone())?;

    fn join(args: rquickjs::function::Rest<rquickjs::Value>) -> String {
        let mut out = String::new();
        for (i, v) in args.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            match stringify(v) {
                Some(s) => out.push_str(&s),
                None => out.push_str("<value>"),
            }
        }
        out
    }

    fn stringify(v: &rquickjs::Value) -> Option<String> {
        if let Some(s) = v.as_string() {
            return s.to_string().ok();
        }
        // Round-trip through the engine's own coercion for everything else.
        let ctx = v.ctx();
        let global = ctx.globals();
        let to_str: Function = global.get("String").ok()?;
        to_str.call::<_, String>((v.clone(),)).ok()
    }

    console.set(
        "log",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::info!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "info",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::info!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "debug",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::debug!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "warn",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::warn!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "error",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::error!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    ctx.globals().set("console", console)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eval_and_frame_turn() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.n = 0; globalThis.frame = (b) => { globalThis.n += b; };",
        )
        .unwrap();
        assert!(g.has_frame());
        g.frame(3).unwrap();
        g.frame(4).unwrap();
        let n: i32 = g.with(|ctx| ctx.globals().get("n").unwrap());
        assert_eq!(n, 7);
    }

    #[test]
    fn mounted_surface_ops_are_callable() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let hits = Rc::new(RefCell::new(Vec::<i32>::new()));
        let g = Guest::new().unwrap();
        let h = hits.clone();
        g.mount("demo", |ctx, ns| {
            let h = h.clone();
            ns.set(
                "poke",
                Function::new(ctx.clone(), move |v: i32| {
                    h.borrow_mut().push(v);
                    v * 2
                })?,
            )?;
            Ok(())
        })
        .unwrap();
        g.eval("boot", "globalThis.out = demo.poke(21);").unwrap();
        let out: i32 = g.with(|ctx| ctx.globals().get("out").unwrap());
        assert_eq!(out, 42);
        assert_eq!(*hits.borrow(), vec![21]);
    }

    #[test]
    fn frame_passes_analog_and_defaults_to_center() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.a = -1; globalThis.frame = (b, analog) => { globalThis.a = analog; };",
        )
        .unwrap();
        g.frame_with_analog(0, 0x20e0).unwrap();
        let a: u32 = g.with(|ctx| ctx.globals().get("a").unwrap());
        assert_eq!(a, 0x20e0);
        g.frame(0).unwrap();
        let a: u32 = g.with(|ctx| ctx.globals().get("a").unwrap());
        assert_eq!(a, pocketjs_core::spec::ANALOG_CENTER);
    }

    #[test]
    fn frame_carries_packed_touches() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.res = ''; \
             globalThis.frame = (b, a, t) => { \
               globalThis.res = b + ':' + (t ? t.length : 0) + ':' + (t && t[0] !== undefined ? t[0] : -1); \
             };",
        )
        .unwrap();
        // (id<<18)|(y<<9)|x — contact id 0 at logical (10, 20):
        let packed = (20u32 << 9) | 10;
        g.frame_with_touches(5, pocketjs_core::spec::ANALOG_CENTER, &[packed])
            .unwrap();
        let res: String = g.with(|ctx| ctx.globals().get("res").unwrap());
        assert_eq!(res, format!("5:1:{packed}"));
        // No contacts → empty array, frame still turns.
        g.frame_with_touches(0, pocketjs_core::spec::ANALOG_CENTER, &[])
            .unwrap();
        let res: String = g.with(|ctx| ctx.globals().get("res").unwrap());
        assert_eq!(res, "0:0:-1");
    }

    #[test]
    fn frame_carries_ordered_full_resolution_pointer_edges() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.res = ''; \
             globalThis.frame = (_b, _a, _t, _h, input) => { \
               globalThis.res = input.v + ':' + input.pointer.map(e => e.join(',')).join('|'); \
             };",
        )
        .unwrap();
        let events = [
            PointerEvent {
                kind: PointerEventKind::Down,
                x: 4095.5,
                y: 3071.25,
                button: 0,
                modifiers: 1,
            },
            PointerEvent::at(PointerEventKind::Up, 4095.5, 3071.25),
            PointerEvent::boundary(PointerEventKind::Cancel),
        ];
        g.frame_with_input(
            0,
            pocketjs_core::spec::ANALOG_CENTER,
            &[],
            &[],
            &FrameInput { pointer: &events },
        )
        .unwrap();
        let res: String = g.with(|ctx| ctx.globals().get("res").unwrap());
        assert_eq!(res, "1:1,4095.5,3071.25,0,1|2,4095.5,3071.25,0,0|4");
    }

    #[test]
    fn exceptions_carry_js_stack() {
        let g = Guest::new().unwrap();
        let err = g.eval(
            "boom",
            "function inner(){ throw new Error('kaboom'); } inner();",
        );
        let msg = format!("{:#}", err.unwrap_err());
        assert!(msg.contains("kaboom"), "got: {msg}");
    }

    #[test]
    fn microtasks_drain_within_the_turn() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.v = 0; globalThis.frame = () => { Promise.resolve().then(() => { globalThis.v = 1; }); };",
        )
        .unwrap();
        g.frame(0).unwrap();
        let v: i32 = g.with(|ctx| ctx.globals().get("v").unwrap());
        assert_eq!(v, 1);
    }
}
