# Pocket Fold on iPod touch 4

**Pocket Fold displays a SpringBoard snapshot through a moving glass plane.**
The screenshot stays on the plane defined by the calibrated pose. Core Motion
supplies the device attitude and rotation rate. **All three rotation axes
participate in the projection.** The screen rotates about its center in X/Y
and lifts in Z until its lowest corner touches the screenshot plane. Rays
from a fixed eye pass through the tilted screen and intersect that plane. The distance
between the screen and that plane sets the blur radius and light attenuation.

**This is an app-local effect on a static snapshot.** It does not alter
SpringBoard or forward taps to home-screen icons. The iOS 6 `UIGetScreenImage`
helper captures the composed display: a foreground Pocket app appears in that
capture. Reading it during rendering would capture Pocket Fold's own output.
This implementation does not extract a hidden SpringBoard surface or install
a SpringBoard hook.

## Install and capture

The target is **iPod4,1 running iOS 6.1.6**, with the USB SSH and AppSync setup
described in [IPODTOUCH4.md](IPODTOUCH4.md). Pocket Fold has its own bundle ID,
executable, URL scheme and User container, so it coexists with Pocket Clear.

```sh
export POCKETJS_IPODTOUCH4_APP=fold
export POCKETJS_IPODTOUCH4_UDID=<connected-iPod-UDID>
bun ipodtouch4 doctor
bun ipodtouch4 deploy
```

Unlock the device and leave the desired SpringBoard page visible. Then run:

```sh
bun ipodtouch4 snapshot
bun ipodtouch4 launch
```

The USB-side capture helper saves `dist/ipodtouch4/fold/springboard.png`.
**Black captures are rejected.** The tool bakes the snapshot into eight blur
levels, transfers them to `Documents/fold-textures.bin` in the app's container,
and checks the transferred SHA-256 before replacing the previous snapshot.
The running app loads those textures on its next launch. For an existing
portrait 2:3 screenshot, use `bun ipodtouch4 snapshot /path/to/screenshot.png`.

**Screenshots and baked textures are device data, excluded from the Git
change.** The capture measured on the connected iOS 6 device is 320×480;
Pocket Fold renders into a 640×960 Retina drawable. The baker samples the
source at 320×480. Updating the app preserves the snapshot in Documents.

## Controls

- **Set zero** records the current pose and returns to gyroscope mode.
- **Gyroscope** leaves a manual preview and resumes the calibrated attitude.
- **−15 deg**, **Flat**, and **+15 deg** set a manual preview angle.
- The **solid PocketJS icon** in the top-right corner closes or opens the controls.
  It uses the `site/assets/favicon.svg` artwork in a 44×44 touch target, with
  a filled shell and transparency outside the colored frame.
  `bun apps/duo-fold/bake-icon.ts` produces the 32×32 and 64×64 pack assets.
  The initial panel hides after eight seconds of rendering when a snapshot
  is present.

Hold the iPod in portrait orientation, face the screen head-on, and press
**Set zero**. Then turn, pitch, or roll the iPod while keeping your viewing
position fixed. The reference plane remains fixed until calibration. Core
Motion supplies rotation; it does not track eye position or device translation.
Moving the viewer or translating the device changes the observed alignment.
The angle readout measures the separation between the current and calibrated
screen normals, from 0 to 180 degrees. Manual yaw previews retain their sign.
Home returns to iOS.
The host stops motion updates on resignation of active status and starts a
new reference pose on activation. The app disables auto-lock while open.

## Rendering and service ownership

**The PocketJS Solid guest owns the control panel.** It imports runtime,
components, lifecycle and HostOps from `@pocketjs/framework/*`, and reactive
primitives from `solid-js`. The local `duo-fold` service uses the existing
`svcOpen`, `svcPoll` and `svcSend` operations. Core Motion and GL resources
stay in the native host; the guest receives a state record at ten updates
per second. Each build selects one local or network service provider.

**Core Motion is requested at 100 Hz and sampled once per display frame.**
The host rejects duplicate and stale samples and resolves the attitude matrix
convention against gravity. It preserves the full relative quaternion, predicts
40 ms ahead using all three device-local gyro rates, and interpolates rotations
with an elapsed-time smoothing factor. The projection keeps yaw, pitch, and roll
through the framebuffer Y-axis conversion. It renders black when the screen's
normal faces away from the calibrated viewer. Manual yaw previews are bounded
to ±85 degrees.

**OpenGL ES 1.1 uses projective texture coordinates and at most fifteen
draw calls for the background.** Filled-disk blur levels at radii
0, 2, 4, 8, 12, 20, 30 and 40 points are baked on the Mac. Neighboring levels
are blended according to the gap at each screen position. Convex polygons
follow the two-dimensional gap gradient, including diagonal blur regions.
Blur radius is capped at 40 points, with a final band covering larger gaps. Black padding
provides samples beyond the screenshot's boundaries. Eight 512×1024 RGBA
textures use 16 MiB of texture storage; no new image is uploaded per frame.
The retained PocketJS UI is drawn over the host background without clearing it.

The projection and motion model follow
[DuoLikeAnimation](https://github.com/elijah-semyonov/DuoLikeAnimation).
The port extends the source's single-axis far-edge hinge to a full attitude
projection about the screen center. It replaces the Metal shader's sparse
random disk samples with baked filled-disk convolution and omits the per-pixel grain. The upstream MIT
notice is retained in [ATTRIBUTION.md](../apps/duo-fold/ATTRIBUTION.md).

## Device checks

```sh
bun ipodtouch4 status
bun ipodtouch4 fold-status
bun ipodtouch4 fold-command manual -45
bun ipodtouch4 capture
bun ipodtouch4 fold-command manual 45
bun ipodtouch4 capture
bun ipodtouch4 fold-command pose 45 -25 15
bun ipodtouch4 capture
bun ipodtouch4 fold-command calibrate
```

`fold-status` reports the runtime build and the native motion receipt,
including samples, calibrations, sensor age, angle range, calibrated-frame
screen normal, and mode. Runtime
receipts remain in the app's current container. `fold-command` writes a
bounded command into that container for the same validator used by the guest.
`capture` saves `dist/ipodtouch4/device-frame.png`.

**Manual-angle captures validate projection and blur, not physical motion.**
Move the device after calibration and check that samples advance and the
sensor-angle range expands. Tap the controls and run
`bun ipodtouch4 status --require-action` for a completed `fold_control`
receipt. Software-generated UIKit events validate dispatch but do not establish
physical-finger acceptance. Verify plane alignment under compound rotation,
perceived delay, and return-to-zero behavior while holding the device.

```sh
bun test --conditions=browser tests/duo-fold.test.ts tests/quickjs-c-harness.test.ts \
  tests/ipodtouch4-profile.test.ts tests/ipodtouch4-installation.test.ts \
  tests/ipodtouch4-svcwire.test.ts
```
