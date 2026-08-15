//! Small seeded generator used only for deterministic world variation.

use serde::{Deserialize, Serialize};

/// xorshift64* with an explicit serializable state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldRng {
    state: u64,
}

impl WorldRng {
    pub fn new(seed: u64) -> Self {
        // The all-zero state is absorbing. Fold it onto a fixed odd value.
        Self {
            state: if seed == 0 {
                0x9e37_79b9_7f4a_7c15
            } else {
                seed
            },
        }
    }

    pub fn state(&self) -> u64 {
        self.state
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// A finite value in `[0, 1)` using the upper 24 random bits.
    pub fn next_f32(&mut self) -> f32 {
        ((self.next_u64() >> 40) as u32) as f32 / (1_u32 << 24) as f32
    }

    pub fn signed_f32(&mut self) -> f32 {
        self.next_f32() * 2.0 - 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_replays_exactly_and_zero_is_not_absorbing() {
        let mut a = WorldRng::new(0);
        let mut b = WorldRng::new(0);
        let values_a: Vec<_> = (0..16).map(|_| a.next_u64()).collect();
        let values_b: Vec<_> = (0..16).map(|_| b.next_u64()).collect();
        assert_eq!(values_a, values_b);
        assert!(values_a.iter().any(|&value| value != 0));
    }
}
