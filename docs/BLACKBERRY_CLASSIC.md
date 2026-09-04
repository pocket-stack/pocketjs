# BlackBerry Classic

PocketJS runs on the BlackBerry Classic (SQC100, BlackBerry 10.3) through two
hosts that share everything above the operating-system boundary. **Both mount
the same guest bundle shape, the same no-std Rust UI core with its GLES2
DrawList backend, and the same QuickJS bridge (`engine/quickjs-c/pocket_runtime.c`)
against one private device profile: 720×720 physical, 360×360 logical at
raster density 2, 60 Hz fixed simulation time, `input.buttons`, `input.touch`,
and `text.glyphs.baked`.** They differ only in how the process is packaged,
installed, and fed input:

| | Native QNX host — `hosts/blackberry-classic-qnx` | Android Runtime host — `hosts/blackberry-classic-android` |
| --- | --- | --- |
| Process | BlackBerry 10 Core Native ELF: libscreen window, EGL, OpenGL ES 2, BPS event loop | Android 4.3 (API 18) APK: a `GLSurfaceView` Activity over one JNI `armeabi-v7a` library |
| Package | unsigned development BAR (`blackberry-nativepackager -devMode`) | v1-signed APK |
| Install requirement | **a rooted Classic**: a stock device accepts an unsigned development BAR only with a BlackBerry debug token, and the service that issued tokens is retired | **a stock Classic**: BlackBerry 10.3 sideloads APKs from the file manager once “Allow apps from other sources” is enabled |
| Input source | libscreen keyboard, multi-touch, and `SCREEN_EVENT_JOYSTICK` trackpad events; navigator system keys | Android `KeyEvent`, touch `MotionEvent`, and generic-motion/trackball events from the Android Runtime |
| Toolchain | digest-pinned BBNDK Docker image (compile, package, deploy) | Android SDK Platform 18 + Build-Tools 35.0.0 + NDK r23c unpacked by `setup`, JDK 17 in Docker |
| Hardware status | **first device run recorded** (below) | **no device result is recorded here yet** |
| Command | `bun blackberry-qnx …` | `bun blackberry-android …` |

Use the native host when the device is rooted: it presents directly through
libscreen and receives the trackpad as its own event class. Use the Android
Runtime host on an unmodified device, or to compare the Android Runtime's input
mapping against the native one on the same hardware.

Both targets stay private (`tools/blackberry-classic-profile.ts`) and outside
`POCKET_TARGETS` until installation, boot, presentation, touch, keyboard,
trackpad, background/resume, and repeatable delivery are all recorded per host.

## Shared contract

`apps/blackberry-classic-demo` is the Hero wrapper both hosts build. The
profile module registers `blackberry-qnx-dev` and `blackberry-android-dev`
with the same display, capabilities, and **host ABI 9**; the target id is
compiled into both the guest and the native host and checked at boot, which is
why they are two targets rather than one.

**Package identity has one source: the resolved plan.** `plan.app` carries the
manifest's `id`, `title`, and `version`; `extractHostBuildInputs` hands them to
the host tools, and `packageIdentity` (`tools/native-host-build.ts`) maps them
onto the platform: the package id is the manifest id with `-` replaced by `_`
(`dev.pocket_stack.blackberry_classic_demo` — a valid Android package name and
BAR id), the version string is used verbatim, and the integer the platforms
need (Android `versionCode`, BAR `buildId`) is `major·1 000 000 + minor·1 000
+ patch` (0.1.1 → 1001). `AndroidManifest.xml`, `strings.xml`, and
`bar-descriptor.xml` are templates with `@POCKET_…@` placeholders rendered at
build time; neither host directory holds a second copy of the id or version.

Input reaches the guest only through the portable button mask and touch
snapshot; no Android or QNX concept crosses the boundary. **The mask constants
come from `contracts/generated/pocket_spec.h`, generated from
`contracts/spec/spec.ts` by `contracts/spec/gen-c.ts` and byte-compared by
`tests/contract.ts`**, and both hosts feed their platform events into the same
state machine, `hosts/blackberry-classic/pocket_input.c` (unit-tested with the
host compiler in `tests/pocket-input.test.ts`):

