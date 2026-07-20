// playset/test/camera.test.ts — camera rigs: offset relationships, dt-stable
// smoothing, look-offset recentering, applyToCamera against a Camera3D-shaped
// structural double, and a determinism golden.

import { describe, expect, test } from "bun:test";
import { Quaternion, Vector3 } from "../math/index.ts";
import { DEFAULT_WORLD_BASIS } from "../modules/math/world-basis.ts";
import {
  BaseCameraRig,
  CAMERA_HEIGHT_SOURCES,
  CAMERA_ROTATION_MODES,
  type CameraLike,
} from "../modules/camera/base-camera-rig.ts";
import { PositionFollowCameraRig } from "../modules/camera/position-follow-camera-rig.ts";
import { PoseFollowCameraRig } from "../modules/camera/pose-follow-camera-rig.ts";
import { FirstPersonCameraRig } from "../modules/camera/first-person-camera-rig.ts";
import { LookOffsetCameraRig } from "../modules/camera/look-offset-camera-rig.ts";

const close = (v: number, e: number, digits = 10) => expect(v).toBeCloseTo(e, digits);
const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

const IDENTITY_FRAME = {
  forward: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
};

describe("BaseCameraRig", () => {
  test("construction seeds basis-aligned pose", () => {
    const rig = new BaseCameraRig({});
    expect(rig.initialized).toBe(false);
    expect(rig.forward.toArray()).toEqual([0, 0, -1]);
    expect(rig.right.toArray()).toEqual([1, 0, 0]);
    expect(rig.up.toArray()).toEqual([0, 1, 0]);
    expect(rig.rotationMode).toBe(CAMERA_ROTATION_MODES.lookAt);
  });

  test("setState marks initialized and normalizes axes", () => {
    const rig = new BaseCameraRig({});
    rig.setState({ position: { x: 1, y: 2, z: 3 }, forward: { x: 0, y: 0, z: -9 } });
    expect(rig.initialized).toBe(true);
    expect(rig.position.toArray()).toEqual([1, 2, 3]);
    expect(rig.forward.toArray()).toEqual([0, 0, -1]);
  });

  test("applyToCamera drives a Camera3D-shaped double in lookAt mode", () => {
    // Structurally identical to scene3d Camera3D: position/quaternion/lookAt, no up.
    const seen: Vector3[] = [];
    const camera: CameraLike = {
      position: new Vector3(),
      quaternion: new Quaternion(),
      lookAt(target: Vector3) {
        seen.push(target.clone());
        return camera;
      },
    };
    const rig = new FirstPersonCameraRig({});
    const pose = rig.step({ targetPosition: { x: 1, y: 0, z: 2 }, targetFrame: IDENTITY_FRAME, camera });
    expect(camera.position.toArray()).toEqual(pose.position.toArray());
    expect(seen.length).toBe(1);
    expect(seen[0].toArray()).toEqual(pose.lookAt.toArray());
  });

  test("applyToCamera frame mode writes the quaternion (no lookAt needed)", () => {
    const camera: CameraLike = { position: new Vector3(), quaternion: new Quaternion() };
    const rig = new PoseFollowCameraRig({
      cameraOffset: { forward: -6, up: 3, right: 0 },
      rotationMode: CAMERA_ROTATION_MODES.frame,
    });
    const frame = DEFAULT_WORLD_BASIS.yawPitchRollFrame(0.6);
    const pose = rig.step({ targetPosition: { x: 0, y: 0, z: 0 }, targetFrame: frame, camera });
    // Camera-local -Z must land on the pose forward.
    const viewDir = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    close(viewDir.x, pose.forward.x);
    close(viewDir.y, pose.forward.y);
    close(viewDir.z, pose.forward.z);
    expect(camera.position.toArray()).toEqual(pose.position.toArray());
  });
});

