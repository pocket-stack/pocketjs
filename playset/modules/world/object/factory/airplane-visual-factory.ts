// playset/modules/world/object/factory/airplane-visual-factory.ts — the
// jet-fighter airframe: fuselage, nose, canopy, wings, tail, engines, jet
// flames, optional debug centroid + target ring.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/factory/AirplaneVisualFactory.js.
// Deliberate changes for the scene3d surface:
//   - emissive/metalness/roughness options are accepted for API parity but
//     ignored (fixed-function lighting); canopy transparency folds the
//     opacity into the material's ABGR alpha. Cast-shadow flags dropped
//     (blob decals — world/blob-shadow.ts).
//   - part rotations (rotation.x = ±π/2) are node quaternions (geometry ops
//     take no transforms).
//   - the airframe recenter used Box3.setFromObject (vertex-sampled AABB);
//     the sim never tessellates, so the recenter is the analytic-primitive
//     AABB center folded to a constant: (0, 0.315, -0.4525) — within <2% of
//     a part radius of three's value, canopy on or off (it never touches
//     the bounds; the AABB is computed before flames/glow, like the
//     original).
//   - centroid marker's depthTest:false/renderOrder and node names
//     (PlaneCentroidMarker / targetRingName) have no scene3d analog;
//     targetRingName is accepted and ignored.

import { Euler } from "../../../../math/euler.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../../scene3d/client.ts";
import { JetFlameLocalVisual } from "../../visual-effects/jet-flame.ts";
import { rgbToAbgr } from "../../color-utils.ts";

export interface AirplaneVisualOptions {
  scale?: number;
  bodyColor?: number;
  bodyEmissive?: number;
  bodyEmissiveIntensity?: number;
  bodyMetalness?: number;
  bodyRoughness?: number;
  accentColor?: number;
  accentEmissive?: number;
  accentEmissiveIntensity?: number;
  accentMetalness?: number;
  accentRoughness?: number;
  canopyColor?: number;
  canopyEmissive?: number;
  canopyEmissiveIntensity?: number;
  canopyOpacity?: number;
  showCanopy?: boolean;
  showJetFlames?: boolean;
  showEngineGlow?: boolean;
  engineGlowColor?: number;
  engineGlowOpacity?: number;
  showCentroid?: boolean;
  centroidColor?: number;
  showTargetRing?: boolean;
  targetRingName?: string;
  targetRingColor?: number;
  targetRingRadius?: number;
  targetRingTube?: number;
  targetRingOpacity?: number;
}

export interface AirplaneVisual {
  group: SceneNode;
  airframe: SceneNode;
  jetFlames: JetFlameLocalVisual[];
  targetRing: SceneNode | null;
}

