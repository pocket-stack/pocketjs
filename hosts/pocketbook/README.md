# pocketbook-host

The PocketJS UI runtime on **PocketBook e-readers**, rendered through the
[inkview](https://github.com/simmsb/inkview-rs) SDK.

It reuses the backend-agnostic `ui` surface (`pocket-ui-surface`) and the
core's software rasterizer unchanged, then:

- rasterizes the DrawList to RGBA8 at `480×272 @2x` = 960×544
  (`pocketjs_core::raster::render_scaled`), matching the `pocketbook` target
  profile in `contracts/spec/platforms.ts`;
- diffs frames in 16×16 tiles and blits the changed pixels as `RGB24`
  (`framebuffer.rs`). inkview's `Screen::draw` converts `RGB24`→Gray8
  internally on **grayscale** panels (PocketBook Verse) and writes RGB directly
  on **color** panels (PocketBook Era Color, Kaleido 3) — one blit path serves
  both;
- drives the panel with a partial/dynamic/full update policy ported from
  `inkview-slint` (`refresh.rs`);
- maps inkview keys → the spec BTN bitmask and the touchscreen → the framework's
  packed touch wire format (`input.rs`);
- runs the inkview event loop on the main thread forwarding into a channel, with
  a second thread owning the `Screen` and the fixed-cadence tick/render loop
  (`main.rs`, the `inkview-slint` demo model).

The 960×544 render is integer-fit centered on the actual panel (which varies by
model), so the host works across devices without per-model configuration.

See **`pocketjs-inkview-implementation.md`** at the repo root for the full
design and the ground-truth API notes.

## Status

The host cross-compiles to a stripped ARM ELF (glibc ≤2.18, dlopens
`libinkview.so` at runtime), is clippy-clean, and its framebuffer/input unit
tests pass. The `pocketbook` target is registered and `hero` builds for it
(`bun pocket compile --target pocketbook`). **Boot, render, scale-to-fit
centering, and animated partial updates are validated on a PocketBook Verse**
(grayscale); input, idle ghosting, background-return, and color panels still
need a hands-on pass — see the checklist below.

## Build

One-time toolchain setup:

```sh
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild
# zig (brew install zig) and libclang (for rquickjs bindgen) are also required.
```

Cross-compile the host (from this directory):

```sh
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23
# → target/armv7-unknown-linux-gnueabi/release/pocketbook-host
```

Notes:

- `libinkview.so` is `dlopen`'d at runtime (`inkview::load`) — no SDK at build
  time.
- `rquickjs` ships pre-generated FFI bindings for common targets but not the
  soft-float `armv7-unknown-linux-gnueabi`, so the ARM build enables its
  `bindgen` feature (needs `libclang`). Native builds use the pre-generated
  bindings.
- LLVM lowers `f32::max/min` to C23 math symbols (`fmaximum_numf`, …) that
  PocketBook's glibc 2.23 predates; `build.rs` links a tiny shim
  (`src/compat.c`) providing them for the cross-build.
- The `inkview` dependency currently points at a local checkout; switch to the
  git dependency in `Cargo.toml` for a standalone/CI build.

## Build the app bundle

From the repo root:

```sh
bun pocket compile --target pocketbook --manifest apps/hero/pocket.json --project-root .
# → dist/hero-main.js + dist/hero-main.pak
```

## Deploy

Connect the PocketBook over USB, then from the repo root:

```sh
hosts/pocketbook/deploy.sh                 # auto-detects the mount point
# or explicitly:
hosts/pocketbook/deploy.sh /run/media/$USER/PB626
```

It installs `applications/pocketjs-hero/{pocketjs-hero, app.js, app.pak}`.
Eject safely and launch **pocketjs-hero** from the launcher (a firmware rescan
or restart may be needed for a new app to appear).

## Runtime configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `POCKET_PAK` | `app.pak` | path to the app pak |
| `POCKET_JS` | `app.js` | path to the JS bundle |
| `RUST_LOG` | `info` | log filter (the host logs the panel size + geometry at startup) |

## Device testing checklist

Run on both a grayscale and a color device to exercise both blit paths.

**Boot / render**

- [x] App appears in the launcher and opens without crashing. *(Verse)*
- [x] The `hero` UI renders, centered, with letterbox borders on the larger
      panel. Check the startup log line
      (`pocketbook: panel WxH, … render WxH → disp WxH +(ox,oy)`) for sane
      geometry. On the Verse the 960×544 render is scaled to 758×429 and
      centered vertically. *(Verse)*
- [x] Text is crisp (font atlases are baked @2x). *(Verse)*
- [x] **Verse (gray):** image/logo render in grayscale, no color. *(Verse)*
- [ ] **Era Color (color):** colored UI elements actually show color.

**Input**

- [ ] Touch: tapping a button activates it (touch maps physical→logical via the
      scale-to-fit offset + displayed size).
- [ ] Hardware keys: D-pad moves focus, OK activates, Back/Menu behave.
- [ ] Page-turn keys (Prev/Next) map to left/right.

**E-ink refresh**

- [x] Small changes (button highlight / spinner) update without a full flash —
      the hero spinner and progress bar animate via partial updates. *(Verse)*
- [x] During animation the panel keeps up (dynamic updates), then does a clean
      partial update when it settles (~200 ms quiet). *(Verse)*
- [ ] No persistent ghosting after a few seconds idle (periodic cleanup works).
- [ ] Returning from background (`Show`) does one clean full redraw.

### Validated on hardware

- **PocketBook Verse** (grayscale, 758×1024) — 2026-07-24. Boot, render,
  scale-to-fit centering, @2x text, and animated partial updates all confirmed
  via photo + video. Input (touch / hardware keys), idle ghosting, and
  background-return still need a hands-on pass.
- **Era Color / Kaleido 3** — not yet tested (color blit path unverified).

### Logs

The `.app` launcher redirects the host's stdout/stderr to
`applications/<app>/pocketjs.log` on the device storage (visible over USB), so
the startup geometry line and any `RUST_LOG` output survive a run. Bump the
filter with `RUST_LOG=debug` in the launcher for verbose traces.

**Report back** any crash (ideally with the `pocketjs.log` contents),
mis-render, touch offset, or excessive flicker — those drive the next
iteration.
