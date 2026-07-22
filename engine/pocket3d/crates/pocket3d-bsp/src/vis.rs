//! BSP visibility: point→leaf lookup, PVS (potentially visible set) row
//! decoding, frustum culling, and per-frame visible-face gathering.
//!
//! Renderer-agnostic and no_std: the wgpu and sceGu backends both consume
//! the face set this module emits. The PSP depends on it — drawing all of
//! dust2 every frame is several times over its fill budget — and desktop
//! backends can adopt it for the same overdraw win.

use alloc::vec;
use alloc::vec::Vec;

use glam::{Mat4, Vec3, Vec4};

use crate::types::{CONTENTS_SOLID, Leaf, Node, Plane};

/// The render-BSP data visibility works over (worldspawn tree, headnode 0).
/// Leaf 0 is the solid "outside" leaf; PVS bit `i` refers to leaf `i + 1`.
pub struct VisData {
    pub nodes: Vec<Node>,
    pub leaves: Vec<Leaf>,
    /// Concatenated per-leaf face lists (BSP face indices).
    pub marksurfaces: Vec<u16>,
    /// RLE-compressed PVS rows, indexed by `Leaf::vis_offset`.
    pub visibility: Vec<u8>,
    /// Worldspawn visleaf count (= PVS row bit count).
    pub num_visleaves: usize,
}

impl VisData {
    #[cfg(feature = "std")]
    pub fn from_bsp(bsp: &crate::raw::RawBsp) -> Self {
        Self {
            nodes: bsp.nodes.clone(),
            leaves: bsp.leaves.clone(),
            marksurfaces: bsp.marksurfaces.clone(),
            visibility: bsp.visibility.clone(),
            num_visleaves: bsp.models.first().map(|m| m.visleafs).unwrap_or(0),
        }
    }

    /// Leaf index containing `p`. Walks the render BSP from node 0; the
    /// planes slice is the map's shared plane table.
    pub fn leaf_at(&self, planes: &[Plane], p: Vec3) -> usize {
        if self.nodes.is_empty() {
            return 0;
        }
        let mut num: i16 = 0;
        loop {
            let node = &self.nodes[num as usize];
            let pl = &planes[node.plane as usize];
            let d = pl.normal.dot(p) - pl.dist;
            let child = node.children[usize::from(d < 0.0)];
            if child < 0 {
                return (-1 - child as i32) as usize;
            }
            num = child;
        }
    }

    /// Decompress the PVS row for `leaf` into `row` (a bitset over leaves
    /// `1..=num_visleaves`; bit `i` = leaf `i + 1` visible). Returns false
    /// when the leaf has no vis info (treat everything as visible).
    pub fn decode_row(&self, leaf: usize, row: &mut [u8]) -> bool {
        let Some(l) = self.leaves.get(leaf) else {
            return false;
        };
        if leaf == 0 || l.vis_offset < 0 {
            return false;
        }
        let Some(mut src) = self.visibility.get(l.vis_offset as usize..) else {
            return false;
        };
        row.fill(0);
        let row_bytes = self.num_visleaves.div_ceil(8).min(row.len());
        let mut out = 0usize;
        while out < row_bytes {
            let Some((&b, rest)) = src.split_first() else {
                break;
            };
            src = rest;
            if b != 0 {
                row[out] = b;
                out += 1;
            } else {
                // A zero byte is followed by a zero-run count.
                let Some((&count, rest)) = src.split_first() else {
                    break;
                };
                src = rest;
                out += (count as usize).max(1);
            }
        }
        true
    }

    /// Bytes needed for one decompressed PVS row.
    pub fn row_bytes(&self) -> usize {
        self.num_visleaves.div_ceil(8)
    }
}

/// A view frustum as clip planes; points with a negative signed distance to
/// any plane are outside.
#[derive(Clone, Copy, Debug)]
pub struct Frustum {
    planes: [Vec4; 6],
    count: usize,
}

impl Frustum {
    /// Extract frustum planes from a clip-from-world matrix (Gribb-Hartmann).
    /// `zero_to_one_depth` selects the near-plane convention: true for
    /// wgpu/DirectX (z in 0..1), false for GL-style (z in -1..1).
    pub fn from_clip(m: Mat4, zero_to_one_depth: bool) -> Self {
        let r0 = m.row(0);
        let r1 = m.row(1);
        let r2 = m.row(2);
        let r3 = m.row(3);
        let near = if zero_to_one_depth { r2 } else { r3 + r2 };
        Self {
            planes: [r3 + r0, r3 - r0, r3 + r1, r3 - r1, near, r3 - r2],
            count: 6,
        }
    }

