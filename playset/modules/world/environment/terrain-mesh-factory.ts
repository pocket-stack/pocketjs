// playset/modules/world/environment/terrain-mesh-factory.ts — bakes a
// terrain sampler into a scene3d heightfield mesh and registers the sampler
// as the CollisionWorld ground authority.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/TerrainMeshFactory.js. Deliberate
// changes for the scene3d surface:
//   - The original built an indexed (segments+1)² BufferGeometry; the same
//     regular grid maps directly onto geomHeightfield(size, size, cols,
//     rows, heights, colors) — the host owns tessellation/normals, so the
//     index buffer and computeVertexNormals are gone. Heights are sampled in
//     the original's row/col order (forward, then right, both from -size/2).
//   - Heightfields live in world axes (+Y up); non-default bases would need
//     a node rotation — GameBlocks only ever uses the default basis here.
//   - materialOptions (roughness/metalness) has no fixed-function analog and
//     is accepted but ignored; the material is vertex-colored.
//   - createTerrainTrimeshCollider(world, rapier, mesh) is replaced by
//     registerTerrainCollider(world, sampler): the CollisionWorld's ground
//     authority is the SAMPLER (world.setTerrain), not a trimesh — exact
//     heights instead of triangle interpolation, and no Rapier. It returns
//     nothing (there is no body/collider pair to hand back).

import { MAT, type Scene3D, type SceneNode } from "../../../scene3d/client.ts";
import type { CollisionWorld, TerrainLike } from "../../physics/collision-world.ts";
import type { WorldBasis } from "../../math/world-basis.ts";

