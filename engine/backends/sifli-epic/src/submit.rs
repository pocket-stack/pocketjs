//! The executor contract: bind a target once, submit commands in order.
//!
//! An executor may keep commands in flight after `submit` returns. Portable
//! texture bytes referenced by a command and the executor's own mask planes
//! stay valid until the next [`Frame::fence`] or [`Frame::finish`]; the
//! renderer fences before it reads or writes anything those commands touch.

use crate::caps::Capabilities;
use crate::cmd::{Cmd, MaskId, TileId};

/// Why a command batch could not be run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitError {
    /// The command at `index` was not admitted by this executor although the
    /// planner believed the capabilities allowed it.
    Unsupported { index: usize },
    /// The executor failed (driver error); the frame must be abandoned.
    Failed,
}

/// What kind of buffer the frame renders into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    /// A persistent framebuffer that may be scanned out.
    Framebuffer,
    /// A CPU-owned compact strip; direct CPU writes are always allowed.
    Strip,
}

/// A hardware executor. Rendering is generic over this trait.
pub trait Submit {
    /// Executor bound to one target for one frame.
    type Frame<'f>: Frame
    where
        Self: 'f;

    /// What the planner may issue.
    fn caps(&self) -> &Capabilities;

    /// Bind `target` (`width * height` RGB565 pixels) for one frame or strip.
    fn begin<'f>(
        &'f mut self,
        target: &'f mut [u16],
        width: u32,
        height: u32,
        kind: TargetKind,
    ) -> Result<Self::Frame<'f>, SubmitError>;
}

/// One bound target.
pub trait Frame {
    /// Native copy the executor keeps for a core texture, if any.
    fn native_texture(&mut self, _handle: i32, _revision: u64) -> Option<u32> {
        None
    }

    /// Run `cmds` in order after every earlier command.
    fn submit(&mut self, cmds: &[Cmd<'_>]) -> Result<(), SubmitError>;

    /// Complete every submitted command.
    fn fence(&mut self) -> Result<(), SubmitError>;

    /// The A8 plane `mask`, writable by the CPU: at least
    /// `Capabilities::mask_tile_bytes` bytes, or `width * height` bytes when
    /// that is 0. The renderer fences before rewriting a plane a submitted
    /// `BlendA8` may still be reading.
    fn mask_mut(&mut self, mask: MaskId) -> &mut [u8];

    /// The RGB565 tile `tile`, at least `Capabilities::cpu_tile_pixels`
    /// pixels, writable by the CPU after the `TileOut` that filled it was
    /// fenced.
    fn tile_mut(&mut self, tile: TileId) -> &mut [u16];

    /// The target pixels for direct CPU writes, `None` when the executor
    /// forbids them (RAM-less GPU-only framebuffers). Callers fence first.
    fn target_mut(&mut self) -> Option<&mut [u16]>;

    /// Complete everything and release the target.
    fn finish(self) -> Result<(), SubmitError>;
}
