// playset/modules/world/object/fps-weapon-view-model.ts — camera-locked FPS
// weapon viewmodel with offset/sprint/recoil smoothing.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/object/FpsWeaponViewModel.js. Per-frame step()
// math is verbatim. Deliberate changes for the scene3d surface:
//   - constructor options gain `scene: Scene3D` (nodes need an owner).
//   - depthTest:false + renderOrder 9999 (always-on-top overlay) have no v1
//     analog: the group renders as ordinary nodes — overlay depth pass
//     pending native core. Materials stay unlit (MeshBasicMaterial parity).
//   - The barrel's rotation.x is a node quaternion (geometry ops don't take
//     transforms).

import { Euler } from "../../../math/euler.ts";
import { MathUtils } from "../../../math/math-utils.ts";
import { Quaternion } from "../../../math/quaternion.ts";
import { Vector3 } from "../../../math/vector3.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../scene3d/client.ts";
import { DEFAULT_PRNG } from "../../math/random-utils.ts";
import { clamp, smoothingAlpha } from "../../math/scalar-utils.ts";
import { rgbToAbgr } from "../color-utils.ts";
import { disposeSceneNode } from "../scene-node-utils.ts";

function createWeaponLocalMesh(scene: Scene3D): SceneNode {
  const group = scene.node();
  const bodyMat = scene.material(rgbToAbgr(0x232a35), MAT.unlit);
  const accentMat = scene.material(rgbToAbgr(0x8ea8c6), MAT.unlit);

  scene.mesh(scene.box(0.08, 0.06, 0.21), bodyMat, group); // BoxGeometry(0.16, 0.12, 0.42)
  const slide = scene.mesh(scene.box(0.06, 0.03, 0.12), accentMat, group); // (0.12, 0.06, 0.24)
  slide.position.set(0, 0.07, 0.05);

  // The mesh is authored in viewmodel-local space, where +Z is backward.
  const barrel = scene.mesh(scene.cylinder(0.022, 0.022, 0.28, 12), accentMat, group);
  barrel.quaternion.setFromEuler(new Euler(Math.PI * 0.5, 0, 0));
  barrel.position.set(0, -0.015, 0.22);

  return group;
}

/** Structural camera — Camera3D qualifies, and so does any rig pose. */
export interface ViewModelCameraLike {
  position: Vector3;
  quaternion: Quaternion;
}

export interface FpsWeaponViewModelOptions {
  scene: Scene3D;
  normalOffset?: Vector3;
  scopedOffset?: Vector3;
  crouchedOffset?: Vector3;
  offsetLag?: number;
  sprintYaw?: number;
  sprintLag?: number;
  recoilRecoveryLag?: number;
  recoilKickRecoveryLag?: number;
  maxRecoilPitch?: number;
  maxRecoilYaw?: number;
  prng?: { random(): number };
}

export interface FpsWeaponViewModelStepResult {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  recoil: { pitch: number; yaw: number; kick: number };
  sprintYaw: number;
}

// Viewmodel is authored in camera-local space: +X right, +Y up, and -Z forward.
export class FpsWeaponViewModel {
  readonly group: SceneNode;
  readonly normalOffset: Vector3;
  readonly scopedOffset: Vector3;
  readonly crouchedOffset: Vector3;
  readonly offsetLag: number;
  readonly sprintYaw: number;
  readonly sprintLag: number;
  readonly recoilRecoveryLag: number;
  readonly recoilKickRecoveryLag: number;
  readonly maxRecoilPitch: number;
  readonly maxRecoilYaw: number;
  readonly prng: { random(): number };

  readonly state: {
    moving: boolean;
    sprinting: boolean;
    crouching: boolean;
    scoping: boolean;
    onGround: boolean;
  };

  readonly currentOffset: Vector3;
  currentSprintYaw: number;
  readonly recoil: { pitch: number; yaw: number; kick: number };

  private readonly _tmpEuler = new Euler();
  private readonly _tmpQuatBase = new Quaternion();
  private readonly _tmpQuatOffset = new Quaternion();
  private readonly _tmpPos = new Vector3();

