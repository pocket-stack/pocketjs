use vitasdk_sys::{SceTouchPanelInfo, SceTouchReport};

pub const MAX_TOUCHES: usize = 8;

#[derive(Clone, Copy, Debug)]
pub struct TouchPanel {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
}

impl Default for TouchPanel {
    fn default() -> Self {
        // Documented Vita front-panel display coordinates. Real hardware and
        // Vita3K normally provide the same values through GetPanelInfo.
        Self {
            min_x: 0,
            min_y: 0,
            max_x: 1919,
            max_y: 1087,
        }
    }
}

impl TouchPanel {
    pub fn from_info(info: SceTouchPanelInfo) -> Self {
        let panel = Self {
            min_x: info.minDispX as i32,
            min_y: info.minDispY as i32,
            max_x: info.maxDispX as i32,
            max_y: info.maxDispY as i32,
        };
        if panel.max_x > panel.min_x && panel.max_y > panel.min_y {
            panel
        } else {
            Self::default()
        }
    }

    fn logical_axis(raw: i16, min: i32, max: i32, logical: i32) -> u32 {
        if logical <= 1 || max <= min {
            return 0;
        }
        let span = max - min;
        let offset = (raw as i32).clamp(min, max) - min;
        ((offset * (logical - 1) + span / 2) / span) as u32
    }

    pub fn pack(self, report: SceTouchReport, logical_w: i32, logical_h: i32) -> u32 {
        let x = Self::logical_axis(report.x, self.min_x, self.max_x, logical_w) & 0x1ff;
        let y = Self::logical_axis(report.y, self.min_y, self.max_y, logical_h) & 0x1ff;
        ((report.id as u32) << 18) | (y << 9) | x
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TouchSnapshot {
    packed: [u32; MAX_TOUCHES],
    len: usize,
}

impl TouchSnapshot {
    pub const EMPTY: Self = Self {
        packed: [0; MAX_TOUCHES],
        len: 0,
    };

    pub fn from_reports(panel: TouchPanel, reports: &[SceTouchReport]) -> Self {
        let mut snapshot = Self::EMPTY;
        snapshot.len = reports.len().min(MAX_TOUCHES);
        for (index, report) in reports.iter().take(snapshot.len).enumerate() {
            snapshot.packed[index] = panel.pack(
                *report,
                crate::graphics::LOGICAL_W,
                crate::graphics::LOGICAL_H,
            );
        }
        snapshot
    }

    pub fn packed(&self) -> &[u32] {
        &self.packed[..self.len]
    }
}

#[cfg(test)]
mod tests {
    use super::TouchPanel;
    use vitasdk_sys::{SceTouchPanelInfo, SceTouchReport};

    fn panel_info() -> SceTouchPanelInfo {
        let mut info: SceTouchPanelInfo = unsafe { core::mem::zeroed() };
        info.minDispX = 0;
        info.minDispY = 0;
        info.maxDispX = 1919;
        info.maxDispY = 1087;
        info
    }

    fn report(id: u8, x: i16, y: i16) -> SceTouchReport {
        let mut report: SceTouchReport = unsafe { core::mem::zeroed() };
        report.id = id;
        report.x = x;
        report.y = y;
        report
    }

    #[test]
    fn maps_panel_endpoints_to_logical_viewport() {
        let panel = TouchPanel::from_info(panel_info());
        let top_left = panel.pack(report(7, 0, 0), 480, 272);
        let bottom_right = panel.pack(report(9, 1919, 1087), 480, 272);
        assert_eq!(top_left & 0x1ff, 0);
        assert_eq!((top_left >> 9) & 0x1ff, 0);
        assert_eq!(top_left >> 18, 7);
        assert_eq!(bottom_right & 0x1ff, 479);
        assert_eq!((bottom_right >> 9) & 0x1ff, 271);
        assert_eq!(bottom_right >> 18, 9);
    }

    #[test]
    fn clamps_reports_outside_the_display_area() {
        let panel = TouchPanel::from_info(panel_info());
        let packed = panel.pack(report(1, -200, 2000), 480, 272);
        assert_eq!(packed & 0x1ff, 0);
        assert_eq!((packed >> 9) & 0x1ff, 271);
    }
}
