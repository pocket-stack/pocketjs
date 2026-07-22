//! Fixed-timestep accumulator (simulation at a constant rate, rendering as
//! fast as the display goes).

pub struct FixedTimestep {
    pub step: f32,
    accumulator: f32,
    /// Cap on per-frame simulated time (avoids spiral-of-death).
    pub max_frame: f32,
}

impl FixedTimestep {
    pub fn new(hz: f32) -> Self {
        Self {
            step: 1.0 / hz,
            accumulator: 0.0,
            max_frame: 0.25,
        }
    }

    /// Feed real elapsed seconds; returns how many fixed ticks to run.
    pub fn advance(&mut self, real_dt: f32) -> u32 {
        self.accumulator += real_dt.min(self.max_frame);
        let mut ticks = 0;
        while self.accumulator >= self.step {
            self.accumulator -= self.step;
            ticks += 1;
        }
        ticks
    }

    /// Interpolation factor for rendering between ticks (0..1).
    pub fn alpha(&self) -> f32 {
        self.accumulator / self.step
    }
}
