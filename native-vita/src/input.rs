use vitasdk_sys::{
    sceCtrlPeekBufferPositive, sceCtrlSetSamplingMode, SceCtrlData, SCE_CTRL_MODE_ANALOG,
};

mod pad;

pub use pad::Pad;

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
