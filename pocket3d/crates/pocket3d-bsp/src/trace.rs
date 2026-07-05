//! Hull-based collision tracing — a port of Quake/GoldSrc
//! `SV_RecursiveHullCheck` over clipnode trees, in Y-up space.
//!
//! Hull 0 (point) is synthesized from the render BSP nodes; hulls 1-3 come
//! from the pre-expanded clipnode lumps, so box collision against them is a
//! point trace. Sizes (Y-up, half-extents around the hull center):
//! - Stand  (hull 1): 16 x 36 x 16
//! - Large  (hull 2): 32 x 32 x 32
//! - Crouch (hull 3): 16 x 18 x 16

use glam::Vec3;

use crate::raw::{CONTENTS_EMPTY, CONTENTS_SOLID, ClipNode, Plane, RawBsp};

pub const DIST_EPSILON: f32 = 0.03125;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hull {
    Point,
    Stand,
    Large,
    Crouch,
}

impl Hull {
    pub fn index(self) -> usize {
        match self {
            Hull::Point => 0,
            Hull::Stand => 1,
            Hull::Large => 2,
            Hull::Crouch => 3,
        }
    }

    /// Half-extents of the hull box in Y-up space (Point is zero).
    pub fn half_extents(self) -> Vec3 {
        match self {
            Hull::Point => Vec3::ZERO,
            Hull::Stand => Vec3::new(16.0, 36.0, 16.0),
            Hull::Large => Vec3::new(32.0, 32.0, 32.0),
            Hull::Crouch => Vec3::new(16.0, 18.0, 16.0),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TraceResult {
    /// 0..1 along start->end.
    pub fraction: f32,
    pub end: Vec3,
    /// Surface normal at the impact (zero if no hit).
    pub normal: Vec3,
    pub start_solid: bool,
    pub all_solid: bool,
}

impl TraceResult {
    fn no_hit(end: Vec3) -> Self {
        Self {
            fraction: 1.0,
            end,
            normal: Vec3::ZERO,
            start_solid: false,
            all_solid: true,
        }
    }

    pub fn hit(&self) -> bool {
        self.fraction < 1.0 || self.start_solid
    }
}

/// One brush model's hull entry points.
#[derive(Clone, Copy, Debug)]
struct ModelHulls {
    headnodes: [i32; 4],
    origin: Vec3,
}

pub struct MapCollision {
    planes: Vec<Plane>,
    /// Hull 0, synthesized from the render nodes (children < 0 are contents).
    hull0: Vec<ClipNode>,
    clipnodes: Vec<ClipNode>,
    models: Vec<ModelHulls>,
    /// Solid brush entities to clip against in addition to the world:
    /// (model index, world offset).
    solids: Vec<(usize, Vec3)>,
}

impl MapCollision {
    pub fn build(bsp: &RawBsp, solid_entities: &[(usize, Vec3)]) -> Self {
        // MakeHull0: mirror the render nodes; leaf children become contents.
        let hull0 = bsp
            .nodes
            .iter()
            .map(|n| {
                let child = |c: i16| -> i32 {
                    if c >= 0 {
                        c as i32
                    } else {
                        bsp.leaves
                            .get((-1 - c as i32) as usize)
                            .map(|l| l.contents)
                            .unwrap_or(CONTENTS_SOLID)
                    }
                };
                ClipNode {
                    plane: n.plane,
                    children: [child(n.children[0]), child(n.children[1])],
                }
            })
            .collect();
        let models = bsp
            .models
            .iter()
            .map(|m| ModelHulls {
                headnodes: m.headnodes,
                origin: m.origin,
            })
            .collect();
        Self {
            planes: bsp.planes.clone(),
            hull0,
            clipnodes: bsp.clipnodes.clone(),
            models,
            solids: solid_entities.to_vec(),
        }
    }

    fn tree(&self, hull: Hull, model: usize) -> Option<(&[ClipNode], i32)> {
        let m = self.models.get(model)?;
        let head = m.headnodes[hull.index()];
        match hull {
            Hull::Point => Some((&self.hull0, head)),
            _ => Some((&self.clipnodes, head)),
        }
    }

    /// Trace against a single brush model.
    pub fn trace_model(&self, model: usize, hull: Hull, start: Vec3, end: Vec3) -> TraceResult {
        let Some((nodes, head)) = self.tree(hull, model) else {
            return TraceResult {
                all_solid: false,
                ..TraceResult::no_hit(end)
            };
        };
        let offset = self.models[model].origin;
        let (s, e) = (start - offset, end - offset);
        let mut tr = TraceResult::no_hit(e);
        let ht = HullTree {
            nodes,
            planes: &self.planes,
            first: head,
        };
        ht.check(head, 0.0, 1.0, s, e, &mut tr);
        if tr.start_solid || tr.all_solid {
            tr.start_solid = true;
            tr.fraction = 0.0;
            tr.end = start;
        } else {
            tr.end = start + (end - start) * tr.fraction;
        }
        tr
    }

    /// Trace against the world plus all registered solid brush entities.
    pub fn trace(&self, hull: Hull, start: Vec3, end: Vec3) -> TraceResult {
        let mut best = self.trace_model(0, hull, start, end);
        for &(model, entity_offset) in &self.solids {
            if model >= self.models.len() {
                continue;
            }
            let t = self.trace_model_offset(model, entity_offset, hull, start, end);
            if t.fraction < best.fraction || (t.start_solid && !best.start_solid) {
                best = t;
            }
        }
        best
    }

    fn trace_model_offset(
        &self,
        model: usize,
        entity_offset: Vec3,
        hull: Hull,
        start: Vec3,
        end: Vec3,
    ) -> TraceResult {
        let mut t = self.trace_model(model, hull, start - entity_offset, end - entity_offset);
        t.end += entity_offset;
        t
    }

    /// Contents at a point (uses hull 0 of the world).
    pub fn point_contents(&self, p: Vec3) -> i32 {
        let Some((nodes, head)) = self.tree(Hull::Point, 0) else {
            return CONTENTS_EMPTY;
        };
        let ht = HullTree {
            nodes,
            planes: &self.planes,
            first: head,
        };
        ht.contents(head, p)
    }

    /// Contents for an arbitrary hull at a point (e.g. Stand for ground checks).
    pub fn hull_contents(&self, hull: Hull, p: Vec3) -> i32 {
        let Some((nodes, head)) = self.tree(hull, 0) else {
            return CONTENTS_EMPTY;
        };
        let ht = HullTree {
            nodes,
            planes: &self.planes,
            first: head,
        };
        ht.contents(head, p)
    }
}

struct HullTree<'a> {
    nodes: &'a [ClipNode],
    planes: &'a [Plane],
    first: i32,
}

impl HullTree<'_> {
    fn contents(&self, mut num: i32, p: Vec3) -> i32 {
        while num >= 0 {
            let node = &self.nodes[num as usize];
            let plane = &self.planes[node.plane as usize];
            let d = plane.normal.dot(p) - plane.dist;
            num = node.children[if d < 0.0 { 1 } else { 0 }];
        }
        num
    }

    /// Returns true if the segment stayed in empty space so far.
    fn check(
        &self,
        num: i32,
        p1f: f32,
        p2f: f32,
        p1: Vec3,
        p2: Vec3,
        tr: &mut TraceResult,
    ) -> bool {
        if num < 0 {
            if num != CONTENTS_SOLID {
                tr.all_solid = false;
            } else {
                tr.start_solid = true;
            }
            return true;
        }

        let node = &self.nodes[num as usize];
        let plane = &self.planes[node.plane as usize];
        let t1 = plane.normal.dot(p1) - plane.dist;
        let t2 = plane.normal.dot(p2) - plane.dist;

        if t1 >= 0.0 && t2 >= 0.0 {
            return self.check(node.children[0], p1f, p2f, p1, p2, tr);
        }
        if t1 < 0.0 && t2 < 0.0 {
            return self.check(node.children[1], p1f, p2f, p1, p2, tr);
        }

        // The segment spans the plane: split.
        let frac = if t1 < 0.0 {
            (t1 + DIST_EPSILON) / (t1 - t2)
        } else {
            (t1 - DIST_EPSILON) / (t1 - t2)
        }
        .clamp(0.0, 1.0);
        let mut midf = p1f + (p2f - p1f) * frac;
        let mut mid = p1 + (p2 - p1) * frac;
        let side = usize::from(t1 < 0.0);

        // Near side first.
        if !self.check(node.children[side], p1f, midf, p1, mid, tr) {
            return false;
        }
        // Far side if it isn't solid at the crossing point.
        if self.contents(node.children[side ^ 1], mid) != CONTENTS_SOLID {
            return self.check(node.children[side ^ 1], midf, p2f, mid, p2, tr);
        }

        if tr.all_solid {
            return false; // never emerged from solid
        }

        if side == 0 {
            tr.normal = plane.normal;
        } else {
            tr.normal = -plane.normal;
        }

        // Back the impact point up off the surface until it's out of solid.
        let mut f = frac;
        while self.contents(self.first, mid) == CONTENTS_SOLID {
            f -= 0.1;
            if f < 0.0 {
                tr.fraction = midf;
                return false;
            }
            midf = p1f + (p2f - p1f) * f;
            mid = p1 + (p2 - p1) * f;
        }
        tr.fraction = midf;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-plane "floor at y=0" hull: above empty, below solid.
    fn floor_tree() -> (Vec<ClipNode>, Vec<Plane>) {
        let planes = vec![Plane {
            normal: Vec3::Y,
            dist: 0.0,
        }];
        let nodes = vec![ClipNode {
            plane: 0,
            children: [CONTENTS_EMPTY, CONTENTS_SOLID],
        }];
        (nodes, planes)
    }

    #[test]
    fn trace_hits_floor() {
        let (nodes, planes) = floor_tree();
        let ht = HullTree {
            nodes: &nodes,
            planes: &planes,
            first: 0,
        };
        let mut tr = TraceResult::no_hit(Vec3::new(0.0, -10.0, 0.0));
        ht.check(
            0,
            0.0,
            1.0,
            Vec3::new(0.0, 10.0, 0.0),
            Vec3::new(0.0, -10.0, 0.0),
            &mut tr,
        );
        assert!(!tr.start_solid);
        assert!((tr.fraction - 0.5).abs() < 0.01, "fraction {}", tr.fraction);
        assert_eq!(tr.normal, Vec3::Y);
    }

    #[test]
    fn trace_misses_in_open() {
        let (nodes, planes) = floor_tree();
        let ht = HullTree {
            nodes: &nodes,
            planes: &planes,
            first: 0,
        };
        let mut tr = TraceResult::no_hit(Vec3::new(10.0, 5.0, 0.0));
        let stayed_open = ht.check(
            0,
            0.0,
            1.0,
            Vec3::new(0.0, 5.0, 0.0),
            Vec3::new(10.0, 5.0, 0.0),
            &mut tr,
        );
        assert!(stayed_open);
        assert_eq!(tr.fraction, 1.0);
        assert!(!tr.all_solid);
    }
}
