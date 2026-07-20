// playset/modules/user-interface/minimap-projector-2d.ts — pure world→minimap
// projection: planar bounds to viewport pixels, yaw to map rotation.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/MinimapProjector2D.js. Verbatim semantics.

import { clamp01 } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";

export interface Point2D {
  x: number;
  y: number;
}

export interface PlanarBounds {
  minRight: number;
  maxRight: number;
  minForward: number;
  maxForward: number;
}

export type PositiveForwardDirection = "down" | "up";

// One shared planar scratch for project()/projectYaw(). The original relied on
// toPlanar()'s default `{ right, forward }` literal, which allocated on every
// projected dot; the rally HUD does that ~12 times per refresh at 10 Hz and
// QuickJS pays for all of it. Both readers consume the pair synchronously and
// never hold it, so one buffer is enough.
const PLANAR_SCRATCH = { right: 0, forward: 0 };

export function projectRelativePlanar(
  right: number,
  forward: number,
  originRight = 0,
  originForward = 0,
  range = 1,
  width = 1,
  height = 1,
  positiveForwardDirection: PositiveForwardDirection = "down",
  out: Point2D = { x: 0, y: 0 },
): Point2D {
  const safeRange = Math.max(1e-6, range);
  const halfWidth = Math.max(0, width) * 0.5;
  const halfHeight = Math.max(0, height) * 0.5;
  const forwardSign = positiveForwardDirection === "up" ? -1 : 1;

  out.x = halfWidth + ((right - originRight) / safeRange) * halfWidth;
  out.y = halfHeight + forwardSign * ((forward - originForward) / safeRange) * halfHeight;
  return out;
}

export interface MinimapProjector2DOptions {
  planarBounds: PlanarBounds;
  width?: number;
  height?: number;
  padding?: number;
  invertRight?: boolean;
  invertForward?: boolean;
  basis?: WorldBasis;
}

export interface OrthoFrustum {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export class MinimapProjector2D {
  planarBounds: PlanarBounds;
  width: number;
  height: number;
  padding: number;
  invertRight: boolean;
  invertForward: boolean;
  basis: WorldBasis;

  constructor({
    planarBounds: { minRight, maxRight, minForward, maxForward },
    width = 200,
    height = 200,
    padding = 0,
    invertRight = false,
    invertForward = false,
    basis = DEFAULT_WORLD_BASIS,
  }: MinimapProjector2DOptions) {
    this.planarBounds = { minRight, maxRight, minForward, maxForward };
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.padding = Math.max(0, padding);
    this.invertRight = Boolean(invertRight);
    this.invertForward = Boolean(invertForward);
    this.basis = basis;
  }

  setPlanarBounds(minRight: number, maxRight: number, minForward: number, maxForward: number): this {
    this.planarBounds.minRight = minRight;
    this.planarBounds.maxRight = maxRight;
    this.planarBounds.minForward = minForward;
    this.planarBounds.maxForward = maxForward;
    return this;
  }

  setPlanarBoundsFromCenterSize(
    centerRight: number,
    centerForward: number,
    spanRight: number,
    spanForward: number,
  ): this {
    this.planarBounds.minRight = centerRight - spanRight * 0.5;
    this.planarBounds.maxRight = centerRight + spanRight * 0.5;
    this.planarBounds.minForward = centerForward - spanForward * 0.5;
    this.planarBounds.maxForward = centerForward + spanForward * 0.5;
    return this;
  }

  setViewport(width: number = this.width, height: number = this.height, padding: number = this.padding): this {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.padding = Math.max(0, padding);
    return this;
  }

  setInvert(invertRight: boolean = this.invertRight, invertForward: boolean = this.invertForward): this {
    this.invertRight = Boolean(invertRight);
    this.invertForward = Boolean(invertForward);
    return this;
  }

  setBasis(basis: WorldBasis = DEFAULT_WORLD_BASIS): this {
    this.basis = basis;
    return this;
  }

  projectPlanar(right: number, forward: number, out: Point2D = { x: 0, y: 0 }): Point2D {
    const rangeRight = Math.max(1e-6, this.planarBounds.maxRight - this.planarBounds.minRight);
    const rangeForward = Math.max(1e-6, this.planarBounds.maxForward - this.planarBounds.minForward);
    const normalizedRight = clamp01((right - this.planarBounds.minRight) / rangeRight);
    const normalizedForward = clamp01((forward - this.planarBounds.minForward) / rangeForward);
    const drawableWidth = Math.max(0, this.width - this.padding * 2);
    const drawableHeight = Math.max(0, this.height - this.padding * 2);

    out.x = this.padding + (this.invertRight ? 1 - normalizedRight : normalizedRight) * drawableWidth;
    out.y = this.padding + (this.invertForward ? normalizedForward : 1 - normalizedForward) * drawableHeight;
    return out;
  }

  project(worldPosition: VecLike | null | undefined, out: Point2D = { x: 0, y: 0 }): Point2D {
    const planar = this.basis.toPlanar(worldPosition, PLANAR_SCRATCH);
    return this.projectPlanar(planar.right, planar.forward, out);
  }

  projectYaw(forwardVector: VecLike | null | undefined): number {
    const planar = this.basis.toPlanar(forwardVector, PLANAR_SCRATCH);
    const right = planar.right;
    const forward = planar.forward;
    const mapDx = (this.invertRight ? -1 : 1) * right;
    const mapDy = (this.invertForward ? 1 : -1) * forward;
    return Math.atan2(mapDx, -mapDy);
  }

  projectPath(path: (VecLike | null | undefined)[] = []): Point2D[] {
    return path.map((point) => this.project(point, { x: 0, y: 0 }));
  }

  getOrthoFrustumFromBounds(): OrthoFrustum {
    return {
      left: this.planarBounds.minRight,
      right: this.planarBounds.maxRight,
      top: this.planarBounds.maxForward,
      bottom: this.planarBounds.minForward,
    };
  }
}