describe("PositionFollowCameraRig", () => {
  test("keeps a fixed world offset from the target (azimuth 0)", () => {
    const rig = new PositionFollowCameraRig({});
    for (const focus of [new Vector3(10, 2, -5), new Vector3(-3, 7, 40)]) {
      const pose = rig.step({ targetPosition: focus, snapToTarget: true });
      // viewDirection is world forward (0,0,-1); camera sits distance behind, height above.
      close(pose.position.x - focus.x, 0);
      close(pose.position.y - focus.y, 16);
      close(pose.position.z - focus.z, 18);
      expect(pose.lookAt.toArray()).toEqual(focus.toArray());
    }
  });

  test("lagged position converges onto the fixed offset", () => {
    const rig = new PositionFollowCameraRig({ positionLag: 0.2, lookLag: 0.2 });
    rig.step({ targetPosition: { x: 0, y: 0, z: 0 } }); // first step snaps
    const focus = { x: 20, y: 0, z: -30 };
    let pose = rig.getPose();
    for (let i = 0; i < 400; i += 1) {
      pose = rig.step({ targetPosition: focus, deltaSeconds: 1 / 60 });
    }
    close(pose.position.x, 20, 3);
    close(pose.position.y, 16, 3);
    close(pose.position.z, -12, 3);
    close(pose.lookAt.x, 20, 3);
    close(pose.lookAt.z, -30, 3);
  });

  test("smoothing is dt-stable: two half steps equal one full step", () => {
    const make = () => new PositionFollowCameraRig({ positionLag: 0.4, lookLag: 0.4 });
    const a = make();
    const b = make();
    const t0 = { x: 0, y: 0, z: 0 };
    a.step({ targetPosition: t0 });
    b.step({ targetPosition: t0 });
    const t1 = { x: 12, y: 0, z: -8 };
    a.step({ targetPosition: t1, deltaSeconds: 1 / 30 });
    b.step({ targetPosition: t1, deltaSeconds: 1 / 60 });
    const pb = b.step({ targetPosition: t1, deltaSeconds: 1 / 60 });
    const pa = a.getPose();
    close(pa.position.x, pb.position.x);
    close(pa.position.y, pb.position.y);
    close(pa.position.z, pb.position.z);
    close(pa.lookAt.x, pb.lookAt.x);
    close(pa.lookAt.z, pb.lookAt.z);
  });
});

