use vitasdk_sys::{
    sceCtrlPeekBufferPositive, sceCtrlSetSamplingMode, SceCtrlData, SCE_CTRL_MODE_ANALOG,
};

#[derive(Clone, Copy, Debug, Default)]
pub struct Pad {
    pub buttons: u32,
    pub lx: u8,
    pub ly: u8,
    pub rx: u8,
    pub ry: u8,
}

impl Pad {
    /// PocketJS's established left-stick packing used by external apps.
    #[inline]
    pub fn left_analog(self) -> i32 {
        ((self.lx as i32) << 8) | self.ly as i32
    }
}

pub fn init() {
    unsafe {
        sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);
    }
}

pub fn read() -> Pad {
    unsafe {
        let mut raw: SceCtrlData = core::mem::zeroed();
        sceCtrlPeekBufferPositive(0, &mut raw, 1);
        Pad {
            buttons: raw.buttons,
            lx: raw.lx,
            ly: raw.ly,
            rx: raw.rx,
            ry: raw.ry,
        }
    }
}
