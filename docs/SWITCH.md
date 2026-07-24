# Nintendo Switch port plan

Status: planning only. This document does not add a Switch target or runtime.

## Goal

Ship PocketJS applications as Nintendo Switch homebrew `.nro` files and run
them in Ryujinx and, later, on homebrew-enabled hardware.

The first compatibility target is the current PSP application surface:

- all 17 PSP-admissible demos;
- the Pocket Launcher and whole-guest app switching;
- `input.buttons`, `input.analog.left`, `input.cursor`, and
  `text.glyphs.baked`;
- the existing 480x272 logical viewport and deterministic frame contract.

The 17 applications are `cafe`, `cards`, `chrome`, `cursor`, `gallery`, `hero`,
`hero-vue-sfc`, `hero-vue-vapor`, `im`, `library`, `motions`, `music`,
`notifications`, `settings`, `stats`, `vue-sfc-lab`, and `zoomlab`.
`ipod-nano` and `note` are not PSP-admissible today and are not part of this
port's initial acceptance set.

## Corrections to the initial proposal

The direction was right—Switch is a new guest runtime target—but three details
need changing:

1. PocketJS does not currently have a generic `PocketHost` TypeScript
   interface implemented by each native host. Applications compile against a
   target profile and a `ResolvedBuildPlan`; native QuickJS hosts install the
   synchronous `globalThis.ui` `HostOps` ABI and consume the Rust core's
   `DrawList`.
2. A new target therefore touches more than `hosts/switch`: the target
   registry, backend dispatch, build/package tooling, runtime ABI checks,
   launcher admission, and target tests are all part of the port.
3. The official Switch OpenGL examples use EGL plus Mesa's OpenGL 4.3 core
   profile, not OpenGL ES 3.2. `deko3d` is the lower-level native alternative.
   Neither should be a day-one dependency before the existing deterministic
   software rasterizer is measured.

Adding another desktop simulator is also out of scope. `hosts/web` and
`hosts/sim` already provide the fast development and deterministic test loops;
Ryujinx supplies the Switch-specific integration loop.

## Existing architecture

```text
 pocket.json       target profile
      └──── resolve ────┘
              │
              ▼
   .pocket/<target>/plan.json
              │
        ┌─────┴──────────┐
        ▼                ▼
 JS/pak compiler    native backend
        │                │
        └──── embed ─────┘
              │
              ▼
       native package
```

The reusable boundaries are:

- `contracts/spec/platforms.ts`: capabilities and stock target facts;
- `framework/src/host.ts`: the JavaScript/native `HostOps` contract and frame
  callback;
- `engine/core`: the `no_std` retained UI core, `DrawList`, and deterministic
  software rasterizer;
- `hosts/psp` and `hosts/vita`: QuickJS embedding, pak feeding, input,
  rendering, and guest lifecycle;
- `tools/pocket.ts`: one resolver/compiler path followed by typed native
  backend dispatch.

The Switch port must reuse these boundaries. It must not introduce a parallel
framework API or a Switch branch in application code.

## Proposed Switch architecture

The first implementation should use the standard devkitPro/libnx build and
packaging path, with a thin C shell around a Rust static library:

```text
                           PocketJS build plan
                                   │
                       ┌───────────┴───────────┐
                       ▼                       ▼
                  app.js + app.pak      host build inputs
                       │                       │
                       └────── NRO RomFS ──────┘
                                   │
                                   ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ pocketjs-switch.nro                                         │
 │                                                             │
 │ libnx C shell                                               │
 │   applet loop · framebuffer · PadState · RomFS · logging    │
 │                           │                                 │
 │                           ▼                                 │
 │ Rust static library                                        │
 │   QuickJS · globalThis.ui · pak feed · pocketjs-core        │
 │                           │                                 │
 │                           ▼                                 │
 │ deterministic DrawList rasterizer                           │
 └─────────────────────────────────────────────────────────────┘
```

This split is a spike decision, not yet a proven build:

- libnx owns the established NRO startup, services, input, framebuffer, and
  packaging path;
- Rust retains the existing core and most of the PSP/Vita QuickJS `HostOps`
  implementation;
- QuickJS and Rust can resolve C runtime symbols from devkitA64/newlib at the
  final link;