export function createAirplaneVisual(
  scene: Scene3D,
  {
    scale = 8,
    bodyColor = 0xe1ebf5,
    bodyEmissive = 0x000000,
    bodyEmissiveIntensity = 0,
    bodyMetalness = 0.78,
    bodyRoughness = 0.28,
    accentColor = 0xffa33a,
    accentEmissive = 0x5a2200,
    accentEmissiveIntensity = 0.26,
    accentMetalness = 0.44,
    accentRoughness = 0.42,
    canopyColor = 0x87cefa,
    canopyEmissive = 0x102c4b,
    canopyEmissiveIntensity = 0.4,
    canopyOpacity = 0.9,
    showCanopy = true,
    showJetFlames = true,
    showEngineGlow = false,
    engineGlowColor = 0xffb35b,
    engineGlowOpacity = 0.78,
    showCentroid = false,
    centroidColor = 0xff2bd6,
    showTargetRing = false,
    targetRingName = "AirplaneTargetRing",
    targetRingColor = 0xff775c,
    targetRingRadius = 2.15,
    targetRingTube = 0.035,
    targetRingOpacity = 0.36,
  }: AirplaneVisualOptions = {},
): AirplaneVisual {
  // Standard-material knobs with no fixed-function analog (see header).
  void bodyEmissive; void bodyEmissiveIntensity; void bodyMetalness; void bodyRoughness;
  void accentEmissive; void accentEmissiveIntensity; void accentMetalness; void accentRoughness;
  void canopyEmissive; void canopyEmissiveIntensity; void targetRingName;

  const group = scene.node();
  const airframe = scene.node(group);

  const bodyMaterial = scene.material(rgbToAbgr(bodyColor), 0);
  const accentMaterial = scene.material(rgbToAbgr(accentColor), 0);
  const canopyMaterial = scene.material(rgbToAbgr(canopyColor, canopyOpacity), MAT.transparent);

  const noseward = new Euler(-Math.PI / 2, 0, 0); // cylinder/cone head +Y → -Z
  const tailward = new Euler(Math.PI / 2, 0, 0);

  const fuselage = scene.mesh(scene.cylinder(0.28, 0.36, 3.6, 18), bodyMaterial, airframe);
  fuselage.quaternion.setFromEuler(noseward);

  const nose = scene.mesh(scene.cone(0.28, 0.96, 18), accentMaterial, airframe);
  nose.quaternion.setFromEuler(noseward);
  nose.position.z = -2.25;

  if (showCanopy) {
    const canopy = scene.mesh(scene.sphere(0.32, 16), canopyMaterial, airframe);
    canopy.scale.set(1.05, 0.7, 1.8);
    canopy.position.set(0, 0.25, -0.35);
  }

  const wing = scene.mesh(scene.box(1.55, 0.05, 0.38), bodyMaterial, airframe); // (3.1, 0.1, 0.76)
  wing.position.set(0, -0.02, 0.16);

  const wingTip = scene.mesh(scene.box(1.8, 0.02, 0.1), accentMaterial, airframe); // (3.6, 0.04, 0.2)
  wingTip.position.set(0, 0.06, -0.04);

  const tailWing = scene.mesh(scene.box(0.67, 0.04, 0.21), bodyMaterial, airframe); // (1.34, 0.08, 0.42)
  tailWing.position.set(0, 0.28, 1.22);

  const tailFin = scene.mesh(scene.box(0.04, 0.43, 0.28), accentMaterial, airframe); // (0.08, 0.86, 0.56)
  tailFin.position.set(0, 0.56, 1.18);

  const engineGeometry = scene.cylinder(0.14, 0.19, 1.15, 12);
  for (const side of [-1, 1]) {
    const engine = scene.mesh(engineGeometry, bodyMaterial, airframe);
    engine.quaternion.setFromEuler(tailward);
    engine.position.set(side * 0.34, -0.1, 1.25);
  }

  // Box3.setFromObject center, analytic (see header): parts span
  // x ±1.8, y [-0.36, 0.99], z [-2.73, 1.825] → center (0, 0.315, -0.4525).
  airframe.position.set(0, -0.315, 0.4525);

  const jetFlames: JetFlameLocalVisual[] = [];
  if (showJetFlames) {
    const flameLeft = new JetFlameLocalVisual(scene);
    const flameRight = new JetFlameLocalVisual(scene);
    flameLeft.group.position.set(-0.34, -0.1, 1.78);
    flameRight.group.position.set(0.34, -0.1, 1.78);
    airframe.add(flameLeft.group);
    airframe.add(flameRight.group);
    jetFlames.push(flameLeft, flameRight);
  }

  if (showEngineGlow) {
    const glowMaterial = scene.material(
      rgbToAbgr(engineGlowColor, engineGlowOpacity),
      MAT.transparent,
    );
    for (const side of [-1, 1]) {
      const glow = scene.mesh(scene.sphere(0.12, 10), glowMaterial, airframe);
      glow.position.set(side * 0.32, -0.1, 1.82);
    }
  }

  if (showCentroid) {
    scene.mesh(
      scene.sphere(0.09, 16),
      scene.material(rgbToAbgr(centroidColor), MAT.unlit),
      group,
    );
  }

  let targetRing: SceneNode | null = null;
  if (showTargetRing) {
    targetRing = scene.mesh(
      scene.torus(targetRingRadius, targetRingTube, 8, 36),
      scene.material(rgbToAbgr(targetRingColor, targetRingOpacity), MAT.unlit | MAT.transparent),
      group,
    );
  }

  group.scale.setScalar(scale);

  return {
    group,
    airframe,
    jetFlames,
    targetRing,
  };
}
