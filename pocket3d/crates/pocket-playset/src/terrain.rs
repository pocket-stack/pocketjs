//! Procedural terrain: the height/normal field the cars actually drive on.
//!
//! Ported from playset/modules/world/environment/terrain-sampler.ts —
//! `RoadTerrainSampler` (what rally uses: rolling noise flattened toward a
//! polyline road) and `NaturalTerrainSampler` (plain rolling hills). That TS
//! module is itself a port of GameBlocks (github.com/xt4d/GameBlocks, MIT ©
//! 2026 Weihao Cheng) — modules/world/environment/TerrainSampler.js.
//!
//! The TS modules REMAIN the reference implementation. This is the native f32
//! twin for the hot path: terrain is sampled ~6x per sim step (each car's
//! plan/commit, plus the resolver's ground query) and every sample evaluates
//! [`RoadTerrain::height_at`] five times — once for the height, four more for
//! the central-difference normal. Thirty height evaluations per step, each one
//! a `sin`, a `cos`, four hash `sin`s and a walk over every road segment, is
//! precisely the shape of work that costs ~1.7µs/op in QuickJS on the PSP and
//! a rounding error in native code.
//!
//! DELIBERATE OMISSIONS:
//! - `colorAt` is not ported. Terrain colour is baked into the mesh once at
//!   build time (the TS environment builders own that), never sampled in the
//!   sim loop, so it has no business in the native core.
//! - `ArchipelagoTerrainSampler` is not ported — no native consumer yet.
//! - The `basis` option is gone: [`crate::math`] hard-codes the default world
//!   basis (right = +X, up = +Y, forward = -Z), so slope → normal goes
//!   through [`math::surface_normal_from_slopes`].
//! - The cached segment keeps only `start` + deltas + `lengthSq`; the TS cache
//!   also stores `end`, which nothing reads.

#![allow(clippy::excessive_precision)]

use alloc::vec::Vec;
use glam::Vec3;

use crate::math::{self, clamp, fmath, fract, lerp};

/// `seedOffset` the road sampler's mid-frequency noise uses (terrain-sampler.ts
/// `heightAt`). Naming it keeps the magic 31 out of the hot line.
const MID_NOISE_SEED_OFFSET: f32 = 31.0;

/// Degenerate-segment threshold, verbatim from the TS constructor.
const MIN_SEGMENT_LENGTH_SQ: f32 = 1e-8;

// ---------------------------------------------------------------------------
// road terrain
// ---------------------------------------------------------------------------

/// One cached road segment: start point, precomputed delta and squared length,
/// exactly the shape of the TS `roadSegmentCache` entry. Stored flat in a
/// `Vec` so [`RoadTerrain::distance_to_road`] is a linear scan over 20-byte
/// records with no pointer chasing and no per-call arithmetic that could have
/// been hoisted.
#[derive(Clone, Copy, Debug)]
struct RoadSegment {
    start_right: f32,
    start_forward: f32,
    delta_right: f32,
    delta_forward: f32,
    length_sq: f32,
}

/// Number of floats [`RoadTerrain::configure`] consumes.
pub const ROAD_CONFIG_FLOATS: usize = 9;

/// Rolling procedural terrain, flattened toward a road polyline.
///
/// Config fields are `pub` (the mount fills them from a flat float array) and
/// each also has a chaining setter, so both styles work:
///
/// ```ignore
/// let mut t = RoadTerrain::new();
/// t.seed(2026.0).road_half_width(6.0);
/// t.mid_noise_amp = 1.15;
/// ```
#[derive(Clone, Debug)]
pub struct RoadTerrain {
    pub seed: f32,
    pub road_half_width: f32,
    pub road_height: f32,
    pub road_flatness_at_half_width: f32,
    pub large_wave_scale: f32,
    pub large_wave_amp: f32,
    pub mid_noise_scale: f32,
    pub mid_noise_amp: f32,
    pub normal_step: f32,
    segments: Vec<RoadSegment>,
}

impl Default for RoadTerrain {
    fn default() -> Self {
        Self::new()
    }
}

