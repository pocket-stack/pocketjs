//! Collision interface + Quake-style character controller — re-exported
//! from `pocket3d_bsp::collide`, where the implementation lives so the PSP
//! runtime (no_std) runs the exact same movement source as the desktop.

pub use pocket3d_bsp::collide::*;