    /// True when the AABB is at least partially inside the frustum
    /// (conservative: may return true for near-miss corners).
    pub fn intersects_aabb(&self, mins: Vec3, maxs: Vec3) -> bool {
        for plane in &self.planes[..self.count] {
            // Most-positive vertex for this plane's normal.
            let p = Vec3::new(
                if plane.x >= 0.0 { maxs.x } else { mins.x },
                if plane.y >= 0.0 { maxs.y } else { mins.y },
                if plane.z >= 0.0 { maxs.z } else { mins.z },
            );
            if plane.dot(p.extend(1.0)) < 0.0 {
                return false;
            }
        }
        true
    }
}

/// Per-frame visibility scratch: caches the decoded PVS row for the current
/// camera leaf and de-duplicates faces shared between leaves.
pub struct VisSet {
    leaf: usize,
    row: Vec<u8>,
    /// True when the camera has no vis info (solid/outside leaf): draw all.
    all_visible: bool,
    face_stamp: Vec<u32>,
    stamp: u32,
}

impl VisSet {
    pub fn new(face_count: usize) -> Self {
        Self {
            leaf: usize::MAX,
            row: Vec::new(),
            all_visible: true,
            face_stamp: vec![0; face_count],
            stamp: 0,
        }
    }

    /// Re-resolve the camera leaf; decodes the PVS row only when the leaf
    /// changed. Returns true when the visible-leaf set changed.
    pub fn update(&mut self, vis: &VisData, planes: &[Plane], cam: Vec3) -> bool {
        let leaf = vis.leaf_at(planes, cam);
        if leaf == self.leaf {
            return false;
        }
        self.leaf = leaf;
        if self.row.len() < vis.row_bytes() {
            self.row = vec![0; vis.row_bytes()];
        }
        self.all_visible = !vis.decode_row(leaf, &mut self.row);
        true
    }

    pub fn leaf(&self) -> usize {
        self.leaf
    }

    /// Whether leaf `i` (1-based) is in the current PVS.
    #[inline]
    pub fn leaf_visible(&self, i: usize) -> bool {
        if self.all_visible {
            return true;
        }
        let bit = i - 1;
        self.row
            .get(bit >> 3)
            .is_some_and(|b| b & (1 << (bit & 7)) != 0)
    }

    /// Emit every face in a PVS-visible, frustum-intersecting leaf, exactly
    /// once per call (faces shared between leaves are de-duplicated).
    pub fn gather_faces(&mut self, vis: &VisData, frustum: &Frustum, mut emit: impl FnMut(u16)) {
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.face_stamp.fill(0);
            self.stamp = 1;
        }
        let last = vis.num_visleaves.min(vis.leaves.len().saturating_sub(1));
        for i in 1..=last {
            if !self.leaf_visible(i) {
                continue;
            }
            let leaf = &vis.leaves[i];
            if leaf.contents == CONTENTS_SOLID {
                continue;
            }
            if !frustum.intersects_aabb(leaf.mins, leaf.maxs) {
                continue;
            }
            let first = leaf.first_marksurface as usize;
            let n = leaf.num_marksurfaces as usize;
            for k in first..(first + n).min(vis.marksurfaces.len()) {
                let face = vis.marksurfaces[k];
                let slot = &mut self.face_stamp[face as usize];
                if *slot != self.stamp {
                    *slot = self.stamp;
                    emit(face);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_rle_row() {
        // Two leaves' worth of vis: literal 0b101, then a run of 2 zero
        // bytes, then literal 0xff.
        let vis = VisData {
            nodes: Vec::new(),
            leaves: vec![
                Leaf {
                    contents: CONTENTS_SOLID,
                    vis_offset: -1,
                    mins: Vec3::ZERO,
                    maxs: Vec3::ZERO,
                    first_marksurface: 0,
                    num_marksurfaces: 0,
                },
                Leaf {
                    contents: -1,
                    vis_offset: 0,
                    mins: Vec3::ZERO,
                    maxs: Vec3::ZERO,
                    first_marksurface: 0,
                    num_marksurfaces: 0,
                },
            ],
            marksurfaces: Vec::new(),
            visibility: vec![0b101, 0, 2, 0xff],
            num_visleaves: 32,
        };
        let mut row = vec![0u8; vis.row_bytes()];
        assert!(vis.decode_row(1, &mut row));
        assert_eq!(row, vec![0b101, 0, 0, 0xff]);
        // Leaf 0 / missing offsets decode as "no info".
        assert!(!vis.decode_row(0, &mut row));
    }

    #[test]
    fn frustum_aabb() {
        // Simple perspective looking down -Z from origin (GL convention).
        let proj = Mat4::perspective_rh_gl(1.0, 1.0, 1.0, 100.0);
        let f = Frustum::from_clip(proj, false);
        assert!(f.intersects_aabb(Vec3::new(-1.0, -1.0, -10.0), Vec3::new(1.0, 1.0, -5.0)));
        assert!(!f.intersects_aabb(Vec3::new(-1.0, -1.0, 5.0), Vec3::new(1.0, 1.0, 10.0)));
        assert!(!f.intersects_aabb(Vec3::new(200.0, 0.0, -10.0), Vec3::new(210.0, 1.0, -5.0)));
    }
}