impl RoadTerrain {
    /// The TS constructor's defaults (also `DEFAULT_ROAD_TERRAIN_SAMPLER_CONFIG`
    /// in race-track-environment.ts), with an empty segment list.
    pub fn new() -> Self {
        Self {
            seed: 2026.0,
            road_half_width: 6.0,
            road_height: 0.0,
            road_flatness_at_half_width: 0.8,
            large_wave_scale: 0.05,
            large_wave_amp: 1.45,
            mid_noise_scale: 0.12,
            mid_noise_amp: 1.15,
            normal_step: 0.2,
            segments: Vec::new(),
        }
    }

    /// Fill the config from a flat float array in
    /// `DEFAULT_ROAD_TERRAIN_SAMPLER_CONFIG` declaration order:
    /// `[seed, roadHalfWidth, roadHeight, roadFlatnessAtHalfWidth,
    ///   largeWaveScale, largeWaveAmp, midNoiseScale, midNoiseAmp,
    ///   normalStep]`.
    ///
    /// A short slice sets only the fields it covers and leaves the rest at
    /// their defaults — ops are intent, not calls, so a guest that packs three
    /// floats gets three floats, not a panic. Segments arrive separately via
    /// [`RoadTerrain::push_segment`].
    pub fn configure(&mut self, cfg: &[f32]) -> &mut Self {
        let set = |i: usize, field: &mut f32| {
            if let Some(v) = cfg.get(i) {
                *field = *v;
            }
        };
        set(0, &mut self.seed);
        set(1, &mut self.road_half_width);
        set(2, &mut self.road_height);
        set(3, &mut self.road_flatness_at_half_width);
        set(4, &mut self.large_wave_scale);
        set(5, &mut self.large_wave_amp);
        set(6, &mut self.mid_noise_scale);
        set(7, &mut self.mid_noise_amp);
        set(8, &mut self.normal_step);
        self
    }

    /// Append a road segment (planar right/forward endpoints). Degenerate
    /// segments (`lengthSq <= 1e-8`) are dropped exactly like the TS cache
    /// builder — a zero-length segment would divide by zero in the projection.
    pub fn push_segment(
        &mut self,
        start_right: f32,
        start_forward: f32,
        end_right: f32,
        end_forward: f32,
    ) {
        let delta_right = end_right - start_right;
        let delta_forward = end_forward - start_forward;
        let length_sq = delta_right * delta_right + delta_forward * delta_forward;
        if length_sq <= MIN_SEGMENT_LENGTH_SQ {
            return;
        }
        self.segments.push(RoadSegment {
            start_right,
            start_forward,
            delta_right,
            delta_forward,
            length_sq,
        });
    }

