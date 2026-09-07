//! Fixed USB mailbox envelopes. No allocator or platform calls.
pub const MAGIC: u32 = 0x31424f50;
pub const HEADER: usize = 64;
pub const JSON_MAX: usize = 4096;
pub const DATA_MAX: usize = 131072;
pub fn word(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
pub fn put(b: &mut [u8], at: usize, value: u32) {
    b[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
pub fn hash(b: &[u8]) -> u32 {
    b.iter()
        .fold(2166136261, |h, v| (h ^ *v as u32).wrapping_mul(16777619))
}
pub fn valid(b: &[u8], epoch: u32, boot: u32, seq: u32) -> bool {
    if b.len() != HEADER
        || word(b, 0) != MAGIC
        || word(b, 4) != epoch
        || word(b, 8) != boot
        || word(b, 12) != seq
    {
        return false;
    }
    let (kind, n, w, h) = (word(b, 16), word(b, 32) as usize, word(b, 24), word(b, 28));
    match kind {
        0 => n > 0 && n <= JSON_MAX,
        1 => n >= 16 && n <= 36880 && w > 0 && w <= 4095 && h > 0 && h <= 4095,
        2 => {
            w >= 16
                && w <= 256
                && h >= 16
                && h <= 256
                && w.is_power_of_two()
                && h.is_power_of_two()
                && n == w as usize * h as usize * 2
        }
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_and_generations() {
        let mut h = [0; HEADER];
        for (p, v) in [
            (0, MAGIC),
            (4, 1),
            (8, 2),
            (12, 3),
            (16, 1),
            (24, 256),
            (28, 256),
            (32, 36880),
        ] {
            put(&mut h, p, v);
        }
        assert!(valid(&h, 1, 2, 3));
        assert!(!valid(&h, 2, 2, 3));
        assert!(!valid(&h, 1, 2, 4));
        put(&mut h, 32, 36881);
        assert!(!valid(&h, 1, 2, 3));
        put(&mut h, 16, 2);
        put(&mut h, 24, 256);
        put(&mut h, 28, 256);
        put(&mut h, 32, 131072);
        assert!(valid(&h, 1, 2, 3));
        put(&mut h, 24, 257);
        assert!(!valid(&h, 1, 2, 3));
        put(&mut h, 16, 0);
        put(&mut h, 32, 4097);
        assert!(!valid(&h, 1, 2, 3));
        assert_eq!(hash(b"hello"), 0x4f9f2cab);
    }
}