| Physical input | Portable input |
| --- | --- |
| trackpad movement | one d-pad focus pulse per threshold crossing of the accumulated motion, then the axis resets (QNX feeds the integer `SCREEN_PROPERTY_DISPLACEMENT` with threshold 1, so every non-zero event pulses; Android feeds scroll-axis/trackball deltas with threshold 0.35 — provisional, see below) |
| trackpad click | the press button (`CIRCLE`), held while the button is down, tracked separately from keys |
| Enter/Return, d-pad center | the press button |
| arrow keys | d-pad; a key down is one press edge, platform auto-repeat does not re-press |
| Space | `START` |
| Menu | `TRIANGLE` |
| Send (QNX navigator system key) | a one-shot press edge; End and Back stay with the system |
| touchscreen | one tracked contact (a second finger never becomes input), divided into 360×360 logical coordinates, with the host-resolved bounds hit fact; **a contact that went down and up between two frames still reports one down frame, and a release is reported at the very next frame** |

The frame call is `pocket_runtime_tick(&input)` in
`engine/quickjs-c/pocket_runtime.c`: **exactly one guest turn followed by one
core tick per presented frame** (docs/RUNTIMES.md, law 3), taking the mask,
the sampled contact, and its hit fact. The older `pocket_runtime_frame` /
`pocket_runtime_frame_ticks` entry points stay for the original iPhone host
(two core ticks per 30 Hz guest turn) and the Windows CE host; new hosts do
not call them. `pocket_runtime_gl_reset` drops GL resources so the backend can
be re-initialized after the platform recreates the context (Android does on
pause/resume).

The Rust package is `pocketjs-ui-cabi` (`engine/ui-cabi`): the no-std C-ABI
build of `pocketjs-core` plus the GLES2 DrawList backend that the Nokia E7,
iPhone 2G/4S, and Meizu M8 hosts already link. Both Classic hosts build it
with the `bare-platform` feature. **Its compatibility archive remains
`libpocketjs_symbian_core.a`, preserving the existing link input and C ABI.**
The QNX build uses the checked-in
`hosts/blackberry-classic-qnx/armv7-qnx-eabi.json` target (ARMv7, VFPv3, soft-float
ABI, PIC, `build-std`); the Android build uses the stock
`armv7-linux-androideabi` target.

## Host requirements