    /// Drop every cached segment (rebuilding a track without rebuilding the
    /// sampler). With no segments the road never flattens anything — see
    /// [`RoadTerrain::distance_to_road`].
    pub fn clear_segments(&mut self) {
        self.segments.clear();
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    // -- config setters (chaining) -------------------------------------------

    pub fn seed(&mut self, seed: f32) -> &mut Self {
        self.seed = seed;
        self
    }
    pub fn road_half_width(&mut self, v: f32) -> &mut Self {
        self.road_half_width = v;
        self
    }
    pub fn road_height(&mut self, v: f32) -> &mut Self {
        self.road_height = v;
        self
    }
    pub fn road_flatness_at_half_width(&mut self, v: f32) -> &mut Self {
        self.road_flatness_at_half_width = v;
        self
    }
    pub fn large_wave_scale(&mut self, v: f32) -> &mut Self {
        self.large_wave_scale = v;
        self
    }
    pub fn large_wave_amp(&mut self, v: f32) -> &mut Self {
        self.large_wave_amp = v;
        self
    }
    pub fn mid_noise_scale(&mut self, v: f32) -> &mut Self {
        self.mid_noise_scale = v;
        self
    }
    pub fn mid_noise_amp(&mut self, v: f32) -> &mut Self {
        self.mid_noise_amp = v;
        self
    }
    pub fn normal_step(&mut self, v: f32) -> &mut Self {
        self.normal_step = v;
        self
    }

    // -- noise ----------------------------------------------------------------

    /// The classic GLSL value hash, algebraically verbatim from the TS:
    /// `fract(sin(r*127.1 + f*311.7 + seed*101.3) * 43758.5453123)`.
    ///
    /// TRAJECTORY-EQUIVALENT, NOT BIT-EQUIVALENT to the TS reference — and
    /// this one deserves the warning label, because it is the worst-behaved
    /// expression in the whole port:
    ///
    /// 1. **The argument to `sin` is huge.** With the rally seed, `seed*101.3`
    ///    alone is ~205234; an f32 there has an ulp of 0.0156 *radians*. The
    ///    f64 path sees a different point on the sine curve entirely, so
    ///    individual hash values bear no resemblance to the f64 ones. That is
    ///    inherent to the hash — it *depends* on catastrophic cancellation for
    ///    its randomness — not something a port can fix.
    /// 2. **`sin(x) * 43758.5453123` throws away the low bits.** The product
    ///    lives near 4.4e4 where the f32 ulp is ~0.0039, so `fract` of it takes
    ///    roughly 256 distinct values instead of a continuum. The lattice
    ///    corners are quantised; the smoothstep interpolation between them is
    ///    not, so the terrain stays smooth. At `midNoiseAmp = 1.15` that
    ///    quantum is ~9mm of height — two orders of magnitude below anything
    ///    the car physics can feel.
    ///
    /// What IS preserved is everything that matters for the game: the same
    /// algebraic form, the same lattice, the same value-noise distribution and
    /// amplitude, the same road flattening. The terrain has the same character
    /// of bumps as the reference; it is not the same bump in the same
    /// millimetre. Parity with TS is asserted as bounded trajectory divergence
    /// (see the crate-level precision contract), never as byte equality.
    ///
    /// Concretely, the TS unit test's default sampler
    /// (playset/test/world-environment.test.ts) pins `heightAt(10, 5)` at
    /// 1.9359 in f64; this port returns 2.5943. Both are the same 2.100m
    /// large-wave plus a noise draw in ±1.15 — a different draw, not a
    /// different field. If a future change makes those two numbers converge,
    /// something has quietly stopped being the GLSL hash.
    ///
    /// What IS bit-exact is desktop vs PSP: the multiplies and adds are IEEE
    /// f32 (exact everywhere) and `sin` is [`fmath::sin`] → `libm::sinf` on
    /// both hosts, never the platform libm. Terrain height feeds car physics,
    /// so a host-dependent `sinf` would mean host-dependent lap times; that is
    /// the whole reason `fmath` exists. DO NOT swap this for `f32::sin()`.
    #[inline]
    pub fn hash2d(&self, right: f32, forward: f32, seed_offset: f32) -> f32 {
        let seed = self.seed + seed_offset;
        fract(fmath::sin(right * 127.1 + forward * 311.7 + seed * 101.3) * 43758.5453123)
    }

    /// Smoothstep-interpolated value noise on the integer lattice, in [-1, 1].
    /// Verbatim from the TS (which spells the lerps out inline).
    pub fn noise2d(&self, right: f32, forward: f32, seed_offset: f32) -> f32 {
        let right_index = fmath::floor(right);
        let forward_index = fmath::floor(forward);
        let right_frac = right - right_index;
        let forward_frac = forward - forward_index;

        let right_blend = right_frac * right_frac * (3.0 - 2.0 * right_frac);
        let forward_blend = forward_frac * forward_frac * (3.0 - 2.0 * forward_frac);

        let a = self.hash2d(right_index, forward_index, seed_offset);
        let b = self.hash2d(right_index + 1.0, forward_index, seed_offset);
        let c = self.hash2d(right_index, forward_index + 1.0, seed_offset);
        let d = self.hash2d(right_index + 1.0, forward_index + 1.0, seed_offset);

        let right_low = a + (b - a) * right_blend;
        let right_high = c + (d - c) * right_blend;
        (right_low + (right_high - right_low) * forward_blend) * 2.0 - 1.0
    }

    // -- the road field --------------------------------------------------------

    /// Planar distance to the nearest point on the road polyline.
    ///
    /// Linear scan, no spatial index — same as the TS, and the reason segment
    /// count is the one thing that makes terrain sampling scale badly. A rally
    /// track is a few dozen segments; at 30 height evaluations per step that is
    /// ~1k segment projections per frame, which native f32 does not notice.
    ///
    /// With no segments this returns `+inf` (the TS `Math.sqrt(Infinity)`),
    /// which drives the flatness to exactly 0 — an unflattened noise field.
    pub fn distance_to_road(&self, right: f32, forward: f32) -> f32 {
        let mut nearest_sq = f32::INFINITY;
        for segment in self.segments.iter() {
            let relative_right = right - segment.start_right;
            let relative_forward = forward - segment.start_forward;
            let t = clamp(
                (relative_right * segment.delta_right + relative_forward * segment.delta_forward)
                    / segment.length_sq,
                0.0,
                1.0,
            );
            let dist_right = relative_right - segment.delta_right * t;
            let dist_forward = relative_forward - segment.delta_forward * t;
            let d = dist_right * dist_right + dist_forward * dist_forward;
            if d < nearest_sq {
                nearest_sq = d;
            }
        }
        fmath::sqrt(nearest_sq)
    }

    /// How thoroughly the road flattens the terrain here: 1 on the centreline,
    /// `roadFlatnessAtHalfWidth` at the road edge, → 0 far away.
    ///
    /// (The TS computes `nearest = start + delta*t` then `point - nearest`;
    /// this folds that into `relative - delta*t`, which is the same expression
    /// with `start` cancelled — one fewer add per segment and, being an exact
    /// algebraic cancellation of the *same* f32 subtraction, not a rounding
    /// deviation.)
    pub fn road_flatness_at(&self, right: f32, forward: f32) -> f32 {
        let distance_ratio = self.distance_to_road(right, forward) / self.road_half_width;
        fmath::powf(
            self.road_flatness_at_half_width,
            distance_ratio * distance_ratio,
        )
    }

    /// Terrain height: a large slow wave plus mid-frequency value noise,
    /// lerped toward `road_height` by the road flatness.
    pub fn height_at(&self, right: f32, forward: f32) -> f32 {
        let road_flatness = self.road_flatness_at(right, forward);
        let large_wave = fmath::sin(right * self.large_wave_scale) * self.large_wave_amp
            + fmath::cos(forward * self.large_wave_scale) * self.large_wave_amp;
        let mid_noise = self.noise2d(
            right * self.mid_noise_scale,
            forward * self.mid_noise_scale,
            MID_NOISE_SEED_OFFSET,
        ) * self.mid_noise_amp;
        lerp(large_wave + mid_noise, self.road_height, road_flatness)
    }

    /// Surface normal by central difference — four more `height_at` calls.
    pub fn normal_at(&self, right: f32, forward: f32) -> Vec3 {
        let e = normal_epsilon(self.normal_step, 0.0001);
        let right_high = self.height_at(right + e, forward);
        let right_low = self.height_at(right - e, forward);
        let forward_high = self.height_at(right, forward + e);
        let forward_low = self.height_at(right, forward - e);
        math::surface_normal_from_slopes(
            (right_high - right_low) / (2.0 * e),
            (forward_high - forward_low) / (2.0 * e),
        )
    }
}

// ---------------------------------------------------------------------------
// natural terrain
// ---------------------------------------------------------------------------

/// Number of floats [`NaturalTerrain::configure`] consumes.
pub const NATURAL_CONFIG_FLOATS: usize = 4;

/// Rolling hills: two analytic sine lobes, no noise, no road. Cheap enough
/// that it is basically free next to [`RoadTerrain`].
#[derive(Clone, Copy, Debug)]
pub struct NaturalTerrain {
    pub base_height: f32,
    pub undulation: f32,
    pub hill_frequency: f32,
    pub normal_step: f32,
}

impl Default for NaturalTerrain {
    fn default() -> Self {
        Self::new()
    }
}

impl NaturalTerrain {
    /// The TS constructor's defaults (`colorHeightThreshold` omitted with
    /// `colorAt`).
    pub fn new() -> Self {
        Self {
            base_height: 0.0,
            undulation: 3.6,
            hill_frequency: 1.0,
            normal_step: 0.2,
        }
    }

