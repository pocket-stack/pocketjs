//! Normalize the physical nub before applying the shared runtime deadzone.
//! Rest the nub at launch, or hold SELECT to repeat the bounded calibration.
pub struct Analog {
    center: [u8; 2],
    low: [u8; 2],
    high: [u8; 2],
    count: u8,
    attempts: u8,
    done: bool,
    reset_held: bool,
}
impl Analog {
    pub const fn new() -> Self {
        Self {
            center: [128; 2],
            low: [255; 2],
            high: [0; 2],
            count: 0,
            attempts: 0,
            done: false,
            reset_held: false,
        }
    }
    pub fn sample(&mut self, x: u8, y: u8, recenter: bool, buttons: u32) -> u16 {
        if recenter && !self.reset_held {
            *self = Self::new();
        }
        self.reset_held = recenter;
        if !self.done {
            self.attempts = self.attempts.saturating_add(1);
            let values = [x, y];
            if buttons == 0 && values.iter().all(|&v| (80..=176).contains(&v)) {
                for i in 0..2 {
                    self.low[i] = self.low[i].min(values[i]);
                    self.high[i] = self.high[i].max(values[i]);
                }
                if (0..2).any(|i| self.high[i] - self.low[i] > 6) {
                    self.low = values;
                    self.high = values;
                    self.count = 0;
                }
                self.count += 1;
                if self.count >= 16 {
                    for i in 0..2 {
                        self.center[i] = ((self.low[i] as u16 + self.high[i] as u16) / 2) as u8;
                    }
                    self.done = true;
                }
            } else {
                self.count = 0;
                self.low = [255; 2];
                self.high = [0; 2];
            }
            if self.attempts >= 40 {
                self.done = true;
            }
            return 0x8080;
        }
        let axis = |v: u8, c: u8| -> u16 {
            if v < c {
                v as u16 * 128 / c as u16
            } else {
                128 + (v - c) as u16 * 127 / (255 - c) as u16
            }
        };
        (axis(x, self.center[0]) << 8) | axis(y, self.center[1])
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn biased_rest_and_full_travel() {
        let mut a = Analog::new();
        for _ in 0..16 {
            assert_eq!(a.sample(162, 133, false, 0), 0x8080);
        }
        assert_eq!(a.sample(162, 133, false, 0), 0x8080);
        assert_eq!(a.sample(255, 0, false, 0), 0xff00);
        assert_eq!(a.sample(0, 255, false, 0), 0x00ff);
    }
    #[test]
    fn held_stick_does_not_calibrate_to_an_endpoint() {
        let mut a = Analog::new();
        for _ in 0..40 {
            a.sample(255, 128, false, 0);
        }
        assert_eq!(a.sample(255, 128, false, 0), 0xff80);
    }
    #[test]
    fn explicit_recenter_is_edge_triggered() {
        let mut a = Analog::new();
        for _ in 0..40 {
            a.sample(128, 128, false, 0);
        }
        for _ in 0..20 {
            a.sample(151, 130, true, 0);
        }
        assert_eq!(a.sample(151, 130, false, 0), 0x8080);
    }
}
