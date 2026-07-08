//! pocket-mod — guest hosting for the Pocket runtime family.
//!
//! The mechanism half of the extension architecture (see RUNTIMES.md):
//! a runtime is ⟨Cores, Surfaces, Guest⟩, and this crate owns the **Guest** —
//! one QuickJS realm evaluating one bundled product (an app, a game's mods,
//! or both), plus the plumbing every runtime shares:
//!
//!   - realm lifecycle: create, mount surfaces, eval the bundle;
//!   - surface mounting: a named namespace object on `globalThis`
//!     (`ui`, `strike`, …) populated with native op functions;
//!   - the guest turn: `frame(buttons)` once per fixed-step tick, then the
//!     job queue drains (Law 3: one guest turn per host tick — the guest
//!     never owns a timer or a thread);
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

    /// One guest turn: call `globalThis.frame(buttons)` if the bundle
    /// installed it, then drain the job queue. Call exactly once per
    /// fixed-step tick.
    pub fn frame(&self, buttons: u32) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            let frame: Option<Function> = ctx.globals().get("frame").ok();
            if let Some(frame) = frame {
                frame
                    .call::<_, ()>((buttons,))
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