    /// Fill the config from a flat float array:
    /// `[baseHeight, undulation, hillFrequency, normalStep]`.
    ///
    /// NOTE the index deviation from the TS options object: the TS declares
    /// `colorHeightThreshold` between `hillFrequency` and `normalStep`, and
    /// this port has no colour, so `normalStep` moves from slot 4 to slot 3.
    /// A short slice leaves the remaining fields at their defaults.
    pub fn configure(&mut self, cfg: &[f32]) -> &mut Self {
        let set = |i: usize, field: &mut f32| {
            if let Some(v) = cfg.get(i) {
                *field = *v;
            }
        };
        set(0, &mut self.base_height);
        set(1, &mut self.undulation);
        set(2, &mut self.hill_frequency);
        set(3, &mut self.normal_step);
        self
    }

    pub fn base_height(&mut self, v: f32) -> &mut Self {
        self.base_height = v;
        self
    }
    pub fn undulation(&mut self, v: f32) -> &mut Self {
        self.undulation = v;
        self
    }
    pub fn hill_frequency(&mut self, v: f32) -> &mut Self {
        self.hill_frequency = v;
        self
    }
    pub fn normal_step(&mut self, v: f32) -> &mut Self {
        self.normal_step = v;
        self
    }

    /// Two crossed sine lobes scaled to `undulation`. The `2.2/3.6` and
    /// `1.4/3.6` weights are the TS's (they keep the lobe ratio while
    /// `undulation` reparameterises the total amplitude away from its 3.6
    /// default).
    pub fn height_at(&self, right: f32, forward: f32) -> f32 {
        let hill_a = fmath::sin(right * 0.055 * self.hill_frequency)
            * fmath::cos(forward * 0.047 * self.hill_frequency)
            * (2.2 / 3.6);
        let hill_b = fmath::sin((right + forward) * 0.022 * self.hill_frequency) * (1.4 / 3.6);
        self.base_height + (hill_a + hill_b) * self.undulation
    }