- application artifacts live in NRO RomFS, avoiding another generated Rust
  byte table during the first port.

The pure-Rust `cargo-nx` route is not the initial choice. Its official Rust
target is Tier 3 and useful, but PocketJS also needs QuickJS C/newlib
integration. Replacing the proven libnx startup and packaging path does not
reduce the first port's risk.

### Display contract

The proposed initial profile is:

```text
target id           switch
platform            switch
form                takeover
host ABI            4
physical viewport   1280x720
logical viewport    480x272
presentation        integer-fit
raster density      2
```

`host ABI = 4` is a proposed new native contract identity; it is not assigned
until the host exists and its tests pass.

Integer-fit produces a 960x544 content surface centered in the 1280x720 Switch
framebuffer:

```text
1280x720
┌──────────────────────────────────────────────────────────────┐
│                         88 px                                │
│        ┌────────────────────────────────────────────┐        │
│ 160 px │              960x544 content               │ 160 px │
│        │        480x272 logical viewport at 2x      │        │
│        └────────────────────────────────────────────┘        │
│                         88 px                                │
└──────────────────────────────────────────────────────────────┘
```

This preserves the manifests' existing `integer-fit` promise and produces the
same density-2 raster inputs as Vita. Stretching to 16:9 would be visually
small but contractually wrong. A future `fit` presentation should be designed
as an explicit manifest/profile feature rather than silently changing
`integer-fit`.

### Input mapping

The Switch shell maps libnx `PadState` to the existing PocketJS button mask:

| Switch input | PocketJS input |
| --- | --- |
| D-pad | Up, down, left, right |
| A | Circle / confirm |
| B | Cross / cancel |
| X | Triangle |
| Y | Square |
| Plus | Start |
| Minus | Select / launcher summon |
| L or ZL | Left trigger |
| R or ZR | Right trigger |
| Left stick | Packed analog value, axes 0–255, center 128 |

The initial target advertises only capabilities that have end-to-end tests.
Touch, right analog, motion, rumble, audio, networking, and service mailboxes
do not block PSP parity and must not be advertised speculatively.

### Rendering ladder

Stop at the first renderer that sustains the required workload:

1. Use `pocketjs_core::raster::render_scaled(..., 2)` to produce the existing
   deterministic 960x544 RGBA surface, then copy it into the centered libnx
   1280x720 linear framebuffer.
2. Measure release builds in Ryujinx and on hardware. Keep this renderer if it
   sustains 60 FPS with the current golden applications.
3. Only if the measurement fails, add an OpenGL 4.3 `DrawList` backend using
   `switch-mesa` and `switch-glad`.
4. Consider direct `deko3d` only if the OpenGL backend has a measured size,
   latency, or compatibility problem.

The software renderer is already the byte-exact oracle used by web and Vita
capture tests. Starting there gives correct gradients, glyphs, clipping,
textures, sprites, and transformed triangles before taking on a second
problem: a new GPU backend.

## Local workstation audit

Observed on 2026-07-24:

- Apple Silicon macOS;
- Ryujinx at `/Applications/Ryujinx.app`, build `1.3.3-e2143d4`;
- Ryujinx has created its normal application support directory and recognizes
  `.nro` as a document type;
- Bun, CMake, Ninja, Homebrew, and rustup are present;
- devkitPro, devkitA64, libnx, `elf2nro`, and `nxlink` are not installed;
- the local `nightly-2026-05-28` directory is present, but rustup reports a
  missing manifest, so it cannot be treated as a valid Switch toolchain.

No dependency was installed while preparing this plan.

## Toolchain bootstrap

The supported macOS path is devkitPro pacman plus the `switch-dev` package
group. `switch-dev` includes devkitA64, libnx, Switch tools, deko3d, and the
official examples. The first bootstrap should not install Mesa, `cargo-nx`, or
unrelated Switch port libraries.

Planned commands:

```sh
curl -fLO \
  https://github.com/devkitPro/pacman/releases/download/v6.0.2/devkitpro-pacman-installer.pkg
sudo installer -pkg devkitpro-pacman-installer.pkg -target /
sudo dkp-pacman -Syu
sudo dkp-pacman -S --needed switch-dev
```

