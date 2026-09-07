//! Prepared 2D geometry. No topology, codecs or unbounded inputs in the guest.
use alloc::vec::Vec;
pub const MAX_VERTICES: usize = 4096;
pub const MAX_TRIANGLES: usize = 2048;
pub const MAX_BYTES: usize = 16 + MAX_VERTICES * 4 + MAX_TRIANGLES * 10;
#[derive(Clone, Copy)]
#[repr(C)]
pub struct Triangle {
    pub indices: [u16; 3],
    pub color: u32,
}
pub struct Mesh {
    pub width: u16,
    pub height: u16,
    pub vertices: Vec<[u16; 2]>,
    pub triangles: Vec<Triangle>,
}
fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}
impl Mesh {
    pub fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < 16 || b.len() > MAX_BYTES || &b[..4] != b"PMH1" || u32_at(b, 12) != 0 {
            return None;
        }
        let (width, height) = (u16_at(b, 4), u16_at(b, 6));
        let (nv, nt) = (u16_at(b, 8) as usize, u16_at(b, 10) as usize);
        if width == 0
            || height == 0
            || width > 4095
            || height > 4095
            || nv > MAX_VERTICES
            || nt > MAX_TRIANGLES
            || b.len() != 16 + nv * 4 + nt * 10
        {
            return None;
        }
        // Validate before allocating; malformed geometry never acquires residency.
        for i in 0..nv {
            if u16_at(b, 16 + i * 4) > width * 16 || u16_at(b, 18 + i * 4) > height * 16 {
                return None;
            }
        }
        for i in 0..nt {
            for j in 0..3 {
                if u16_at(b, 16 + nv * 4 + i * 10 + j * 2) as usize >= nv {
                    return None;
                }
            }
        }
        let vertices = (0..nv)
            .map(|i| [u16_at(b, 16 + i * 4), u16_at(b, 18 + i * 4)])
            .collect();
        let triangles = (0..nt)
            .map(|i| {
                let p = 16 + nv * 4 + i * 10;
                Triangle {
                    indices: [u16_at(b, p), u16_at(b, p + 2), u16_at(b, p + 4)],
                    color: u32_at(b, p + 6),
                }
            })
            .collect();
        Some(Self {
            width,
            height,
            vertices,
            triangles,
        })
    }
}
struct Slot {
    generation: u32,
    value: Option<Mesh>,
}
pub struct Meshes {
    slots: Vec<Slot>,
}
impl Meshes {
    pub fn new() -> Self {
        Self { slots: Vec::new() }
    }
    pub fn get(&self, handle: i32) -> Option<&Mesh> {
        if handle < 0 {
            return None;
        }
        let s = self.slots.get(handle as usize & 127)?;
        if s.generation != handle as u32 >> 7 {
            return None;
        }
        s.value.as_ref()
    }
    pub fn upload(&mut self, bytes: &[u8]) -> i32 {
        let Some(value) = Mesh::parse(bytes) else {
            return -1;
        };
        let slot = self
            .slots
            .iter()
            .position(|s| s.value.is_none() && s.generation < 0xffffff)
            .unwrap_or(self.slots.len());
        if slot >= 128 {
            return -1;
        }
        if slot == self.slots.len() {
            self.slots.push(Slot {
                generation: 0,
                value: None,
            });
        }
        let s = &mut self.slots[slot];
        s.value = Some(value);
        ((s.generation << 7) | slot as u32) as i32
    }
    pub fn free(&mut self, handle: i32) {
        if self.get(handle).is_none() {
            return;
        }
        let s = &mut self.slots[handle as usize & 127];
        s.value = None;
        s.generation += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> Vec<u8> {
        let mut b = alloc::vec![0;38];
        b[..4].copy_from_slice(b"PMH1");
        for (p, n) in [
            (4, 256u16),
            (6, 256),
            (8, 3),
            (10, 1),
            (20, 4096),
            (26, 4096),
            (30, 1),
            (32, 2),
        ] {
            b[p..p + 2].copy_from_slice(&n.to_le_bytes());
        }
        b[34..38].copy_from_slice(&0xff112233u32.to_le_bytes());
        b
    }
    #[test]
    fn envelopes_indices_and_generations() {
        let b = entry();
        assert!(Mesh::parse(&b).is_some());
        for length in 0..b.len() {
            assert!(Mesh::parse(&b[..length]).is_none());
        }
        for (at, value) in [(8, 4097u16), (10, 2049), (28, 3), (16, 4097), (4, 0)] {
            let mut bad = b.clone();
            bad[at..at + 2].copy_from_slice(&value.to_le_bytes());
            assert!(Mesh::parse(&bad).is_none());
        }
        let mut pool = Meshes::new();
        let a = pool.upload(&b);
        assert_eq!(a, 0);
        pool.free(a);
        let next = pool.upload(&b);
        assert_ne!(next, a);
        pool.free(a);
        assert!(pool.get(next).is_some());
        assert!(pool.get(a).is_none());
        for _ in 1..128 {
            assert!(pool.upload(&b) >= 0);
        }
        assert_eq!(pool.upload(&b), -1);
    }
}