    pub fn normal_at(&self, right: f32, forward: f32) -> Vec3 {
        let e = normal_epsilon(self.normal_step, 0.0001);
        let right_high = self.height_at(right + e, forward);
        let right_low = self.height_at(right - e, forward);
        let forward_high = self.height_at(right, forward + e);
        let forward_low = self.height_at(right, forward - e);
        math::surface_normal_from_slopes(
            (right_high - right_low) / (2.0 * e),
            (forward_high - forward_low) / (2.0 * e),
        )
    }
}

/// `Math.max(floor, step)` — spelled out rather than via `f32::max` because
/// that is a std intrinsic and this crate is no_std on the PSP.
#[inline]
fn normal_epsilon(step: f32, floor: f32) -> f32 {
    if step > floor {
        step
    } else {
        floor
    }
}

// ---------------------------------------------------------------------------
// the ground the world stands on
// ---------------------------------------------------------------------------

/// Which terrain a [`crate::world::World`] is standing on. `None` is a flat
/// plane at height 0 — the graceful default, so a world can step before the
/// guest has finished assembling it.
#[derive(Clone, Debug, Default)]
pub enum Terrain {
    #[default]
    None,
    Road(RoadTerrain),
    Natural(NaturalTerrain),
    Grid(Heightfield),
}

impl Terrain {
    /// 0.0 when `None`.
    #[inline]
    pub fn height_at(&self, right: f32, forward: f32) -> f32 {
        match self {
            Terrain::None => 0.0,
            Terrain::Road(t) => t.height_at(right, forward),
            Terrain::Natural(t) => t.height_at(right, forward),
            Terrain::Grid(t) => t.height_at(right, forward),
        }
    }

