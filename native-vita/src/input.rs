use vitasdk_sys::{
    sceCtrlPeekBufferPositive, sceCtrlSetSamplingMode, sceTouchGetPanelInfo, sceTouchPeek,
    sceTouchSetSamplingState, SceCtrlData, SceTouchData, SceTouchPanelInfo, SCE_CTRL_MODE_ANALOG,
    SCE_TOUCH_PORT_FRONT, SCE_TOUCH_SAMPLING_STATE_START,
};

mod pad;
mod touch;

pub use pad::Pad;
pub use touch::TouchSnapshot;

static mut FRONT_PANEL: TouchPanelState = TouchPanelState::Uninitialized;

#[derive(Clone, Copy)]
enum TouchPanelState {
    Uninitialized,
    Ready(touch::TouchPanel),
}

pub fn init() {
    unsafe {
        sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);
        let _ = sceTouchSetSamplingState(SCE_TOUCH_PORT_FRONT, SCE_TOUCH_SAMPLING_STATE_START);
        let mut info: SceTouchPanelInfo = core::mem::zeroed();
        let panel = if sceTouchGetPanelInfo(SCE_TOUCH_PORT_FRONT, &mut info) >= 0 {
            touch::TouchPanel::from_info(info)
        } else {
            touch::TouchPanel::default()
        };
        FRONT_PANEL = TouchPanelState::Ready(panel);
    }
}

pub fn read_touches() -> TouchSnapshot {
    unsafe {
        let TouchPanelState::Ready(panel) = FRONT_PANEL else {
            return TouchSnapshot::EMPTY;
        };
        let mut data: SceTouchData = core::mem::zeroed();
        if sceTouchPeek(SCE_TOUCH_PORT_FRONT, &mut data, 1) < 0 {
            return TouchSnapshot::EMPTY;
        }
        let count = (data.reportNum as usize).min(data.report.len());
        TouchSnapshot::from_reports(panel, &data.report[..count])
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
