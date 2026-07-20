// playset/modules/world/visual-effects/jet-flame.ts — throttle/boost-driven
// engine exhaust flame (airplane engines).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/visual-effects/JetFlame.js. The original was a
// ShaderMaterial (radial glow, shock diamonds, hash-noise flicker) on an
// open cylinder — none of that survives a fixed-function surface. The
// documented approximation instead:
//   - two nested additive unlit cones (bright warm core inside a dimmer
//     colored outer sheath), extending +Z from the nozzle like the original
//     pre-rotated geometry (translate(0,-1,0) + rotateX(-π/2) baked into
//     child-node quaternions/positions — geometry ops take no transforms).
//   - step() keeps the EXACT boostFactor smoothing and scale formulas:
//     s = (1-boost)·(0.6+throttle·1.2) + boost·2.2, width = 1.1 +
//     max(throttle,boost)·0.4.
//   - color shifts 0xff7722 → 0x9999ff by boostFactor via nodeSetTint;
//     the shader's noise flicker becomes a deterministic ±18% sine on
//     timeSeconds (NOT prng) modulating the outer tint's RGB.
//   - the PointLight (0xffaa44, throttle/boost-tracked intensity) has no
//     scene3d analog and is dropped.
//   - constructor gains `scene: Scene3D` (nodes need an owner).

import { Color, SRGBColorSpace, type RGB } from "../../../math/color.ts";
import { Euler } from "../../../math/euler.ts";
import type { Scene3D, SceneNode } from "../../../scene3d/client.ts";
import { rgbFloatsToAbgr, rgbToAbgr } from "../color-utils.ts";

export interface JetFlameStepState {
  throttle: number;
  isBoosting: boolean;
  timeSeconds: number;
  deltaSeconds?: number;
}

export class JetFlameLocalVisual {
  readonly group: SceneNode;
  /** Scale target — the original flame mesh's analog (cones are children). */
  readonly flame: SceneNode;
  boostFactor: number;
  readonly cNormal: Color;
  readonly cBoost: Color;

  private readonly outer: SceneNode;
  private readonly core: SceneNode;
  private readonly _tint = new Color();
  private readonly _rgb: RGB = { r: 0, g: 0, b: 0 };

  constructor(scene: Scene3D) {
    this.group = scene.node();
    this.flame = scene.node(this.group);

    // Original geometry: CylinderGeometry(0.15, 0.03, 2, …, openEnded),
    // wide end at the nozzle (local origin), tip trailing to +Z 2.
    const along = new Euler(Math.PI * 0.5, 0, 0); // +Y → +Z
    this.outer = scene.mesh(
      scene.cylinder(0.03, 0.15, 2, 12),
      scene.additiveMaterial(rgbToAbgr(0xffffff)),
      this.flame,
    );
    this.outer.quaternion.setFromEuler(along);
    this.outer.position.z = 1;
    this.outer.setTint(rgbToAbgr(0xff7722));

    this.core = scene.mesh(
      scene.cylinder(0.012, 0.075, 1.3, 10),
      scene.additiveMaterial(rgbToAbgr(0xfff2e0)), // coreColor (1, 1, 0.95)-ish
      this.flame,
    );
    this.core.quaternion.setFromEuler(along);
    this.core.position.z = 0.65;

    this.boostFactor = 0;
    this.cNormal = new Color(0xff7722);
    this.cBoost = new Color(0x9999ff);
  }

  step({ throttle, isBoosting, timeSeconds, deltaSeconds = 1 / 60 }: JetFlameStepState): void {
    const targetBoost = isBoosting ? 1.0 : 0.0;
    const boostSpeed = 5.0;
    this.boostFactor += (targetBoost - this.boostFactor) * Math.min(deltaSeconds * boostSpeed, 1.0);

    const s = (1.0 - this.boostFactor) * (0.6 + throttle * 1.2) + this.boostFactor * 2.2;

    const effectiveThrottle = Math.max(throttle, this.boostFactor);
    const widthScale = 1.1 + effectiveThrottle * 0.4;
    this.flame.scale.set(widthScale, widthScale, s);

    // Shader flicker (1 + 0.18·noise) → deterministic sine on the same
    // time·20 phase, modulating the outer sheath's additive brightness.
    // Colors lerp in the working (linear) space like three, then pack as
    // sRGB bytes — the byte order tint colors are quoted in.
    const flicker = 1 + 0.18 * Math.sin(timeSeconds * 20);
    this._tint.copy(this.cNormal).lerp(this.cBoost, this.boostFactor);
    const rgb = this._tint.getRGB(this._rgb, SRGBColorSpace);
    this.outer.setTint(rgbFloatsToAbgr(rgb.r * flicker, rgb.g * flicker, rgb.b * flicker));
  }
}