    /// `Vec3::Y` when `None`.
    #[inline]
    pub fn normal_at(&self, right: f32, forward: f32) -> Vec3 {
        match self {
            Terrain::None => math::UP,
            Terrain::Road(t) => t.normal_at(right, forward),
            Terrain::Natural(t) => t.normal_at(right, forward),
            Terrain::Grid(t) => t.normal_at(right, forward),
        }
    }
}

// ---------------------------------------------------------------------------
// Heightfield — the sampler that agrees with what is on screen
// ---------------------------------------------------------------------------

/// A bilinear sampler over the EXACT height grid the visible terrain mesh was
/// tessellated from (`createTerrainMesh`'s `heights`, shipped across by the
/// guest at boot).
///
/// WHY THIS EXISTS, and why rally uses it instead of [`RoadTerrain`]: the
/// procedural samplers depend on a GLSL-style `fract(sin(...) * 43758.5)`
/// hash, which is a different function in f32 than in f64 (see `hash2d`). The
/// terrain MESH is tessellated guest-side in f64; if the native sim re-derived
/// heights in f32 the car would drive on a surface that is not the one being
/// drawn — floating over some ground, sunk into other. Sampling the drawn grid
/// removes the whole class of problem: physics and pixels read the same data.
///
/// It is also simply faster — a bilinear lookup instead of five `height_at`
/// evaluations each walking every road segment and hashing.
///
/// Outside the grid the edge value is held (clamped indexing), which keeps a
/// car that drives off the mesh on a sane surface instead of falling forever.
#[derive(Clone, Debug)]
pub struct Heightfield {
    /// World extent of the grid, centred on the origin (mesh `size`).
    size: f32,
    /// Vertices per side (mesh `segments + 1`).
    side: usize,
    /// Row-major `side * side`, row = forward, col = right — the same
    /// traversal `createTerrainMesh` fills.
    heights: Vec<f32>,
    /// Finite-difference step for normals: one cell.
    step: f32,
}

impl Heightfield {
    /// `heights` must hold `side * side` samples; a short or empty slice makes
    /// a flat field (ops are intent — a malformed payload must not panic).
    pub fn new(size: f32, side: usize, heights: &[f32]) -> Self {
        let side = side.max(2);
        let size = if size > 0.001 { size } else { 0.001 };
        let mut grid = Vec::with_capacity(side * side);
        grid.extend_from_slice(&heights[..heights.len().min(side * side)]);
        grid.resize(side * side, 0.0);
        Self {
            size,
            side,
            heights: grid,
            step: size / (side - 1) as f32,
        }
    }

    #[inline]
    fn at(&self, col: usize, row: usize) -> f32 {
        self.heights[row * self.side + col]
    }

    #[inline]
    pub fn height_at(&self, right: f32, forward: f32) -> f32 {
        let half = self.size * 0.5;
        let last = (self.side - 1) as f32;
        // Grid coordinates, clamped so off-mesh queries hold the edge value.
        let gx = math::clamp((right + half) / self.step, 0.0, last);
        let gy = math::clamp((forward + half) / self.step, 0.0, last);
        let x0 = fmath_floor_usize(gx);
        let y0 = fmath_floor_usize(gy);
        let x1 = (x0 + 1).min(self.side - 1);
        let y1 = (y0 + 1).min(self.side - 1);
        let tx = gx - x0 as f32;
        let ty = gy - y0 as f32;
        let top = math::lerp(self.at(x0, y0), self.at(x1, y0), tx);
        let bottom = math::lerp(self.at(x0, y1), self.at(x1, y1), tx);
        math::lerp(top, bottom, ty)
    }