The PocketJS build tool should supply its own environment instead of requiring
shell startup-file edits:

```sh
export DEVKITPRO=/opt/devkitpro
export DEVKITA64="$DEVKITPRO/devkitA64"
export PATH="$DEVKITA64/bin:$DEVKITPRO/tools/bin:$PATH"
```

Bootstrap verification:

```sh
aarch64-none-elf-gcc --version
elf2nro --help
nxlink --help
make -C /opt/devkitpro/examples/switch/graphics/simplegfx
```

The resulting official `simplegfx.nro` must boot in the installed Ryujinx
before PocketJS code is added. This isolates emulator/toolchain setup from
PocketJS integration. Proprietary firmware, keys, or SDK files must not be
added to the repository; the first Ryujinx spike determines whether this
homebrew-only path needs any user-local emulator setup.

Rust requirements for the static-library spike:

- a pinned nightly toolchain;
- `rust-src`;
- `-Z build-std=core,alloc`;
- `aarch64-nintendo-switch-freestanding`;
- panic abort and position-independent AArch64 code compatible with the libnx
  final link.

Use the repository's pinned nightly date if it supports the target after a
clean rustup install. Change the date only for a demonstrated compiler or
target failure.

## Implementation milestones

### M0 — toolchain and emulator proof

Scope:

- install only devkitPro pacman and `switch-dev`;
- repair/install the pinned Rust nightly with `rust-src`;
- build the official `simplegfx` example;
- boot its NRO directly in Ryujinx;
- record exact tool versions and the successful Ryujinx invocation.

Exit criteria:

- one reproducible command builds an official NRO;
- one reproducible command boots it in Ryujinx;
- no PocketJS source change is needed to diagnose toolchain failures.

### M1 — target contract

Scope:

- add a truthful `switch` profile to `contracts/spec/platforms.ts`;
- add Switch to platform-contract fixtures and the demo admission matrix;
- add a typed backend entry to `tools/pocket.ts`;
- expose the Switch host files through the npm package allowlist only where a
  downstream build actually consumes them.

Exit criteria:

- `pocket check --target switch` admits the 17 PSP applications and launcher;
- unsupported viewport/capability combinations still fail;
- existing PSP, Vita, and macOS target tests remain unchanged and green.

### M2 — NRO shell and Rust/QuickJS link spike

Scope:

- create the smallest `hosts/switch` build;
- link one Rust `no_std + alloc` static library into a libnx NRO;
- prove C-to-Rust calls, Rust allocation, panic abort, QuickJS creation, and
  JavaScript evaluation;
- load `app.js` and `app.pak` from RomFS;
- draw a solid diagnostic frame and read buttons.

The current pinned `pocket-stack/quickjs-rs` build script special-cases PSP and
Vita but not Switch. The spike must determine the minimal upstreamable change:
target compiler selection, `__SWITCH__`/newlib guards, and archive linkage. Do
not fork the entire runtime or add a second JavaScript engine.

Exit criteria:

- a self-contained NRO evaluates a trivial embedded script in Ryujinx;
- Plus exits cleanly to the emulator;
- failures are visible through stderr/nxlink-compatible logging.

### M3 — first PocketJS frame

Scope:

- port the native `HostOps` registration and frame lifecycle from the
  PSP/Vita host;
- feed styles, fonts, images, and sprites from the normal pak;
- call the existing density-2 software rasterizer;
- map buttons and the left stick;
- build and boot `hero`.

Exit criteria:

- `hero` renders and responds to input in Ryujinx;
- the bundled target id and host ABI handshake passes;
- the captured density-2 content frame matches the deterministic oracle.

### M4 — framework parity and developer loop

Scope:

- implement every mandatory current `HostOps` operation;
- add cursor hit testing and cursor drawing;
- add `bun switch <app>` for low-level host development;
- add `pocket build --target switch`;
- extend `bun play switch <demo>` to build and boot the exact NRO in Ryujinx;
- package app title, version, and a valid NACP/icon into the NRO.

Exit criteria:

- all 17 applications build as NROs;
- the current PSP capability surface behaves on Switch;
- stale NROs cannot be launched accidentally by `play`;
- the release `hero` frame loop sustains 60 FPS in Ryujinx.

