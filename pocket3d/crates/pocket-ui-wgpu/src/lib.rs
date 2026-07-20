//! pocket-ui-wgpu — the PocketJS `ui` surface on the native desktop base.
//!
//! The desktop edition of the 2D UI runtime's native half (RUNTIMES.md):
//! it owns a [`pocketjs_core::Ui`] core, feeds it app paks (styles, font
//! atlases, images, sprites — same walk as the PSP's `native/src/pak.rs`),
//! mounts the `ui.*` HostOps surface into a [`pocket_mod::Guest`], and
//! renders the core's DrawList through wgpu into any render target:
//!
//!   - a window at PSP resolution → the existing PocketJS demos run natively
//!     on macOS (see `examples/uihost`);
//!   - an overlay pass over a 3D scene → a game HUD that is a full PocketJS
//!     app (OpenStrike).
//!
//! 2D and 3D share one base: the same `pocket3d::Gpu` device drives both.

mod blit;
mod dbg;
mod pak;
mod render;
mod surface;

pub use blit::Blit;
pub use pak::{PakEntry, walk_pak};
pub use render::{SceneQuad, UiRenderer, scene_quads};
pub use surface::UiSurface;