    #[inline]
    pub fn normal_at(&self, right: f32, forward: f32) -> Vec3 {
        let e = self.step;
        let dr = (self.height_at(right + e, forward) - self.height_at(right - e, forward)) / (2.0 * e);
        let df = (self.height_at(right, forward + e) - self.height_at(right, forward - e)) / (2.0 * e);
        math::surface_normal_from_slopes(dr, df)
    }
}

#[inline]
fn fmath_floor_usize(v: f32) -> usize {
    let f = math::fmath::floor(v);
    if f <= 0.0 {
        0
    } else {
        f as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS unit test's geometry: one segment straight up the forward axis.
    fn road_with_centre_segment() -> RoadTerrain {
        let mut t = RoadTerrain::new();
        t.push_segment(0.0, -10.0, 0.0, 10.0);
        t
    }

    #[test]
    fn segment_distance_known_answers() {
        let t = road_with_centre_segment();
        // Perpendicular, projection lands mid-segment (the TS test's `3`).
        assert_eq!(t.distance_to_road(3.0, 0.0), 3.0);
        assert_eq!(t.distance_to_road(-4.0, 5.0), 4.0);
        // Past the ends: t clamps, so it becomes a distance to the endpoint.
        assert_eq!(t.distance_to_road(0.0, 20.0), 10.0);
        assert_eq!(t.distance_to_road(0.0, -13.5), 3.5);
        // 3-4-5 off the far endpoint.
        assert_eq!(t.distance_to_road(3.0, 14.0), 5.0);
    }

    #[test]
    fn degenerate_segments_are_dropped() {
        let mut t = RoadTerrain::new();
        t.push_segment(1.0, 1.0, 1.0, 1.0);
        t.push_segment(2.0, 2.0, 2.00001, 2.0); // lengthSq 1e-10 <= 1e-8
        assert_eq!(t.segment_count(), 0);
        t.push_segment(0.0, 0.0, 1.0, 0.0);
        assert_eq!(t.segment_count(), 1);
    }

    #[test]
    fn no_segments_means_no_flattening() {
        let t = RoadTerrain::new();
        assert!(t.distance_to_road(5.0, 5.0).is_infinite());
        assert_eq!(t.road_flatness_at(5.0, 5.0), 0.0);
        // flatness 0 ⇒ lerp(terrain, roadHeight, 0) is the raw noise field,
        // which must not be the (nonzero) road height.
        let mut flat = RoadTerrain::new();
        flat.road_height(100.0);
        assert_eq!(flat.height_at(5.0, 5.0), t.height_at(5.0, 5.0));
    }

    #[test]
    fn road_centreline_flattens_exactly_to_road_height() {
        let mut t = road_with_centre_segment();
        t.road_height(2.5);
        // distance 0 ⇒ flatness 0.8^0 = 1 ⇒ lerp(_, roadHeight, 1) exactly.
        assert_eq!(t.road_flatness_at(0.0, 0.0), 1.0);
        assert_eq!(t.height_at(0.0, 0.0), 2.5);
        assert_eq!(t.height_at(0.0, -4.0), 2.5);
    }

    #[test]
    fn flattening_pulls_toward_road_height_and_fades_out() {
        let mut t = road_with_centre_segment();
        t.road_height(2.5);
        // A segment-free twin samples the same raw field (flatness 0).
        let mut raw = RoadTerrain::new();
        raw.road_height(2.5);

        // Half a road-width out: partly pulled in, strictly closer to the road
        // height than the unflattened terrain is.
        let near = t.height_at(3.0, 0.0);
        let raw_near = raw.height_at(3.0, 0.0);
        assert!(fmath::abs(near - 2.5) < fmath::abs(raw_near - 2.5));
        assert!(t.road_flatness_at(3.0, 0.0) > 0.9); // 0.8^0.25 ≈ 0.9457
        assert!(t.road_flatness_at(3.0, 0.0) < 1.0);

        // Far away: flatness has decayed to nothing and the field is raw.
        assert_eq!(t.road_flatness_at(4000.0, 0.0), 0.0);
        assert_eq!(t.height_at(4000.0, 0.0), raw.height_at(4000.0, 0.0));
    }

    #[test]
    fn road_normals_are_unit_and_point_up() {
        let t = road_with_centre_segment();
        for &(r, f) in &[(0.0f32, 0.0f32), (3.0, 1.0), (-17.0, 40.0), (250.0, -90.0)] {
            let n = t.normal_at(r, f);
            assert!(fmath::abs(n.length() - 1.0) < 1e-5, "not unit at {r},{f}");
            assert!(n.y > 0.0, "not upward at {r},{f}");
        }
        // On the centreline the road is dead flat ALONG itself: both forward
        // probes sit on the segment, flatness is exactly 1, so the forward
        // slope — and with it the normal's Z — is exactly zero. Across the
        // road it is only *nearly* flat: the ±e probes are 0.2m off the
        // centreline where flatness is 0.99975, not 1, so a whisker of the
        // underlying noise leaks through (measured: right slope ~3.4e-5).
        let n = t.normal_at(0.0, 0.0);
        assert_eq!(n.z, 0.0);
        assert!((n - math::UP).length() < 1e-3);
    }

    #[test]
    fn natural_hills_and_normals() {
        let t = NaturalTerrain::new();
        // Both lobes vanish at the origin: height is exactly base_height.
        assert_eq!(t.height_at(0.0, 0.0), 0.0);
        let mut raised = NaturalTerrain::new();
        raised.base_height(7.0);
        assert_eq!(raised.height_at(0.0, 0.0), 7.0);
        // Amplitude is bounded by the lobe weights times undulation.
        for &(r, f) in &[(12.0f32, -8.0f32), (100.0, 250.0), (-60.0, 33.0)] {
            assert!(fmath::abs(t.height_at(r, f)) <= 3.6 + 1e-4);
            let n = t.normal_at(r, f);
            assert!(fmath::abs(n.length() - 1.0) < 1e-5);
            assert!(n.y > 0.0);
        }
        // undulation = 0 ⇒ a perfectly flat plane with an up normal.
        let mut flat = NaturalTerrain::new();
        flat.undulation(0.0);
        assert_eq!(flat.height_at(19.0, -4.0), 0.0);
        assert!((flat.normal_at(19.0, -4.0) - math::UP).length() < 1e-6);
    }

    #[test]
    fn sampling_is_deterministic_bit_for_bit() {
        let t = road_with_centre_segment();
        // Same sampler, same input, twice.
        assert_eq!(t.height_at(10.0, 5.0).to_bits(), t.height_at(10.0, 5.0).to_bits());
        assert_eq!(
            t.normal_at(10.0, 5.0).x.to_bits(),
            t.normal_at(10.0, 5.0).x.to_bits()
        );
        // Two independently built samplers agree — the seed is the only state.
        let u = road_with_centre_segment();
        for &(r, f) in &[(10.0f32, 5.0f32), (-3.25, 88.5), (0.5, -0.5)] {
            assert_eq!(t.height_at(r, f).to_bits(), u.height_at(r, f).to_bits());
        }
        // A different seed gives a different field (the hash actually reads it).
        let mut v = road_with_centre_segment();
        v.seed(7.0);
        assert_ne!(t.height_at(40.0, 40.0), v.height_at(40.0, 40.0));
    }

    #[test]
    fn noise_stays_in_range() {
        let t = RoadTerrain::new();
        let mut r = -20.0f32;
        while r < 20.0 {
            let n = t.noise2d(r, r * 0.37 - 4.0, MID_NOISE_SEED_OFFSET);
            assert!((-1.0..=1.0).contains(&n), "noise {n} out of range at {r}");
            let h = t.hash2d(r, -r, 0.0);
            assert!((0.0..1.0).contains(&h), "hash {h} out of range at {r}");
            r += 0.317;
        }
    }

    #[test]
    fn terrain_enum_dispatch_and_none_defaults() {
        let none = Terrain::None;
        assert_eq!(none.height_at(12.0, -3.0), 0.0);
        assert_eq!(none.normal_at(12.0, -3.0), Vec3::Y);

        let road = road_with_centre_segment();
        let wrapped = Terrain::Road(road.clone());
        assert_eq!(wrapped.height_at(9.0, 2.0), road.height_at(9.0, 2.0));
        assert_eq!(wrapped.normal_at(9.0, 2.0), road.normal_at(9.0, 2.0));

        let natural = NaturalTerrain::new();
        let wrapped = Terrain::Natural(natural);
        assert_eq!(wrapped.height_at(9.0, 2.0), natural.height_at(9.0, 2.0));
    }

    #[test]
    fn configure_fills_from_a_flat_array() {
        let mut t = RoadTerrain::new();
        t.configure(&[1.0, 2.0, 3.0, 0.5, 0.06, 1.5, 0.2, 1.0, 0.25]);
        assert_eq!(t.seed, 1.0);
        assert_eq!(t.road_half_width, 2.0);
        assert_eq!(t.road_height, 3.0);
        assert_eq!(t.road_flatness_at_half_width, 0.5);
        assert_eq!(t.normal_step, 0.25);
        // Short slices leave the tail alone.
        let mut u = RoadTerrain::new();
        u.configure(&[9.0]);
        assert_eq!(u.seed, 9.0);
        assert_eq!(u.road_half_width, 6.0);

        let mut n = NaturalTerrain::new();
        n.configure(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!((n.base_height, n.undulation, n.hill_frequency, n.normal_step), (1.0, 2.0, 3.0, 4.0));
    }
}