### M5 — automated Ryujinx regression proof

Scope:

- add a capture feature with scripted input, following the Vita E2E pattern;
- write raw density-2 content frames to a dedicated path under Ryujinx's
  virtual SD card;
- launch only the spawned Ryujinx process and wait for a `done` or error file;
- compare existing golden scenarios to the deterministic density-2 oracle;
- smoke-build and boot every PSP-admissible application.

Do not make GUI screenshots the pixel oracle. Emulator window chrome, display
scaling, and host color management are not PocketJS output.

Exit criteria:

- the existing golden scenarios pass through the Switch QuickJS/input/frame
  loop;
- every PSP-admissible demo builds;
- emulator crashes and timeouts are reported with the app name and log path.

### M6 — launcher parity

Scope:

- extend launcher target admission and package thinning to Switch;
- embed the launcher plus every Switch-admitted `.pocket` package in RomFS;
- port whole-guest teardown, app table, launch request, and frozen shot;
- map Minus to the existing Select summon behavior.

Exit criteria:

- one NRO contains the launcher and all 17 applications;
- switching repeatedly does not retain QuickJS realms, core textures, or
  guest state;
- a broken child returns to the launcher rather than terminating the NRO.

### M7 — hardware and CI

Scope:

- run the same NRO on homebrew-enabled hardware through hbmenu/nxlink;
- record frame time and memory for representative heavy demos;
- add a pinned, reproducible CI Switch build;
- document hardware installation and debugging after it has been exercised.

Exit criteria:

- hardware and Ryujinx use the same release NRO;
- `hero`, `gallery`, `motions`, `im`, and the launcher sustain 60 FPS;
- CI publishes the NRO as a build artifact without proprietary inputs.

## Expected change surface

The implementation is expected to touch:

- `contracts/spec/platforms.ts`;
- `tests/platform-contracts.test.ts` and plan fixtures;
- `tools/pocket.ts`, `tools/play.ts`, and a small `tools/switch.ts`;
- `tools/launcher.ts`;
- `hosts/switch/`;
- `package.json` scripts and package file allowlist;
- Switch build, contract, and Ryujinx E2E tests;
- this document and the command reference after commands are real.

`engine/core` and application sources should not change for the first working
port. A change there requires a cross-platform defect or a missing reusable
boundary demonstrated by the Switch spike.

## Pull request sequence

Keep each step independently reviewable:

1. `feat(switch): add the target contract and NRO shell`
2. `feat(switch): run the PocketJS guest in Ryujinx`
3. `feat(switch): complete rendering and input parity`
4. `test(switch): add Ryujinx regression coverage`
5. `feat(switch): port the Pocket Launcher`
6. `ci(switch): publish reproducible NRO artifacts`

If the M2 link spike disproves the C-shell/Rust-static-library split, stop and
update this document with the measured failure before expanding the design.

## Risks and gates

| Risk | Gate |
| --- | --- |
| devkitPro on the current macOS beta | Official `simplegfx.nro` builds before PocketJS work |
| Ryujinx NRO launch or virtual SD behavior | M0 records a working invocation and M5 proves file-based completion |
| Rust Tier-3 target and libnx final link | M2 calls an allocating Rust function from the NRO before QuickJS work |
| QuickJS/newlib build assumptions | M2 creates/evaluates/destroys one realm before `HostOps` is ported |
| Software rasterizer performance | Release frame-time measurement decides whether OpenGL is added |
| 16:9 versus 480x272 presentation | Explicit centered integer-fit contract; no silent stretch |
| Guest-switch resource leaks | Repeated launcher switching plus handle/realm counters |
| Scope creep into Switch-only APIs | Initial profile advertises PSP parity only |

## Primary references

- [devkitPro Getting Started](https://devkitpro.org/wiki/Getting_Started)
- [libnx documentation](https://switchbrew.github.io/libnx/)
- [official Switch examples](https://github.com/switchbrew/switch-examples)
- [deko3d](https://github.com/devkitPro/deko3d)
- [Rust Switch target support](https://doc.rust-lang.org/rustc/platform-support/aarch64-nintendo-switch-freestanding.html)
- [cargo-nx](https://github.com/aarch64-switch-rs/cargo-nx)