/** spec ABGR byte order: (a<<24)|(b<<16)|(g<<8)|r. Local on purpose. */
function rgbToAbgr(hex: number, alpha = 255): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return (((alpha & 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** What createTerrainMesh needs from a sampler (all three samplers qualify). */
export interface MeshTerrainSampler {
  basis?: WorldBasis;
  sample(
    right: number,
    forward: number,
  ): { height: number; color?: { r: number; g: number; b: number } | null } | null | undefined;
  noise2D?(right: number, forward: number, seedOffset?: number): number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function defaultTerrainColor(height = 0, colorNoise = 0): { r: number; g: number; b: number } {
  const grassMix = clamp01((height + 4) / 12);
  const ridgeMix = clamp01((height - 8) / 18);
  return {
    r: 0.22 + grassMix * 0.1 + ridgeMix * 0.16 + colorNoise,
    g: 0.32 + grassMix * 0.18 - ridgeMix * 0.02 + colorNoise * 0.6,
    b: 0.16 + grassMix * 0.08 + ridgeMix * 0.09 + colorNoise * 0.35,
  };
}

/** The height grid the mesh was tessellated from — the drawn surface itself. */
export interface TerrainGrid {
  /** World extent, centred on the origin. */
  size: number;
  /** Vertices per side (`segments + 1`). */
  side: number;
  /** Row-major `side * side`; row = forward, col = right. */
  heights: Float32Array;
}

export interface CreateTerrainMeshOptions {
  scene: Scene3D;
  terrainSampler: MeshTerrainSampler;
  size?: number;
  segments?: number;
  /** Accepted for API compatibility; ignored (see header). */
  materialOptions?: Record<string, unknown>;
  /**
   * Split the mesh into `tiles`x`tiles` separately-drawn patches so a host
   * with frustum culling can reject the parts of the ground that are behind
   * or beside the camera.
   *
   * MEASURED (real PSP, rally): once the props were being culled, this ONE
   * mesh was 4,608 of the 6,381 triangles still reaching the GE — its bounding
   * volume spans the whole map, so it could never be rejected, while most of
   * its vertices sat outside the view. 1 keeps the single-mesh behaviour.
   *
   * PICK IT BY MEASURING. The tradeoff has no content-independent answer:
   * finer patches cull better, but adjacent patches duplicate a row of quads
   * each (see below), so on a small terrain that is mostly on screen anyway
   * the duplication outweighs the culling. Measured on rally (150 units, 48
   * segments): 6 patches submit 5,083 triangles where 9 submit 8,485. A rule
   * keyed on triangle count alone gets this backwards — what decides it is the
   * FRACTION of the terrain the camera can see, which depends on the far plane
   * and is not knowable here. An automatic split wants the camera; that is a
   * real follow-up, not a guess to ship.
   *
   * Adjacent tiles deliberately OVERLAP by one quad row. Vertex normals are
   * averaged per mesh, so tiles that merely touched would give a boundary
   * vertex a half-neighbourhood on each side and a visible lighting seam; with
   * the overlap every boundary vertex has its full ring in both tiles and the
   * normals come out identical. The shared quads are drawn twice — same depth,
   * same shading, and a few percent of overdraw buys the fidelity.
   *
   * Fidelity is very close but not bit-exact: a tile derives its vertex
   * positions from its own span and then rides a translated node, so the
   * rounding differs from the single mesh's. Measured against the untiled
   * render at 6 tiles: 7% of pixels differ, by at most 2/255.
   */
  tiles?: number;

  /**
   * Called with the sampled grid just before it becomes geometry.
   *
   * PLAYSET ADDITION (no GameBlocks counterpart): a native sim core cannot
   * re-derive these heights and land on the same surface — the procedural
   * samplers hash through `sin`, which is a different function in f32 than in
   * f64 — so a car would drive on ground that is not the ground being drawn.
   * Handing the grid over lets the sim sample exactly what is on screen.
   */
  onGrid?: (grid: TerrainGrid) => void;
}

export function createTerrainMesh({
  scene,
  terrainSampler,
  size = 184,
  segments = 220,
  materialOptions = {},
  tiles = 1,
  onGrid,
}: CreateTerrainMeshOptions): SceneNode {
  void materialOptions;
  if (!terrainSampler || typeof terrainSampler.sample !== "function") {
    throw new Error("createTerrainMesh: terrainSampler.sample(right, forward) is required");
  }

  const safeSize = Math.max(0.001, size);
  const safeSegments = Math.max(1, Math.floor(segments));
  const vertexSide = safeSegments + 1;
  const vertexCount = vertexSide * vertexSide;
  const heights = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);
  const halfSize = safeSize * 0.5;
  const step = safeSize / safeSegments;

  for (let row = 0; row <= safeSegments; row += 1) {
    for (let col = 0; col <= safeSegments; col += 1) {
      const i = row * vertexSide + col;
      const right = -halfSize + col * step;
      const forward = -halfSize + row * step;
      const sample = terrainSampler.sample(right, forward) ?? { height: 0 };
      const height = sample.height;
      heights[i] = height;

      let colorValue = "color" in sample ? sample.color : null;
      if (!colorValue) {
        const colorNoise = typeof terrainSampler.noise2D === "function"
          ? terrainSampler.noise2D(right * 0.21 + 13, forward * 0.21 - 5, 103) * 0.08
          : 0;
        colorValue = defaultTerrainColor(height, colorNoise);
      }

      colors[i * 3 + 0] = colorValue.r;
      colors[i * 3 + 1] = colorValue.g;
      colors[i * 3 + 2] = colorValue.b;
    }
  }

  onGrid?.({ size: safeSize, side: vertexSide, heights });

  const matId = scene.material(rgbToAbgr(0xffffff), MAT.vertexColors);
  const tileCount = Math.max(1, Math.min(Math.floor(tiles), safeSegments));
  if (tileCount === 1) {
    const geomId = scene.heightfield(safeSize, safeSize, vertexSide, vertexSide, heights, colors);
    return scene.mesh(geomId, matId);
  }

  // Quad ranges per tile, overlapping by one row/column so boundary vertices
  // keep a complete neighbourhood (see `tiles` above).
  const group = scene.node();
  for (let tz = 0; tz < tileCount; tz += 1) {
    for (let tx = 0; tx < tileCount; tx += 1) {
      const q0x = Math.max(0, Math.floor((tx * safeSegments) / tileCount) - (tx > 0 ? 1 : 0));
      const q1x = Math.min(safeSegments, Math.ceil(((tx + 1) * safeSegments) / tileCount));
      const q0z = Math.max(0, Math.floor((tz * safeSegments) / tileCount) - (tz > 0 ? 1 : 0));
      const q1z = Math.min(safeSegments, Math.ceil(((tz + 1) * safeSegments) / tileCount));
      const nx = q1x - q0x + 1;
      const nz = q1z - q0z + 1;
      if (nx < 2 || nz < 2) continue;

      const tileHeights = new Float32Array(nx * nz);
      const tileColors = new Float32Array(nx * nz * 3);
      for (let r = 0; r < nz; r += 1) {
        for (let c = 0; c < nx; c += 1) {
          const src = (q0z + r) * vertexSide + (q0x + c);
          const dst = r * nx + c;
          tileHeights[dst] = heights[src];
          tileColors[dst * 3 + 0] = colors[src * 3 + 0];
          tileColors[dst * 3 + 1] = colors[src * 3 + 1];
          tileColors[dst * 3 + 2] = colors[src * 3 + 2];
        }
      }

      // `heightfield` centres its mesh on the origin, so each tile rides a
      // node translated to the centre of the span it covers.
      const geomId = scene.heightfield(
        (nx - 1) * step,
        (nz - 1) * step,
        nx,
        nz,
        tileHeights,
        tileColors,
      );
      const node = scene.mesh(geomId, matId, group);
      // Columns run along +X, but ROWS run along -Z (geomHeightfield puts row
      // 0 at +d/2, which is where the sampler's first `forward` row belongs),
      // so the two offsets carry opposite signs.
      node.position.set(
        -halfSize + (q0x + (nx - 1) / 2) * step,
        0,
        halfSize - (q0z + (nz - 1) / 2) * step,
      );
    }
  }
  return group;
}

/**
 * The CollisionWorld replacement for the Rapier terrain trimesh: the sampler
 * itself becomes the ground authority (world.setTerrain). Friction and
 * restitution have no CollisionWorld analog.
 */
export function registerTerrainCollider(world: CollisionWorld, sampler: TerrainLike): void {
  if (!world) {
    throw new Error("registerTerrainCollider: a CollisionWorld is required");
  }
  if (!sampler || typeof sampler.heightAt !== "function") {
    throw new Error("registerTerrainCollider: sampler.heightAt(right, forward) is required");
  }
  world.setTerrain(sampler);
}
