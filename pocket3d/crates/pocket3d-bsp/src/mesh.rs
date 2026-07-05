//! Face geometry -> batched triangle meshes with a packed lightmap atlas.

use glam::Vec3;

use crate::lightmap::{LightmapAtlas, PAGE_SIZE};
use crate::raw::RawBsp;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SurfaceKind {
    Opaque,
    /// `{`-prefixed cutout textures (fences, grates); alpha-tested.
    AlphaTest,
    Water,
    Sky,
}

/// Classification for one texture name.
pub fn classify(name: &str) -> Option<SurfaceKind> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "aaatrigger" | "clip" | "origin" | "hint" | "skip" | "null" | "trigger" => return None,
        _ => {}
    }
    if lower == "sky" {
        return Some(SurfaceKind::Sky);
    }
    if lower.starts_with('{') {
        return Some(SurfaceKind::AlphaTest);
    }
    if lower.starts_with('!') || lower.starts_with("water") || lower.starts_with("laser") {
        return Some(SurfaceKind::Water);
    }
    Some(SurfaceKind::Opaque)
}

#[derive(Clone, Copy)]
pub struct WorldVertexData {
    pub pos: [f32; 3],
    pub uv: [f32; 2],
    pub lm_uv: [f32; 2],
}

pub struct Batch {
    pub texture: usize,
    pub lm_page: usize,
    pub kind: SurfaceKind,
    pub first_index: u32,
    pub index_count: u32,
}

pub struct MapGeometry {
    pub vertices: Vec<WorldVertexData>,
    pub indices: Vec<u32>,
    pub batches: Vec<Batch>,
    pub lightmap_pages: Vec<Vec<u8>>,
    pub stats: GeometryStats,
}

#[derive(Default, Debug)]
pub struct GeometryStats {
    pub faces_drawn: usize,
    pub faces_skipped: usize,
    pub triangles: usize,
}

/// Build render geometry for the given brush models (index + world offset).
pub fn build_geometry(
    bsp: &RawBsp,
    include_models: &[(usize, Vec3)],
    tex_sizes: &[(u32, u32)],
) -> MapGeometry {
    use std::collections::HashMap;

    let mut atlas = LightmapAtlas::new();
    let mut vertices: Vec<WorldVertexData> = Vec::new();
    // (texture, page, kind) -> index list
    let mut buckets: HashMap<(usize, usize, SurfaceKind), Vec<u32>> = HashMap::new();
    let mut stats = GeometryStats::default();

    for &(model_idx, offset) in include_models {
        let Some(model) = bsp.models.get(model_idx) else {
            continue;
        };
        for face_idx in model.first_face..model.first_face + model.num_faces {
            let Some(face) = bsp.faces.get(face_idx) else {
                continue;
            };
            let ti = &bsp.texinfos[face.texinfo as usize];
            let tex_idx = ti.miptex.min(bsp.textures.len().saturating_sub(1));
            let tex_name = &bsp.textures[tex_idx].name;
            let Some(kind) = classify(tex_name) else {
                stats.faces_skipped += 1;
                continue;
            };

            // Polygon positions from the surfedge loop.
            let n = face.num_edges as usize;
            if n < 3 {
                continue;
            }
            let mut poly: Vec<Vec3> = Vec::with_capacity(n);
            for i in 0..n {
                let se = bsp.surfedges[face.first_edge as usize + i];
                let vi = if se >= 0 {
                    bsp.edges[se as usize][0]
                } else {
                    bsp.edges[(-se) as usize][1]
                };
                poly.push(bsp.vertices[vi as usize] + offset);
            }

            let (tw, th) = tex_sizes
                .get(tex_idx)
                .copied()
                .filter(|&(w, h)| w > 0 && h > 0)
                .unwrap_or((64, 64));

            // Texture-space coordinates (pixels).
            let st: Vec<(f32, f32)> = poly
                .iter()
                .map(|&p| (p.dot(ti.s) + ti.s_shift, p.dot(ti.t) + ti.t_shift))
                .collect();

            // Lightmap block placement.
            let (mut lm_alloc_x, mut lm_alloc_y, mut page) = (0.0f32, 0.0f32, 0usize);
            let (mut bmin_s, mut bmin_t) = (0.0f32, 0.0f32);
            let mut has_lightmap = false;
            if kind == SurfaceKind::Opaque || kind == SurfaceKind::AlphaTest {
                let (mut min_s, mut max_s) = (f32::MAX, f32::MIN);
                let (mut min_t, mut max_t) = (f32::MAX, f32::MIN);
                for &(s, t) in &st {
                    min_s = min_s.min(s);
                    max_s = max_s.max(s);
                    min_t = min_t.min(t);
                    max_t = max_t.max(t);
                }
                let bs = (min_s / 16.0).floor();
                let bt = (min_t / 16.0).floor();
                let es = (max_s / 16.0).ceil() - bs;
                let et = (max_t / 16.0).ceil() - bt;
                let w = (es as u32 + 1).clamp(1, 256);
                let h = (et as u32 + 1).clamp(1, 256);
                let samples = (w * h) as usize;
                let lit = face.lightmap_offset >= 0
                    && face.styles[0] != 255
                    && (face.lightmap_offset as usize + samples * 3) <= bsp.lighting.len();
                let data = lit.then(|| {
                    let o = face.lightmap_offset as usize;
                    &bsp.lighting[o..o + samples * 3]
                });
                let alloc = atlas.insert_rgb(w, h, data);
                lm_alloc_x = alloc.x as f32;
                lm_alloc_y = alloc.y as f32;
                page = alloc.page;
                bmin_s = bs;
                bmin_t = bt;
                has_lightmap = true;
            }

            // Emit vertices.
            let base = vertices.len() as u32;
            for (i, &p) in poly.iter().enumerate() {
                let (s, t) = st[i];
                let lm_uv = if has_lightmap {
                    [
                        (lm_alloc_x + (s / 16.0 - bmin_s) + 0.5) / PAGE_SIZE as f32,
                        (lm_alloc_y + (t / 16.0 - bmin_t) + 0.5) / PAGE_SIZE as f32,
                    ]
                } else {
                    [0.0, 0.0]
                };
                vertices.push(WorldVertexData {
                    pos: p.to_array(),
                    uv: [s / tw as f32, t / th as f32],
                    lm_uv,
                });
            }

            // Fan triangulation.
            let bucket = buckets.entry((tex_idx, page, kind)).or_default();
            for i in 1..n as u32 - 1 {
                bucket.extend_from_slice(&[base, base + i, base + i + 1]);
                stats.triangles += 1;
            }
            stats.faces_drawn += 1;
        }
    }

    // Deterministic batch order: opaque, alpha-test, water, sky.
    let mut keys: Vec<_> = buckets.keys().copied().collect();
    keys.sort_by_key(|&(tex, page, kind)| (kind, tex, page));

    let mut indices = Vec::new();
    let mut batches = Vec::new();
    for key in keys {
        let list = &buckets[&key];
        batches.push(Batch {
            texture: key.0,
            lm_page: key.1,
            kind: key.2,
            first_index: indices.len() as u32,
            index_count: list.len() as u32,
        });
        indices.extend_from_slice(list);
    }

    MapGeometry {
        vertices,
        indices,
        batches,
        lightmap_pages: atlas.pages,
        stats,
    }
}