describe("PoseFollowCameraRig", () => {
  test("offset rotates with the target frame", () => {
    const rig = new PoseFollowCameraRig({ cameraOffset: { forward: -6, up: 3, right: 0 } });
    // Frame A: forward -z. Camera sits 6 behind, 3 up.
    let pose = rig.step({
      targetPosition: { x: 0, y: 0, z: 0 },
      targetFrame: IDENTITY_FRAME,
      snapToTarget: true,
    });
    close(pose.position.x, 0);
    close(pose.position.y, 3);
    close(pose.position.z, 6);
    close(pose.lookAt.z, -1); // lookAtOffset default: 1 unit ahead

    // Frame B: forward -x (yaw +90deg). Same local offset, rotated with the frame.
    pose = rig.step({
      targetPosition: { x: 0, y: 0, z: 0 },
      targetFrame: { forward: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
      snapToTarget: true,
    });
    close(pose.position.x, 6);
    close(pose.position.y, 3);
    close(pose.position.z, 0);
    close(pose.lookAt.x, -1);
  });

  test("speed offsets scale with target speed", () => {
    const rig = new PoseFollowCameraRig({
      cameraOffset: { forward: -6, up: 3, right: 0 },
      speedCameraOffset: { forward: -0.5, up: 0.1, right: 0 },
    });
    const pose = rig.step({
      targetPosition: { x: 0, y: 0, z: 0 },
      targetFrame: IDENTITY_FRAME,
      targetSpeed: 10,
      snapToTarget: true,
    });
    close(pose.position.z, 11); // forward -11 along -z
    close(pose.position.y, 4); // up 3 + 0.1*10
  });

  test("lagged pose converges to the frame-relative offset", () => {
    const rig = new PoseFollowCameraRig({
      cameraOffset: { forward: -6, up: 3, right: 0 },
      positionLag: 0.25,
      lookLag: 0.25,
      frameLag: 0.25,
    });
    const frame = { forward: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
    rig.step({ targetPosition: { x: 0, y: 0, z: 0 }, targetFrame: IDENTITY_FRAME });
    let pose = rig.getPose();
    for (let i = 0; i < 500; i += 1) {
      pose = rig.step({ targetPosition: { x: 5, y: 0, z: 0 }, targetFrame: frame, deltaSeconds: 1 / 60 });
    }
    close(pose.position.x, 11, 4);
    close(pose.position.y, 3, 4);
    close(pose.position.z, 0, 4);
    // lookAt mode: setLookAtPose re-derives pose.forward as the camera->lookAt
    // view direction (the original overwrites the frame-lagged forward too).
    close(pose.lookAt.x, 4, 4);
    close(pose.lookAt.y, 0, 4);
    const len = Math.hypot(11 - 4, 3);
    close(pose.forward.x, -7 / len, 4);
    close(pose.forward.y, -3 / len, 4);
  });

  test("determinism golden: two fresh rigs replay to the same snapshot", () => {
    const run = () => {
      const rig = new PoseFollowCameraRig({
        cameraOffset: { forward: -8, up: 4, right: 1 },
        positionLag: 0.3,
        lookLag: 0.2,
        frameLag: 0.4,
      });
      const frames: string[] = [];
      for (let t = 0; t < 60; t += 1) {
        const pose = rig.step({
          targetPosition: { x: Math.cos(t * 0.1) * 10, y: 0, z: -t },
          targetFrame: DEFAULT_WORLD_BASIS.yawPitchRollFrame(t * 0.05),
          targetSpeed: t * 0.2,
          deltaSeconds: 1 / 60,
        });
        frames.push(
          JSON.stringify(
            [...pose.position.toArray(), ...pose.lookAt.toArray(), ...pose.forward.toArray()].map(round9),
          ),
        );
      }
      return frames.join("\n");
    };
    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toBe(first);
  });
});

describe("FirstPersonCameraRig", () => {
  test("locks to eye position + forward look target", () => {
    const rig = new FirstPersonCameraRig({});
    const pose = rig.step({ targetPosition: { x: 1, y: 0, z: 2 }, targetFrame: IDENTITY_FRAME });
    close(pose.position.x, 1);
    close(pose.position.y, 1.72);
    close(pose.position.z, 2);
    close(pose.lookAt.x, 1);
    close(pose.lookAt.y, 1.72);
    close(pose.lookAt.z, 1); // lookDistance 1 along forward
    close(pose.forward.z, -1);
  });

  test("height vector source: frameUp tilts the eye, basisUp does not", () => {
    const tiltedFrame = { forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 0.6, z: 0.8 } };
    const frameUpRig = new FirstPersonCameraRig({});
    const basisUpRig = new FirstPersonCameraRig({ heightVectorSource: CAMERA_HEIGHT_SOURCES.basisUp });
    const a = frameUpRig.step({ targetPosition: { x: 0, y: 0, z: 0 }, targetFrame: tiltedFrame });
    const b = basisUpRig.step({ targetPosition: { x: 0, y: 0, z: 0 }, targetFrame: tiltedFrame });
    close(a.position.y, 1.72 * 0.6);
    close(a.position.z, 1.72 * 0.8);
    close(b.position.y, 1.72);
    close(b.position.z, 0);
  });
});

describe("LookOffsetCameraRig", () => {
  test("active look accumulates yaw/pitch through sensitivity, pitch clamps", () => {
    const rig = new LookOffsetCameraRig({});
    rig.step({ targetPosition: { x: 0, y: 0, z: 0 }, lookActive: true, lookDeltaX: 200, lookDeltaY: 100 });
    close(rig.cameraYaw, 200 * 0.0035);
    close(rig.cameraPitch, 100 * 0.0035);
    rig.setLook(0, 99);
    close(rig.cameraPitch, 1.4835);
  });

  test("recenters after input stops: exponential decay back to zero offset", () => {
    const rig = new LookOffsetCameraRig({});
    const target = { x: 0, y: 0, z: 0 };
    rig.step({ targetPosition: target, lookActive: true, lookDeltaX: 200, lookDeltaY: 100 });
    const yaw0 = rig.cameraYaw;
    const pitch0 = rig.cameraPitch;

    // One inactive step decays by exactly e^(-dt/returnLag).
    rig.step({ targetPosition: target, deltaSeconds: 1 / 60 });
    const keep = Math.exp(-(1 / 60) / 0.17);
    close(rig.cameraYaw, yaw0 * keep);
    close(rig.cameraPitch, pitch0 * keep);

    // Strictly monotone decay, then effectively recentered.
    let prevYaw = Math.abs(rig.cameraYaw);
    for (let i = 0; i < 300; i += 1) {
      rig.step({ targetPosition: target, deltaSeconds: 1 / 60 });
      const now = Math.abs(rig.cameraYaw);
      expect(now).toBeLessThan(prevYaw);
      prevYaw = now;
    }
    expect(Math.abs(rig.cameraYaw)).toBeLessThan(1e-3);
    expect(Math.abs(rig.cameraPitch)).toBeLessThan(1e-3);

    // Recentered pose: camera sits distance straight behind the target.
    const pose = rig.step({ targetPosition: target, deltaSeconds: 1 / 60 });
    close(pose.position.x, 0, 3);
    close(pose.position.y, 0, 3);
    close(pose.position.z, 20, 3);
    expect(pose.lookAt.toArray()).toEqual([0, 0, 0]);
  });

  test("look offset rotates the camera around the target", () => {
    const rig = new LookOffsetCameraRig({ lookSensitivity: 1 });
    // One active step of yaw +pi/2: camera swings to the target's side.
    const pose = rig.step({
      targetPosition: { x: 0, y: 0, z: 0 },
      lookActive: true,
      lookDeltaX: Math.PI / 2,
    });
    // frame yaw pi/2 -> back = (-1,0,0)... back = -forward, forward = (-sin(yaw))*right + cos(yaw)*forwardAxis
    close(pose.position.x, 20);
    close(pose.position.z, 0);
    close(rig.cameraYaw, Math.PI / 2);
  });
});
