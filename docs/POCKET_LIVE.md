# Pocket Live — the Electron digital human, rebuilt native

*How the Electron "digital human" was rebuilt on the Pocket runtime family —
every technology choice, the principle they all follow from, and for each
layer, the roads not taken and why. The widget itself measures 1 process /
118 MB / 3.9 % CPU against airi's 8 / 2184 MB / 44.4 %; tracking and the
virtual camera add processes — deliberately, at isolation boundaries — and
§10 accounts for them honestly.*

This document is the design-rationale companion to
[pocket-character](https://github.com/pocket-stack/pocket-character) (the
repo Pocket Live grew out of) and to [WIDGET.md](WIDGET.md), which
generalizes what it proved. WIDGET.md names the *capability*; this page
explains the *choices* — with alternatives, so the next runtime doesn't have
to re-derive them.

## 1. The category, and the question

There is a category of app that is delightful in concept and horrifying in
Activity Monitor: the desktop companion character. A little anime figure
floats in a transparent, always-on-top window — idling, blinking every few
seconds, eyes darting in small saccades, hair swaying with physics. You can
drag her around your screen. Behind her sit two bigger pieces: driving her
expressions from the real webcam (face tracking), and presenting her
composed program as a camera to Zoom (the virtual camera).

The reference implementation is [airi](https://github.com/moeru-ai/airi),
an open-source Electron app that does all of the above. Pocket Live began
as an experiment with a sharp question behind it: *same character, same
model file, same blink timing, same window geometry — what does it cost on
the Pocket architecture instead?*

The measured answer (same machine, same ≥60 s steady-state methodology,
full process tree; **parity scope** — the idle widget alone, no face
tracking, no virtual camera, on both sides):

| | airi (Electron, VRM stage) | Pocket Live widget |
| --- | --- | --- |
| Processes | 8 | 1 |
| RSS | 2184 MB | 118 MB |
| CPU (of one core) | 44.4 % | 3.9 % |

Better than an order of magnitude, and no single heroic optimization
explains it. It falls out of one architectural principle applied
consistently.

## 2. Why Electron costs what it costs

First, a defense of airi: it isn't slow because it's badly written. It's
slow because of what it stands on. Electron means every app ships a
complete Chrome browser; even to draw one little character, you pay for the
whole vehicle:

- **A process tree.** Main process, GPU process, network service, audio
  service, a renderer per window — that's the 8 processes, each with its
  own memory baseline. Gigabytes follow.
- **A web rendering path.** three.js maintains the entire 3D scene graph in
  JavaScript. Every frame — 60 times a second, rAF-driven — JS computes
  spring-bone physics, expression lerps, and skeletal matrices, then hands
  the result to WebGL. Per-frame JS allocates; the garbage collector chases
  it forever. That's where the CPU goes.
- **Pure waste at the edges.** airi's main process polls the global cursor
  at 60 Hz even when nothing consumes it.

The expensive part was never "draw a character." The character's math is
tiny. The expensive part is the vehicle.

## 3. The one idea everything else follows from

Every technology choice in the repo is a corollary of a single rule:

> **Things that happen 60 times per second run in Rust. Things that happen
> occasionally run in JavaScript. Things that don't change at all are
> data.**

What the character actually does each frame is a fixed pipeline with zero
decisions in it:

```
sample clip → apply blink/expression → solve springs → skin → draw
```

Pure math, no branching on intent — so the whole pipeline lives native
(`crates/pocket-character-core` plus the engine crates), compiled,
allocation-free, GC-free. *Decisions* — which motion plays on click, when
to swap expressions, whether to track the mouse — happen a few times per
second at most. Those live in a QuickJS guest: per tick the core pushes a
handful of read-only facts (`blink`, `hovered`, `fps`) through
`character.__dispatch(state, events)`, and the guest queues commands
(`SetTracking`, `PlayClip`, `SetExpression`, `Quit`) that the core applies
at the end of the frame. This is the RUNTIMES.md ⟨Cores, Surfaces, Guest⟩
shape with exactly one core and one surface.

The analogy that sticks: **Rust is the cerebellum, JavaScript is the
cortex.** Walking, blinking, heartbeat — continuous control that never
touches conscious thought — versus "that's a friend, wave." Electron's
architecture makes the cortex operate every heartbeat by hand.

A side effect that became the product: a character's *personality* is just
a guest bundle. Swap the bundle, get a different character; the host
doesn't recompile. The airi-parity personality is deliberately near-empty —
32 lines — because airi's default behavior barely requires decisions.

## 4. The shell: native Rust, not Electron, not Tauri

The product is a single binary: a winit window configured transparent,
undecorated, always-on-top, 450×600 (airi's exact stage geometry), rendered
with wgpu, frame-paced at 60 fps — *paced* meaning the loop sleeps until
the next deadline rather than spinning. The window plumbing (`AppConfig`
widget mode, transparent clear, `max_fps` pacing) went upstream in
[#125](https://github.com/pocket-stack/pocketjs/pull/125) and is being
generalized as [WIDGET.md](WIDGET.md)'s `shell`.

The alternatives, and why they lose *here*:

| Shell | Principle | Why not |
| --- | --- | --- |
| Electron | bundle Chromium + Node; full web ecosystem | the measured baseline being compared against |
| Tauri | reuse the system WebView, Rust backend | fixes the memory story, not the rendering one — per-frame 3D is still rAF-driven JS inside a WebView, its worst workload |
| Unity / Godot | mature VRM ecosystems (UniVRM, godot-vrm) | a game engine's resting heart rate is antithetical to "idle costs almost nothing"; frameless transparent overlays are second-class there |
| Swift/AppKit + Metal | leanest possible build | platform lock-in, and loses the reusable core/surface/guest pattern the runtime family shares |

## 5. VRM rendering: engine crates, not three-vrm, not bevy_vrm

A primer if VRM is new: it's an open humanoid-avatar standard (a glTF
extension) specifying skeleton naming, blend-shape expressions, and —
crucially — the spring-bone physics that make hair and clothes sway.
Everything is documented; you can implement it from the spec.

That matters because airi's *actual* out-of-the-box character is
**Live2D**, a 2.5D mesh-deformation format ubiquitous in VTubing — and
rendering its `.moc3` files requires linking Live2D's proprietary,
closed-source Cubism Core, which cannot be vendored into an open runtime.
So the parity target is airi's VRM stage, with the identical model
(VRoid's AvatarSample_A), identical idle animation, identical source URLs.
Apples to apples.

VRM support was built as generic crates and PR'd upstream (#125):
`pocket-vrm` (VRM 0.x parsing, VRMA retargeting, spring-bone verlet solver,
eye look-at) and morph-target/pose machinery in `pocket3d`. Two details
carry most of the performance story:

- **Blinking is free while it isn't happening.** Facial expressions use
  morph targets: the artist pre-sculpts a "closed eyes" mesh and the
  runtime interpolates vertex positions by a weight. The naive approach
  interpolates and re-uploads every frame; here morph deltas are computed
  and uploaded **only when a weight changes**. A blink is a 0.2 s sine
  pulse every 1–6 s — over 95 % of frames pay literally zero for the face.
- **Hair physics is a few vector ops.** Spring bones are chains of point
  masses solved with verlet integration — velocity represented implicitly
  as "current minus last position," a couple of adds per particle per
  frame. The math was never expensive; airi pays for running it in
  allocating, GC'd JavaScript. Here it's preallocated Rust arrays stepping
  allocation-free.

The alternatives:

- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — the most mature
  VRM runtime anywhere, and it's three.js: airi's path.
- [bevy_vrm](https://github.com/unavi-xyz/bevy_vrm) — essentially the only
  off-the-shelf Rust option (VRM 0.0/1.0), but it brings all of Bevy's ECS
  and render graph with it. The game-engine tax again.
- UniVRM — official, excellent, requires Unity.
- Writing the solver from the public spec was a bounded amount of work in
  exchange for a crate any Pocket app can now use.

## 6. The scripting layer: QuickJS, not V8

JS-engine selection has a simple intuition: V8 is fast because of its JIT,
and the JIT costs tens of megabytes of baseline memory plus a heavyweight
runtime. But this guest reads a few properties per tick — **throughput is
irrelevant; footprint is everything**. QuickJS is ~1 MB, JIT-free, and
starts in microseconds: the exact sweet spot for "policy only."

Why JS rather than Lua or Rhai (both even cheaper to embed)? Because plugin
authors write **TypeScript** — the typed SDK (`plugin-sdk/character.ts`) is
the plugin contract, and Bun bundles it. The type system is part of the
product surface. WASM (wasmtime, Extism) deserves a mention: strongest
sandbox, language-agnostic, and wrong for this shape of problem — every
host↔guest exchange crosses a serialization boundary, exactly the wrong
trade when the pattern is "hand the guest a state object every tick."
QuickJS mounts plain JS objects directly.

## 7. Content: plugins are data, not code

The content architecture has three layers:

```
runtime host
  ├─ character plugin  (VRM + VRMA + policy bundle + render framing)
  ├─ background plugin (one WGSL pixel function + compositor defaults)
  └─ vibe preset       (character id + background id + tracking/output)
```

A character plugin is a `plugin.json` manifest pointing at a model,
animations, a policy bundle, and framing parameters (FOV, anchor height,
camera distance). A background plugin is a manifest plus one WGSL shader —
literally a pure function from pixel coordinates to color. A vibe is a JSON
file containing only IDs: "this character + this stage + these settings."

The load-bearing rule: **the host recognizes no specific character.** It
consumes manifest paths. A character whose model has licensing restrictions
lives outside the repo via `.gitignore`, but architecturally it is not a
special case — just another manifest the host has never heard of.

Both places where plugins get to *execute* anything — the QuickJS bundle
and the WGSL function — are sandboxes; neither can touch the host process.
Compare the classic alternative, dynamic-library plugins (`dlopen`):
unlimited power, and a plugin crash is a host crash with no security
boundary anywhere. The WASM component model sandboxes as well but brings a
heavy toolchain. For "swap the skin, swap the personality," data-driven is
exactly the right amount of power.

## 8. Face tracking: a MediaPipe sidecar over the narrowest pipe

To drive the character from a real face, a Python sidecar runs Google's
MediaPipe and emits **52 blendshape coefficients** — semantic values like
"left eye closed: 0.8," "mouth smile: 0.3." The 52 names were defined by
Apple's ARKit and became the industry's de facto face-tracking vocabulary,
which is convenient: they map almost directly onto VRM expressions.

Three deliberate moves:

1. **Process isolation behind a narrow protocol.** The sidecar emits
   newline-delimited JSON and nothing else; MediaPipe's internal result
   objects are explicitly not allowed to leak into the host. Swap the
   tracker tomorrow — the host doesn't change. No networking; frames are
   never persisted.
2. **Shared-memory frames.** The camera is opened once, by the host;
   frames reach Python through an mmap ring. No second camera claim, no
   copies.
3. **A hybrid escape hatch.** A `--face-only` flag keeps body and hands on
   Apple's native Vision path. Why hybrid: Vision gives facial geometry but
   *not* blendshape coefficients — expressions would have to be
   reverse-engineered from landmarks. MediaPipe gives the coefficients
   directly. Each does what it's best at.

The alternatives map the landscape: ARKit's TrueDepth tracking is the
quality ceiling, but Macs have no TrueDepth camera — VTubers bridge an
iPhone as a peripheral, a fine hobbyist workflow and a terrible onboarding
story. OpenSeeFace is the beloved community veteran that newer models have
outrun. NVIDIA Maxine needs an NVIDIA GPU; on a Mac, that's a no.
(Kalidokit-style libraries solve the *next* link — landmark → rig solving —
which here is done on the Rust side.)

## 9. The virtual camera: convincing Zoom you're a webcam

The most platform-flavored piece (design in the pocket-character repo's
`docs/virtual-camera.md`; Swift host + extension skeleton in
`native/PocketLiveCamera/`). The goal: a "Pocket Live Camera" entry in
Zoom's device list showing the final composed program — character, virtual
background, effects — never the raw webcam, never the debug HUD.

Zoom only trusts devices in the OS camera list, so you must register a fake
camera with the system. macOS has a before-and-after story here. The old
mechanism, DAL plugins, worked by **injecting your code into Zoom's own
process** — unsandboxed, routinely rejected by hardening policies,
deprecated by Apple in macOS 12.3. The modern mechanism is the
**CoreMediaIO Camera Extension** (macOS 12.3+): the fake camera is a
separate, sandboxed system-extension process. OBS migrated to it in v28 for
the same reasons. Depending on OBS's virtual camera instead would make
"user has OBS installed" a product prerequisite and route the program
through OBS; Syphon/NDI share textures between production tools but never
appear as a camera to conferencing apps.

The design works like a post office with the OS as the mail carrier. The
extension publishes one device with two same-format streams:

```
Pocket Live host ──frames──▶ sink stream ("Pocket Live In")
                                │  OS handles IPC, validation, fan-out
                                ▼
                     extension keeps only the newest frame
                                │  re-emitted on a steady 30 fps clock
                                ▼
              source stream ("Pocket Live Camera") ──▶ Zoom / Teams / FaceTime
```

Host and Zoom never touch. Permission prompts, buffer validation, multiple
simultaneous readers — all the OS's problem.

Three decisions worth stealing:

- **The render thread never waits for the camera.** A GPU frame reaches the
  system via GPU→CPU readback, which is slow; the design rotates three
  staging buffers with async map callbacks, and if all three are busy the
  frame is dropped and a counter incremented. For live video, dropping
  beats queueing — latency is the product.
- **Prove the platform before optimizing.** v1 accepts a full readback plus
  one row-copy per frame (720p30 ≈ 111 MB/s — comfortably affordable) and
  explicitly refuses wgpu's unstable HAL for zero-copy IOSurface interop.
  Step one of the plan: get a template extension signed, notarized,
  installed, and *enumerated by Zoom* — because signing and system-extension
  approval are where the project can actually die, not throughput.
- **Privacy as a state machine, not a policy.** The extension never opens
  the real camera (it doesn't even request the entitlement). If the host
  stops publishing for 500 ms, viewers see a "paused" placeholder generated
  inside the extension. No failure mode — none — falls back to the real
  face.

## 10. The whole thing on one napkin

```
┌─ desktop widget (the 1-process core) ────────────────────┐
│                                                           │
│  Rust @ 60 Hz                 QuickJS sandbox (low-freq)  │
│  anim → blink → springs ◀── commands ── policy bundle     │
│  → wgpu draw       ── facts ──▶   (new character =        │
│        │                           new bundle)            │
│                                                           │
│  content is data: plugin.json + VRM + WGSL + vibe.json    │
└──────┬──────────────────────────────▲────────────────────┘
       │ 720p BGRA frames             │ blendshapes (NDJSON)
       ▼                              │
 CMIO system extension          MediaPipe sidecar
 (the fake camera)                    ▲ shared-memory frames
       │                              │
       ▼                              │
     Zoom                    real camera (tracking only)
```

An honest process count first: with everything on, this is **three
processes of our code** (host, MediaPipe sidecar, camera extension), not
one. The 1-process figure is the parity-scope widget, and stays true
whenever tracking and the camera are off. The distinction worth defending
is *why* each extra process exists. Electron's 8 arrive before you draw
anything — they are the vehicle. Pocket Live's extras each mark a boundary
that genuinely wants to be a process: the sidecar quarantines a Python/ML
runtime behind a JSON pipe (crash it, the character keeps idling), and the
camera extension is OS-mandated — sandboxed, running even when the host is
dead, which is exactly what lets it show a placeholder instead of your real
face when Pocket Live crashes. Processes bought at isolation boundaries,
not paid as vehicle tax — and both terminate with their feature; idle cost
returns to the one-process baseline.

Every seam in this diagram is a **narrow, boring protocol**: plain JS
objects (facts/commands), JSON lines, BGRA bytes behind a C struct. Any box
can be replaced without the others noticing.

That is also the honest way to summarize the alternatives question.
Electron, three-vrm, bevy_vrm, V8, OBS's virtual camera, ARKit-over-iPhone
— none of them are wrong, and most are the *pragmatic* choice for someone
shipping fast. They just each violate one of this project's two invariants
somewhere: **idle costs almost nothing**, and **the host knows nothing
about specific content**. Hold those two lines, and the rest of the
architecture more or less designs itself.

Measurement methodology, from-scratch build steps, and the full airi
comparison — including how to script airi into VRM mode for a fair fight,
and the CPU-percentage footgun in Activity Monitor — live in the
pocket-character repo's README and REPORT.
