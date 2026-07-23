# pocketbook-host

The PocketJS UI runtime on **PocketBook e-readers**, rendered through the
[inkview](https://github.com/simmsb/inkview-rs) SDK.

It reuses the backend-agnostic `ui` surface (`pocket-ui-surface`) and the
core's software rasterizer unchanged, then:

- rasterizes the DrawList to RGBA8 at `logical × density` resolution
  (`pocketjs_core::raster::render_scaled`);
- luminance-converts RGBA8 → Gray8 with 16×16-tile damage tracking
  (`framebuffer.rs`);
- drives the e-ink panel with a partial/dynamic/full update policy ported from
  `inkview-slint` (`refresh.rs`);
- maps inkview keys → the spec BTN bitmask and the touchscreen → the framework's
  packed touch wire format (`input.rs`);
- runs the inkview event loop on the main thread forwarding into a channel, with
  a second thread owning the `Screen` and the fixed-cadence tick/render loop
  (`main.rs`, same model as the `inkview-slint` demo).

See **`pocketjs-inkview-implementation.md`** at the repo root for the full
design, the ground-truth API notes, and the open design questions (notably the
logical-viewport / touch-coordinate trade-off in §9).

## Status

Phases 0–3 of the implementation plan: the host compiles natively, is clippy
clean, and its framebuffer/input unit tests pass. On-device validation
(refresh tuning, touch accuracy, the §9 viewport choice) still requires
hardware.

## Build

Cross-compile for PocketBook's ARM Linux (glibc 2.23):

```sh
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23
```

`libinkview.so` is `dlopen`'d at runtime (`inkview::load`) — no SDK is needed at
build time. The `inkview` dependency currently points at a local checkout; switch
to the git dependency in `Cargo.toml` for a standalone/CI build.

## Deploy

```sh
D=/mnt/ext1/applications/myapp
cp target/armv7-unknown-linux-gnueabi.2.23/release/pocketbook-host $D/myapp
cp dist/<app>.js  $D/app.js     # PocketJS build output
cp dist/<app>.pak $D/app.pak
chmod +x $D/myapp
```

## Runtime configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `POCKET_PAK` | `app.pak` | path to the app pak |
| `POCKET_JS` | `app.js` | path to the JS bundle |
| `POCKET_DENSITY` | `2` | raster density (1–4); raise for high-DPI panels so the logical viewport stays ≤511 px/axis |
| `RUST_LOG` | `info` | log filter |