Both tools need Bun, git, `zip`/`unzip`, `patch`, Docker with a running
daemon, and rustup with **`nightly-2026-07-02`**:

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal --component rust-src
```

`rust-src` feeds the QNX `build-std` link; `bun blackberry-android setup` adds
the `armv7-linux-androideabi` target to that toolchain for the Android link.
**QuickJS is `pocket-stack/quickjs-rs` at `ba5bdd0dc013518768e76cd9e05cd30ed53dd35b` (version 2026-06-04) for both hosts**;
`setup` clones it under each tool's cache with `--filter=blob:none` and every
build refuses a checkout at another revision or with local changes.

**Both tools were developed and run on Linux x86-64, and both complete
builds — the unsigned BAR and the Hero APK — have also been run on macOS on
Apple silicon with the same commands.** Device installation
from macOS has not been exercised. What is host-specific:

- **QNX**: the compiler, BAR packager, and `blackberry-deploy` run inside
  `accupara/bbndk` (linux/amd64, pinned by digest, about 2.9 GB compressed).
  On Apple silicon Docker Desktop runs that image under the emulation it
  registers itself (Rosetta for x86-64, QEMU for the BBNDK's 32-bit x86 host
  tools); the QuickJS and host compile, link, and BAR packaging complete
  there without extra setup, only more slowly. USB deployment (below) uses
  `udevadm` and `ip route` and is Linux-only; other hosts skip the interface
  check and reach the device by whatever address `POCKETJS_BLACKBERRY_DEVICE`
  names.
- **Android**: `aapt2`, `aapt`, `zipalign`, and the NDK clang run on the host
  from the SDK directory, so `setup` unpacks the host OS's own archives
  (Linux or macOS build-tools and NDK; the NDK prebuilt is `linux-x86_64` or
  `darwin-x86_64`, the latter running under Rosetta on Apple silicon).
  `javac`, `d8`, `apksigner`, and `keytool` run inside
  `eclipse-temurin:17-jdk-jammy` (pinned by digest, multi-arch), so no host
  JDK is needed at any step.

Caches live under `~/.cache/pocket-stack/`: `blackberry-qnx/` (QuickJS
checkout, Rust target directory) and `android/` (`sdk/`, `downloads/`,
`signing/`, QuickJS checkout). Nothing from either cache is copied into the
repository.

## Native QNX host

### Toolchain

`tools/cli/blackberry-qnx-toolchain.json` pins:

- BBNDK target API **10.3.1.995**, host tools **10.3.1.12**;
- `qcc` **GCC 4.8.3** for `armle-v7`;
- the `accupara/bbndk` image digest;
- the QuickJS revision and the Rust nightly and target spec.

The image's default entry point is an interactive shell for a different user;
the tool overrides the entry point, runs as the calling uid/gid, publishes no
ports, and compiles and packages with **container networking disabled**.

QuickJS needs two QNX-specific changes (`tools/blackberry-qnx/quickjs-qnx.patch`):
BlackBerry's C library has no `<stdatomic.h>`, so the single-threaded host
omits the Atomics intrinsic, and it has no `malloc_usable_size()`, so the
allocator reports usable size as zero.

```sh
bun blackberry-qnx setup     # pulls the image, clones QuickJS, runs doctor
bun blackberry-qnx doctor
bun blackberry-qnx build     # build-demo + build-runtime
```

`build-demo` resolves the manifest against `blackberry-qnx-dev`, writes the
plan to `.pocket/blackberry-qnx/`, and compiles the guest into
`dist/blackberry-qnx/guest/`. `build-runtime` builds the Rust core, compiles
QuickJS, `pocket_runtime.c`, and `hosts/blackberry-classic-qnx/main.c` with the plan's
target id, host ABI, raster density, and logical viewport, links the PIE ELF
against `libbps`, `libscreen`, `libEGL`, and `libGLESv2` with `--no-undefined`,
and packages the unsigned BAR from the rendered `hosts/blackberry-classic-qnx/bar-descriptor.xml`
template.
**The tool rejects a build whose ELF is not ARM, lacks the QNX dynamic loader
or one of the four libraries, whose BAR manifest does not carry the
plan-derived package name and version, or whose BAR embeds a different
executable than the one it linked.**

```text
dist/blackberry-qnx/pocketjs-blackberry-classic-hero.bar
dist/blackberry-qnx/build-receipt.json
```

The receipt records the resolved host contract, image digest, QuickJS and
Rust pins, build id, `readelf` output, and SHA-256 of every native input and
output.

### Install and device acceptance

Installing or launching changes device state and is not part of `build`.
Enable Development Mode on the Classic (Settings › Security and Privacy ›
Development Mode), which assigns the USB address `169.254.0.1`, then:

```sh
export POCKETJS_BLACKBERRY_DEVICE=169.254.0.1
export POCKETJS_BLACKBERRY_PASSWORD='device-password'   # omit when the rooted transport takes none
bun blackberry-qnx device-info
bun blackberry-qnx install        # -installApp -launchApp
bun blackberry-qnx device-status  # reads data/pocketjs-qnx.status from the app sandbox
```

On Linux the Classic appears as a CDC-NCM network interface (USB vendor
`0fca`); the tool refuses to deploy until that interface carries a link-local
route and prints the `sudo ip address replace 169.254.0.2/16 dev …` command
that adds one. `blackberry-deploy` runs in the same image with `--network
host`; **on Docker Desktop that is the Linux VM's network, so use the device's
Wi-Fi development address if the USB link-local address is unreachable.**

The host rewrites `data/pocketjs-qnx.status` whenever its content changes:
build id, lifecycle stage, frame count, raw keyboard and trackpad facts, event
totals, and the latest reported Hero action.

The first hardware run must show: the Hero fills the 720×720 display through
GLES2; the spinner and underline animate at the fixed 60 Hz step; a tap
activates the button; trackpad movement focuses it and a click activates it;
Enter and Send activate it; background and resume stop and restart
presentation without losing state; repeated installs keep a usable sandbox.

### First Classic hardware result

**BlackBerry Classic SQC100-4, BlackBerry 10.3.3.3216.** The unsigned
development BAR installed and launched through the rooted device transport.
The live status record confirmed:

- **720×720 GLES2 presentation with the 360×360 density-2 guest**;
- **2,747 rendered frames** across foreground, background, and resume;
- **12 touchscreen events**;
- **56 trackpad joystick events and 4 trackpad clicks**;
- **8 completed `hero_press` actions**.

This accepts native loading, the QuickJS and Rust runtime, rendering, touch,
trackpad navigation and click, and lifecycle resume. Physical keyboard
symbols, navigation-key policy, repeated upgrade delivery, and a captured
screen remain open, so the target stays private. **The input path changed
after that run** — the host now feeds the shared `pocket_input` state machine,
which reports a touch release at the next frame instead of one frame later
and ignores a second finger — **and the host was re-accepted on the same
device with that path** (`device-status`: tap, trackpad focus and click, and
release timing as specified).

## Android Runtime host

### Toolchain

`tools/cli/blackberry-android-toolchain.json` pins:

- Android SDK Platform **18** (Android 4.3.1 — the Android Runtime in
  BlackBerry 10.3);
- Build-Tools **35.0.0**;
- **NDK r23c (23.2.8568313), the last NDK series that still targets API 18**;
- `armeabi-v7a` with clang target `armv7a-linux-androideabi18`;
- the JDK image digest, the QuickJS revision, and the Rust nightly and target.

`setup` unpacks the three SDK components into
`~/.cache/pocket-stack/android/sdk` from the archives Google's repository
serves for the host OS — `android-18_r03.zip`, `build-tools_r35_{linux,macosx}.zip`,
`android-ndk-r23c-{linux,darwin}.zip` — after checking each against the SHA-1
published in `repository2-3.xml` (the same files and checksums `sdkmanager`
uses, so no host JDK is needed). A component whose directory already exists
is left alone; `POCKETJS_ANDROID_SDK_ROOT` points the tool at an SDK that
already holds `platforms;android-18`, `build-tools;35.0.0`, and
`ndk;23.2.8568313`.

```sh
bun blackberry-android setup        # SDK archives, JDK image, QuickJS checkout, Rust target, then doctor
bun blackberry-android doctor
bun blackberry-android build        # build-demo + build-app
```

`build` compiles the guest against `blackberry-android-dev`, builds the Rust
core, compiles QuickJS, `pocket_runtime.c`, `pocket_input.c`, and
`hosts/blackberry-classic-android/app/jni/runtime.c` with the plan's target id, host
ABI, raster density, and logical viewport, links `lib/armeabi-v7a/libpocketjs.so`
against `libGLESv2`, `liblog`, `libdl`, and `libm`, renders the manifest and
string templates with the plan-derived package id, version, and title, and
**rejects an APK whose badging does not report exactly those values**. **The
library does not link `libandroid.so`, and `--no-undefined` turns any missing
native symbol into a link failure.** `PocketActivity.java` owns only the
Android lifecycle, the APK asset reads for `app.js` and `app.pak`, and the
raw key, touch, and trackpad callbacks; the JNI layer feeds them into the
shared input state machine under one mutex and drives one guest tick per
`onDrawFrame`.

**Android 4.3 verifies only the JAR (v1) signature scheme**, so `apksigner`
runs with v2, v3, and v4 disabled. The self-generated key in
`~/.cache/pocket-stack/android/signing/` signs the APK; keep it, because
Android upgrades an installed package only when the new APK carries the same
signing identity.

```text
dist/blackberry-android/pocketjs-blackberry-classic.apk
dist/blackberry-android/pocketjs-blackberry-classic.receipt.json
```

The receipt records the plan hash, target, host ABI, viewport, guest and
native-library digests, `llvm-readelf` output, the QuickJS pin, the
`apksigner verify` report, and `aapt dump badging`.

### Install and device acceptance

Copy the APK to the Classic (USB mass storage, BlackBerry Link, or a network
share) and open it from the device file manager. No debug token, BAR
conversion, or root is involved.

**The Android trackpad mapping is provisional.** `PocketActivity` forwards
generic-motion scroll axes and trackball deltas as relative movement and the
primary button state as the press; which of those callbacks the Classic's
Android Runtime actually delivers for the trackpad, and whether it presents
the trackpad as a pointer instead, has not been observed on a device yet.
Adjust `hosts/blackberry-classic-android/app/jni/runtime.c` from the first device
run before accepting the Hero APK.

The Hero APK must show the same list as the native host: 720×720 GLES2
presentation, the 60 Hz animation, tap, trackpad focus and click, Enter,
background and resume, and repeated upgrades. The Activity prints the boot or
runtime error on screen when the native library, the guest, or the GLES2
backend fails, so a failed run leaves a readable reason.