  constructor({
    scene,
    normalOffset = new Vector3(0.25, -0.4, -0.25),
    scopedOffset = new Vector3(0.0, -0.21, -0.2),
    crouchedOffset = new Vector3(0.3, -0.55, -0.35),
    offsetLag = 0.10,
    sprintYaw = 1.25,
    sprintLag = 0.5,
    recoilRecoveryLag = 0.08,
    recoilKickRecoveryLag = 0.06,
    maxRecoilPitch = 0.15,
    maxRecoilYaw = 0.03,
    prng = DEFAULT_PRNG,
  }: FpsWeaponViewModelOptions) {
    this.group = createWeaponLocalMesh(scene);

    this.normalOffset = normalOffset.clone();
    this.scopedOffset = scopedOffset.clone();
    this.crouchedOffset = crouchedOffset.clone();
    this.offsetLag = offsetLag;
    this.sprintYaw = sprintYaw;
    this.sprintLag = sprintLag;
    this.recoilRecoveryLag = recoilRecoveryLag;
    this.recoilKickRecoveryLag = recoilKickRecoveryLag;
    this.maxRecoilPitch = maxRecoilPitch;
    this.maxRecoilYaw = maxRecoilYaw;
    this.prng = prng;

    this.state = {
      moving: false,
      sprinting: false,
      crouching: false,
      scoping: false,
      onGround: true,
    };

    this.currentOffset = this.normalOffset.clone();
    this.currentSprintYaw = 0;
    this.recoil = { pitch: 0, yaw: 0, kick: 0 };
  }

  setVisible(visible: boolean): void {
    this.group.visible = Boolean(visible);
  }

  setState(
    moving = this.state.moving,
    sprinting = this.state.sprinting,
    crouching = this.state.crouching,
    scoping = this.state.scoping,
    onGround = this.state.onGround,
  ): void {
    this.state.moving = moving;
    this.state.sprinting = sprinting;
    this.state.crouching = crouching;
    this.state.scoping = scoping;
    this.state.onGround = onGround;
  }

  kick(pitch = 0.03, yawJitter = 0.01, kickback = 0.035): void {
    this.recoil.pitch = clamp(this.recoil.pitch + pitch, 0, this.maxRecoilPitch);
    const yawDelta = (this.prng.random() - 0.5) * yawJitter * 2;
    this.recoil.yaw = clamp(this.recoil.yaw + yawDelta, -this.maxRecoilYaw, this.maxRecoilYaw);
    this.recoil.kick += kickback;
  }

  private _computeTargetOffset(): Vector3 {
    if (this.state.scoping) return this.scopedOffset;
    if (this.state.crouching) return this.crouchedOffset;
    return this.normalOffset;
  }

  private _recoverRecoil(deltaSeconds: number): void {
    const recoilLerp = smoothingAlpha(this.recoilRecoveryLag, deltaSeconds);
    const kickLerp = smoothingAlpha(this.recoilKickRecoveryLag, deltaSeconds);
    this.recoil.pitch = MathUtils.lerp(this.recoil.pitch, 0, recoilLerp);
    this.recoil.yaw = MathUtils.lerp(this.recoil.yaw, 0, recoilLerp);
    this.recoil.kick = MathUtils.lerp(this.recoil.kick, 0, kickLerp);
  }

  step(camera: ViewModelCameraLike, deltaSeconds = 1 / 60): FpsWeaponViewModelStepResult {
    const targetOffset = this._computeTargetOffset();
    this.currentOffset.lerp(targetOffset, smoothingAlpha(this.offsetLag, deltaSeconds));

    const sprintTarget =
      this.state.sprinting && this.state.onGround && !this.state.scoping ? this.sprintYaw : 0;
    this.currentSprintYaw = MathUtils.lerp(
      this.currentSprintYaw,
      sprintTarget,
      smoothingAlpha(this.sprintLag, deltaSeconds),
    );

    this._recoverRecoil(deltaSeconds);

    const offsetX = this.currentOffset.x;
    const offsetY = this.currentOffset.y;
    const offsetZ = this.currentOffset.z - this.recoil.kick;

    // Convert the camera-local offset into world space. Local +Z points
    // backward for the camera, so forward/back offset uses -offsetZ.
    this._tmpPos
      .set(offsetX, offsetY, -offsetZ)
      .applyQuaternion(camera.quaternion)
      .add(camera.position);

    // Recoil and sprint roll are local viewmodel rotations applied after the
    // camera orientation, not world-basis rotations.
    this._tmpEuler.set(-this.recoil.pitch, this.currentSprintYaw - this.recoil.yaw, 0, "XYZ");
    this._tmpQuatOffset.setFromEuler(this._tmpEuler);
    const finalQuat = this._tmpQuatBase.copy(camera.quaternion).multiply(this._tmpQuatOffset);

    this.group.position.copy(this._tmpPos);
    this.group.quaternion.copy(finalQuat);

    return {
      position: { x: this._tmpPos.x, y: this._tmpPos.y, z: this._tmpPos.z },
      quaternion: {
        x: finalQuat.x,
        y: finalQuat.y,
        z: finalQuat.z,
        w: finalQuat.w,
      },
      recoil: { ...this.recoil },
      sprintYaw: this.currentSprintYaw,
    };
  }

  dispose(): void {
    disposeSceneNode(this.group);
  }
}
