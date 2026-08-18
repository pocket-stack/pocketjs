# Render backends

The core's output is one contract: the DrawList, a flat `Vec<u32>` of draw
ops pinned in `contracts/spec/spec.ts` ("DRAWLIST op format"). Everything
above it — JSX + Tailwind, the Solid/Vue Vapor/Octane renderers, the frame
transaction (docs/DETERMINISM.md), the animation engine — is identical on
every backend. Backends differ in **how the DrawList becomes pixels**, and
in exactly one capability: **who measures and shapes text**.

## The portable backend

The portable backend is the baked-text pipeline every fixed-function host
shares: `pocket-ui-wgpu` on the desktop, the core software rasterizer
(`engine/core/src/raster.rs`) behind the wasm, Apple, PocketBook and sim
hosts, the PSP GE walker, the ESP32-P4 PPA and Symbian GLES2 ports.

- **Text is baked at compile time.** `framework/compiler/bake-font.ts`
  rasterizes the app's collected codepoints into FONT ATLAS v3 blobs; the
  core measures runs from the atlas advance tables
  (`engine/core/src/text.rs::measure_run`) and emits `GLYPH_RUN` ops —
  glyph ids and cell positions, nothing else.
- **Pixels are byte-deterministic.** Same bundle + pak + input tape produce
  the identical framebuffer on every portable host at the same density —
  that is what `tests/golden.ts`, the PSP/Vita emulator goldens and
  `tools/tape.ts` session hashes pin.
- The capability id is `text.glyphs.baked`; hosts that extend atlases at
  runtime (system-font rasterization + `loadFontAtlas` reload, note-widget's
  cjk.rs) add `text.glyphs.runtime`.

## The gpui backend

`engine/backends/gpui` (`pocket-ui-gpui`) paints the same DrawList through
[gpui](https://gpui.rs) — Zed's Metal renderer — and is embedded by
`hosts/macos`, the stock host of the `macos-app` target. Boxes, gradients
and images become antialiased vector quads instead of upscaled raster;
text can come from the host text system.

- **Text layout is a host capability, opted into per app.** An app that
  `enhances: ["text.layout.native"]` gets a core text measurer installed
  before the guest mounts (`Ui::set_text_measure`): taffy leaf sizes, the
  `measureText` op and painted glyphs all come from one provider — CoreText
  through gpui's text system. Codepoint coverage is the OS font fallback
  chain (CJK, emoji, everything), with **no runtime atlas baking and no
  tofu**.
- **The op is `TEXT_RUN` (9).** With a measurer installed, translation-only
  tracking-0 runs pack the run string's UTF-8 bytes INTO the word stream
  (8 header words + payload) — the DrawList stays the complete `Vec<u32>`
  pixel truth, so snapshots, demand-render hashes and damage word-diffs are
  exact by construction. The provider is chosen once per node at layout
  build and recorded (`Node::text_native`); layout and paint gate on ONE
  shared predicate (`Resolved::declares_transform`), and when a paint-only
  transform changes the answer, `Ui::draw` relayouts and repaints before
  returning — every frame that leaves `draw()` is provider-correct, in
  both directions, with no oscillation on canceling transforms. Tracked,
  scaled and rotated runs keep the baked `GLYPH_RUN` pair — measurement
  and glyphs always come from the same provider per node.
- **Monospace is a slot family.** `font-mono` resolves to dedicated slots
  (16..18; framework/compiler/tailwind.ts MONO_FONT_PX) baked from JetBrains
  Mono on the portable side and mapped to the same family through the host
  text system on gpui — the note's code blocks are monospace on every
  backend.
- **Prefix additivity is preserved.** Ligatures, contextual alternates and
  kerning are disabled in the native shaping configuration
  (`engine/backends/gpui/src/fonts.rs`), because app editor math measures
  caret positions as prefix widths through `measureText`
  (`apps/note/layout.ts`, `apps/im/wrap.ts`) and prefix sums only equal
  shaped positions when advances are additive.
- **Two ops keep a pixel-exact escape hatch.** Gouraud `TRI` and `TEX_TRI`
  batches (rotated gradients and images, 3D subtrees) have no gpui vector
  equivalent, so consecutive batches raster through
  `pocketjs_core::raster` into cached local images at the target density —
  the portable rasterizer used as a sub-backend.

### What the gpui backend guarantees, and what it does not

The frame transaction is unchanged: the host ticks the guest at the fixed
declared rate (one `guest.frame()` + one `surface.tick()` per virtual tick,
never from a paint callback), rendering is a pure function of the DrawList,
and paints are demand-armed off the DrawList content hash — the
pocket-widget governor discipline. `state[n]` is exactly as deterministic
as on every other host.

Pixels are **not** byte-comparable across hosts in native-text mode: glyph
rasterization, metrics and fallback fonts belong to the OS. That is the
"different guarantee gets a different id" rule — `text.layout.native`
instead of `text.glyphs.baked` — and why gpui-hosted apps verify like the
note does (pure-math unit tests over an injected measurer, sim traces,
`--proof` acceptance runs) instead of joining `tests/golden-specs.ts`.

## The `macos-app` target

`contracts/spec/platforms.ts` registers the profile: hostAbi 3 (the desktop
HostOps wire generation macos-widget already speaks), `form: "window"`,
dynamic viewport with `acceptsFixed` — a general app frame, not a widget
shell. Fixed-viewport console apps run size-locked and letterboxed with
their baked glyph pipeline intact; the manifest decides everything else:

```
bun run macos note        # dynamic viewport, native text, svc editor protocol
bun run macos hero        # fixed 480x272, size-locked, baked glyphs
bun run macos note --proof
```

`tools/macos.ts` resolves the manifest against `macos-app`, writes the
plan, builds the bundle + pak, and derives the capability-shaped host flags
(`--fixed`, `--native-text`) from the resolved plan. `--editor` is NOT a
capability: it enables the note's companion svc adapter (an app protocol —
the profile deliberately registers no pointer/text/IME/clipboard ids, see
contracts/spec/platforms.ts). On exit the host prints its governor receipt
(`pocket-macos: N ticks, M frames rendered`); a settled app shows M ≪ N.

## Choosing a backend

| | portable | gpui |
|---|---|---|
| hosts | PSP, Vita, PocketBook, ESP32-P4, Symbian, web, sim, macOS widget | macOS (`hosts/macos`) |
| text measurement | core, atlas advance tables | host text system (CoreText), per-app opt-in |
| codepoint coverage | baked charset (+ runtime extension) | OS fallback chain, color emoji |
| pixel determinism | byte-exact across hosts | per-host; transactions still deterministic |
| pixel goldens | `tests/golden-specs.ts`, tape hashes | opted out (note-style verification) |
| rotated/3D content | native | portable rasterizer as a local sub-backend |

The desktop benchmark against Tauri and Electron (harness, comparison
apps, results) lives in its own stacked PR — pocket-stack/pocketjs#294.
