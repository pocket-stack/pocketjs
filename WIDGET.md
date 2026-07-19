# Pocket Widget — desktop widgets as a runtime-family capability

*How the Pocket runtime family puts small, always-on, guest-programmable
presences on the desktop — and the first runtime built on it: a borderless
3D PSP on your Mac that actually runs Pocket apps.*

This document names and generalizes what
[pocket-character](https://github.com/pocket-stack/pocket-character) proved,
and specifies the next runtime that needs the generalization. It follows the
[RUNTIMES.md](RUNTIMES.md) ontology: a widget runtime is still
⟨Cores, Surfaces, Guest⟩; **pocket-widget** is the mechanism layer that makes
the desktop-widget *form factor* a reusable capability instead of a per-app
reinvention.

## 1. The capability

A desktop widget is the smallest unit of ambient software: one always-on-top,
transparent, undecorated window that lives on the desktop for hours. The form
factor puts two hard constraints on the architecture:

1. **Idle must cost almost nothing.** A widget is judged by what it burns at
   rest, not at peak. pocket-character measured the gap: the same character
   stage costs 8 processes / 2184 MB / 44% CPU on Electron and
   1 process / 118 MB / 3.9% CPU on the Pocket stack — *while rendering 60
   fps of skinned, spring-boned 3D continuously*. A widget whose content is
   mostly static should land far below even that.
2. **Behavior must be a bundle, not a build.** Which app the widget hosts,
   how it reacts, what its personality is — guest program, hot-swappable,
   sandboxed by construction (capability = surface).

pocket-character satisfied both, but its host is product-specific code. The
generic halves it left upstream (`AppConfig` widget-window mode, transparent
clear, `max_fps` pacing, morph/pose machinery — pocketjs #125) are window
plumbing, not the full capability. **pocket-widget** is the missing middle: a
`pocket3d`-workspace mechanism crate, sitting beside `pocket-mod` and
`pocket-ui-wgpu` in the RUNTIMES.md table:

| Piece | Role |
| --- | --- |
| `shell` | The window contract and its event loop: transparent / undecorated / always-on-top (from #125) plus occlusion suspend, a per-press drag-to-move policy hook, and the governor of §4 — fixed-rate guest ticks, demand-driven GPU frames, with a frames-vs-ticks receipt logged on exit. |
| `embed` | A full PocketJS `ui` surface rendered off-window: `pocket-ui-wgpu` draws the core's DrawList into an `OffscreenTarget` whose texture view binds onto any mesh (`ModelAsset::from_geometry_textured`). A screen inside a widget is a *real app*, not a video. The per-tick DrawList content hash is the dirty signal. |
| `parts` + `pick` | The interaction vocabulary: named part shapes (`btn_cross`, `dpad_up`, `nub`, `screen`) → spec BTN bits, analog packing (raw extremes 255/1, never 0), the shared uihost keyboard map, and cursor-ray picking against oriented part bounds (event-driven, CPU, cold path). Procedural shells register each part as its own model instance; glTF node names remain the convention for authored shells. |

What stays out of pocket-widget: any specific model, part map, or behavior —
those are the product. (pocket-character retrofits onto `shell` naturally;
that refactor is desirable but not a blocker.)

## 2. The first runtime: pocket-handheld

The motivating product — and the proof that `EmbeddedUi` + `PartMap` carry
real weight — is a **3D PSP model on the desktop that works**:

- Borderless, transparent, always-on-top window framing a 3D PSP.
- The PSP's screen is a live 480×272 PocketJS `ui` surface — the same
  DrawList renderer that drives PSP hardware, **not** an emulator. PPSSPP
  renders a machine; we render the *app*, because the app was never
  PSP-binary-shaped to begin with.
- The PSP's buttons are pickable meshes. Click CROSS and the guest's next
  `frame(buttons, analog)` carries `BTN_CROSS` — the identical bit the real
  hardware's pad register produces. Drag the analog nub and the guest sees
  the same packed axes a real nub produces.
- Therefore: **any existing PocketJS app boots inside the widget unmodified.**
  The bundle that runs on a real PSP, in uihost, and on the Vita runs here,
  and cannot tell the difference. That is the whole demo.

Shipped first as the in-tree example `pocket3d/examples/handheld` — the
runtime, the procedural shell, and the scripted verification live next to
the mechanism they prove. The standalone product (`pocket-handheld` per the
`pocket-<product>` convention; "handheld" rather than "psp" because the
runtime is shell-agnostic — §6 — and to avoid colliding with the
`pocketjs-psp` host library) extracts to its own pocket-stack repo when the
shell asset grows beyond what procedural authoring carries.

In RUNTIMES.md notation:

```
pocket-handheld (Rust bin, macOS)
  = widget shell        (pocket-widget: window, picking, part input, power)
  + PSP shell asset     (glTF: body, named button nodes, screen material, nub)
  + mounts `ui`         (pocket-ui-wgpu → OffscreenTarget → screen material)
  + mounts `widget`     (optional, §7: hover/led/framing facts and intents)
  + pocket-mod guest    (one unmodified PocketJS app bundle + pak)
```

There is no new domain vocabulary to invent for v1: the guest-facing surface
is the existing `ui` surface, byte-for-byte. The runtime's novelty is
entirely host-side composition.

## 3. Input: from meshes to BTN bits

The bridge is deliberately dumb — a static table, no gameplay logic:

- **Buttons.** `btn_cross/circle/square/triangle`, `dpad_up/down/left/right`,
  `btn_start/select`, `trig_l/r` map 1:1 to the spec BTN bits. Mouse-down on
  a part sets the bit until mouse-up; keyboard chords compose into the same
  word (the OSK needs them). Pressed parts get a procedural press — a small
  translation on the part's instance transform (parts are their own
  instances; skinned authored shells would use the #125 pose-injection split
  instead) — no baked animations required.
- **Analog nub.** Drag within the nub's radius maps to the packed axes
  (`(x << 8) | y`, 0–255, 128 center); release springs back to center.
  Extremes are raw 255/1 — never 0 — matching the input-tape convention.
- **Keyboard, always.** The uihost key map (arrows, Z/Enter = CROSS, …) is
  mounted unconditionally. Mouse-on-model is the magic; keys are the daily
  driver. Both funnel into one `buttons` word per tick — Law 3 is untouched.
- **Picking is event-shaped.** A cursor ray against named-node AABBs (then a
  triangle test for the hit node) runs only on mouse events, never per frame.
  Buttons are rigid; node global transform × static local bounds is exact
  enough.
- **Click-through.** Clicks on fully transparent pixels should reach the
  desktop behind. v1 ships without it (the window hugs the model, so dead
  margin is small); the candidate mechanism — toggle the window's cursor
  hit-test off when the cursor leaves the model silhouette — hangs on the
  re-entry question in §9. Dragging anything inert moves the window (the
  shell's per-press `drag_at` policy).

## 4. Power: two rates, one clock

The determinism laws stay intact — and they are what make low power *cheap*
to implement:

- **The guest ticks at a fixed 60 Hz, always.** One guest turn per host tick
  (Law 3); tapes, goldens, and replays hold inside the widget. An idle
  QuickJS tick over a settled app is microseconds — the PSP does it at
  333 MHz.
- **GPU frames are demand-driven.** A frame renders only when something is
  dirty: the `ui` core produced a different DrawList (cheap content hash per
  tick — DrawLists are small), a pose/morph changed (button press), the
  camera or window moved, or hover state changed. No dirt → no render pass,
  no present; the compositor retains the last frame. A PSP showing a settled
  menu costs **zero GPU frames**.
- Native baked animations (the styles.bin timelines) run in the core, so
  "app is animating" is a core-side fact, not a guess.
- `max_fps` pacing (sleep, not spin) bounds the active case; macOS occlusion
  events suspend rendering entirely while ticks continue, so the app stays
  live behind other windows.
- **Targets, measured not vibed** (pocket-character's methodology: ≥60 s
  steady-state over the process tree): idle < 1% CPU and 0 GPU frames;
  actively animating comparable to pocket-character's 3.9%; RSS in the same
  ~100 MB class. The steady-state harness lands with the product repo; the
  shell already logs its receipt on every exit, and the first measurements
  agree: over a 10 s run on an M3 Max, an app that settles rendered 103
  frames across 601 ticks (all in the first seconds; ~0 after), the
  perpetually-spinning hero demo 365, and RSS held at ~87 MB — one process.

## 5. Screen fidelity

A 480×272 texture sampled in perspective shimmers. Levers, in order:

- **Render the surface at density 2** (960×544) — the Vita host already
  proved the same logical layout renders at density 2 with density-2 paks;
  the widget can reuse that asset path. v1 renders density 1 (480×272, the
  byte-exact golden flavor) and leans on the framing instead; density 2 is
  the next fidelity lever.
- Mipmaps + anisotropic filtering on the screen material; default framing
  keeps the screen near-parallel to the view.
- **Two framings**: "desk" (whole device, ambient) and "focus" (screen fills
  the window, near-flat — effectively uihost with a bezel). Double-click the
  screen or scroll to toggle; the camera animates between them. Focus mode is
  how you actually *use* the app for minutes at a time.

## 6. The shell asset convention

The model is data, the contract is names:

- The v1 PSP shell is **authored procedurally in code** (a rounded-slab
  body, cap and cylinder parts, ~180 lines) — original by construction, no
  committed binary, no fetched asset, and every part is born with its
  semantic name. Sony's trade dress is a real concern for anything
  distributed; the shape stays "generic handheld, obviously PSP-adjacent".
- Authored shells (Blender → glTF) use node names for the same contract:
  `btn_*`, `dpad_*`, `trig_*`, `nub`, `screen`, `led_power`, body meshes
  free-form. The `screen` material's base color is replaced by the
  `EmbeddedUi` texture at load; `led_power` is an emissive the host (or the
  `widget` surface) can tint. Authored assets are fetched at setup, never
  committed — pocket-character's posture.
- The convention is shell-agnostic on purpose: a Vita shell (960×544 screen,
  density-2 native, front-touch as cursor) is the obvious second model, and
  the platform-contracts work means the same guest bundle is already
  admissible on both.

## 7. The `widget` surface (v2, optional)

v1 mounts only `ui` — an unmodified app must be the base case (RUNTIMES.md
rule 5). For bundles that *want* to know they're in a widget, a tiny
string-keyed surface in the `character`/`strike` style:

- **events**: `hover(part|null)`, `pressed(parts)`, `framing(desk|focus)`,
  `occluded(bool)`.
- **ops**: `widget.led(rgb)` (notifications on the power LED),
  `widget.focus(bool)`, `widget.quit()`.

Kept to one page of spec, append-only, or it doesn't ship.

## 8. Verification

- **Screen path is byte-exact.** Same core, same DrawList renderer, same
  paks as every other `ui` host; wiring the shared golden-specs suite
  against the widget's offscreen surface at density 1 is the standing next
  step. If a golden drifts here, the bug is real.
- **Picking is unit-tested**: ray/OBB slab tests incl. rotation, ties, and
  behind-origin cases; nearest-hit part resolution; the analog packing's
  255/1-never-0 extremes.
- **End-to-end is a script, today**: `--click x,y` presses a window pixel
  through pick → part → BTN → guest; `--tap circle@30` sequences buttons.
  The proof run drives the unmodified hero demo — D-pad tap to focus, two
  CIRCLE taps — and the screen reads `Count: 2`. Captures are composite
  PNGs whose alpha is the real window transparency.
- **Power is a receipt, then a gate**: the shell logs ticks vs. frames
  rendered on every exit; the product repo's measurement harness turns the
  thresholds into a failing check.

## 9. Delivery plan and open questions

Landed in this repo:

1. `pocket3d`: `ModelAsset::from_geometry_textured` (external texture view
   as a material), `Camera::screen_ray`, `Input::inject_cursor`, and
   `pick_alpha_mode` made public for alternative shells.
2. `pocket-ui-wgpu`: `UiRenderer::render_words` — render a DrawList the
   host already built, so the per-tick dirty hash costs one tree walk, not
   two.
3. `pocket-widget`: the crate — `shell` (demand-render loop), `embed`,
   `parts`, `pick` — with the RUNTIMES.md table row.
4. `examples/handheld`: the full first runtime — procedural PSP shell,
   mouse/keyboard input, desk/focus framings, headless scripting
   (`--screenshot/--click/--tap/--hold/--focus/--auto-quit`).

Still ahead: the golden-specs wiring (§8), density-2 screens (§5), the
`widget` surface (§7), click-through, and the extraction into
`pocket-stack/pocket-handheld` with the steady-state measurement harness.
pocket-character retrofits onto pocket-widget when convenient.

Open questions:

- **Click-through re-entry**: with the window's hit-test off, mouse-move
  events stop; re-enabling needs either a low-rate (~10 Hz) cursor poll only
  while in pass-through, or raw device events if winit delivers them
  unfocused on macOS. Decide by experiment.
- **Name**: `pocket-handheld` is a proposal; only "pocket-widget" (the
  capability) is pinned.

Resolved: dirty detection is an FNV-1a hash of the DrawList words — texture
generations ride along in the handles, so re-uploaded pixels change the
hash too.
