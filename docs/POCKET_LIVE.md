# Pocket Live — a native live-performance runtime

*A VRM character, driven by your real face, performing on a composed stage,
delivered to Zoom as a camera — the full livestreaming chain as one small
native runtime. This page walks the chain stage by stage: what each piece
chose, the alternatives, and the principles that decided between them.*

This document is the design-rationale companion to
[pocket-character](https://github.com/pocket-stack/pocket-character) (the
repo Pocket Live grew out of) and to [WIDGET.md](WIDGET.md), which
generalizes its widget shell. The widget was the seed; the product is the
**live chain** built on top of it.

## 1. The product is a chain

A user picks a *vibe* — "牛来 · 百花奖舞台" is one JSON file: a character
id, a stage id, `tracking: camera`, `output_size: 1920x1080` — and goes
live. From that point five stages run continuously:

```
real camera ──▶ tracking (blendshapes + skeleton, NDJSON)
                   │
                   ▼
             character sim (VRM: expressions, motion, springs)
                   │
                   ▼
             stage compositor (background mode: virtual · camera ·
                   │            matte · clean · split · transparent)
                   ▼
             program output (fixed-size texture, e.g. 1920×1080)
                   │
                   ├──▶ on-screen preview / fullscreen per monitor
                   └──▶ virtual camera ──▶ Zoom / Teams / FaceTime / OBS
```

Every arrow is a narrow protocol, every stage is replaceable, and the
sections below take them in order. The design constraint that shapes all of
them: this chain runs for **hours**, next to the user's real meeting or
stream, on their own machine — so idle cost, latency, and privacy are
product features, not engineering hygiene.

## 2. The foundation, briefly

The rendering core descends from the pocket-character parity experiment —
the same character widget that costs 8 processes / 2184 MB / 44 % CPU on
Electron measured 1 process / 118 MB / 3.9 % on the Pocket stack. That
result, and the shell/VRM/guest split behind it, are covered in
[WIDGET.md](WIDGET.md) and the pocket-character repo; here it earns one
paragraph because everything below inherits its one rule:

> **Things that happen 60 times per second run in Rust. Things that happen
> occasionally run in JavaScript. Things that don't change at all are
> data.**

Concretely: winit + wgpu host, engine crates for VRM (`pocket-vrm`:
parsing, VRMA retargeting, verlet spring bones — upstreamed in
[#125](https://github.com/pocket-stack/pocketjs/pull/125)), and a QuickJS
guest that receives per-tick facts and queues intent commands. A
character's personality is a guest bundle, not a build. For the live
chain this foundation matters for one reason: **the character itself is
nearly free**, so the budget can be spent where live actually needs it —
tracking inference and video delivery.

## 3. Tracking: the performer's face and body

The chain's input stage turns the real camera into semantic control
signals. The launcher exposes it as `--tracking off | mock | camera`:
`off` is the idle widget, `mock` replays synthetic signals (develop and
demo the whole chain with no camera at all), `camera` runs the real
pipeline.

The real pipeline is two cooperating processes beside the host:

- **`mediapipe_face_bridge.py`** runs Google's MediaPipe Face/Pose/Hand
  Landmarker and emits **52 blendshape coefficients** — semantic values
  like "left eye closed 0.8," "mouth smile 0.3" — plus a small set of
  skeletal points. The 52 names were defined by Apple's ARKit and became
  the industry's face-tracking vocabulary; they map almost directly onto
  VRM expressions, which is the whole reason the character can mirror the
  performer without a hand-authored mapping layer.
- **`pocket-vision-bridge`** is the native Apple Vision path; a
  `--face-only` flag on the MediaPipe side keeps body and hands here. The
  hybrid exists because Vision gives facial *geometry* but not blendshape
  coefficients (expressions would have to be reverse-engineered from
  landmarks), while MediaPipe gives coefficients directly. Each does what
  it's best at.

Three rules keep the stage honest:

1. **Narrow protocol.** The sidecar emits newline-delimited JSON and
   nothing else; MediaPipe's internal result objects may not leak into the
   host. Swap the tracker tomorrow — the host doesn't change.
2. **One camera claim.** The host opens the camera once; frames reach the
   sidecar through a shared-memory ring (mmap, no copies, no second
   permission prompt, no device contention with the meeting app).
3. **No persistence, no network.** Frames are never written and never
   leave the machine. Tracking output is numbers, not pixels.

Alternatives, and why they lost:

| Tracker | Principle | Why not |
| --- | --- | --- |
| ARKit (`ARFaceAnchor`) | TrueDepth depth camera; the quality ceiling | Macs have no TrueDepth — VTubers bridge an iPhone as a peripheral; fine for hobbyists, terrible onboarding |
| Apple Vision only | native, zero extra runtime | no blendshape output; expressions from raw landmarks is a research project |
| OpenSeeFace | the beloved community veteran, pure RGB/CPU | newer models have outrun it |
| NVIDIA Maxine | best-in-class GPU inference | needs an NVIDIA GPU; not on a Mac |

## 4. The stage: characters, backgrounds, and the compositor

What the audience sees behind the character is the **background mode**, a
first-class launcher/vibe setting:

```
--background-mode  transparent | virtual | camera | matte | clean | split
```

- `transparent` — the desktop-widget mode: no stage, character over your
  desktop.
- `virtual` — a procedural stage: one WGSL pixel function per background
  plugin (the 百花奖 stage is ~a page of shader: film strips, gold
  particles, spotlight wash). No video decode, no image assets, resolution
  independent, costs microseconds per frame.
- `camera` — the real camera as the backdrop (character over your room).
- `matte` / `clean` — background replacement without a green screen. The
  clean-plate approach is the notable one: the background manifest carries
  `clean_plate_delay_seconds` — step out of frame, the compositor captures
  the empty room, and from then on "you" can be subtracted from the feed
  by difference against the plate. The alternative is ML person
  segmentation (MediaPipe selfie-segmentation and friends), which needs no
  choreography but costs continuous inference and produces the familiar
  hair-eating halo; a captured plate is free per-frame and pixel-exact for
  a static camera, which a desk setup is.
- `split` — side-by-side (real feed + character), the format for "show
  the performer and the puppet" comparisons; character plugins carry a
  separate `split_camera_distance` framing parameter for it.

Content above the compositor is **data, not code** — the three-layer
plugin architecture:

```
character plugin   plugin.json → VRM + VRMA + policy bundle + framing
background plugin  plugin.json → one WGSL function + compositor defaults
vibe preset        ids only: character + background + tracking + output
```

The host recognizes no specific character; it consumes manifest paths. A
model with licensing restrictions stays out of the repo via `.gitignore`
yet is architecturally unremarkable — just another manifest. The two
places plugins *execute* anything — the QuickJS policy bundle and the WGSL
function — are both sandboxes. The dlopen-style alternative (native plugin
libraries) offers unlimited power and no boundary: a plugin crash is a
show crash, mid-stream. For "swap the performer, swap the stage,"
data-driven is exactly the right amount of power — and it makes a *show*
reproducible: a vibe file is a complete, versionable description of a
performance setup.

## 5. Program output: the show is a texture, not a window

A window is a terrible video contract: it can be transparent, resized,
Retina-scaled, occluded, minimized, portrait-shaped. So the live chain
promotes the **program** to a first-class render target — a fixed-size
texture (vibes carry `output_size`, e.g. 1920×1080) that the scene,
stage, and effects render into. The on-screen window becomes a *preview*
blitted from that texture (`--fullscreen --monitor "DELL U2723QE"` for a
dedicated display), and every consumer downstream sees the same pixels
regardless of what the user does to the window.

The program contract is also a privacy line: final composition happens
*before* the texture, alpha forced to 1, debug skeletons / tracking
points / FPS overlays / window chrome excluded by construction, and the
raw camera feed can never become an implicit background — it participates
in tracking and in the modes that explicitly request it, nothing else.

## 6. Delivery: convincing Zoom you're a webcam

The most platform-flavored stage. Zoom only trusts devices in the OS
camera list, so the program must be registered as a camera. macOS has a
before-and-after story: the old mechanism, **DAL plugins**, injected your
code into Zoom's own process — unsandboxed, routinely rejected by
hardening policies, deprecated in macOS 12.3. The modern mechanism is the
**CoreMediaIO Camera Extension** (12.3+): the fake camera is a separate,
sandboxed system-extension process. OBS migrated to it in v28 for the
same reasons.

The design works like a post office with the OS as the carrier. One
device, two same-format streams:

```
Pocket Live host ──frames──▶ sink stream ("Pocket Live In")
                                │  OS handles IPC, validation, fan-out
                                ▼
                     extension keeps only the newest frame
                                │  re-emitted on a steady 30 fps clock
                                ▼
              source stream ("Pocket Live Camera") ──▶ Zoom / Teams / FaceTime
```

Host and Zoom never touch. Permission prompts, buffer validation,
multiple simultaneous readers — the OS's problem. Decisions worth
stealing:

- **The render thread never waits for the camera.** GPU→CPU readback runs
  through three rotating staging buffers with async map callbacks; if all
  three are busy the frame is dropped and counted. For live video,
  dropping beats queueing — latency is the product.
- **720p30 for v1, on purpose.** One readback plus one row-copy is
  ~111 MB/s — comfortably affordable — and most conferencing links
  re-scale and re-encode anyway. Zero-copy IOSurface interop via wgpu's
  unstable HAL is explicitly deferred until measurement demands it.
- **Prove the platform first.** Step one of the plan is a template
  extension, signed and notarized, *enumerated by Zoom* — because signing
  and system-extension approval are where this can actually die, not
  throughput.
- **Privacy as a state machine.** The extension never opens the real
  camera (it doesn't even hold the entitlement). Host silent for 500 ms →
  a locally-generated "paused" placeholder. No failure mode falls back to
  the performer's real face — the extension outliving a host crash is
  precisely what makes that guarantee enforceable.

The alternatives: depending on **OBS's virtual camera** makes "user has
OBS installed" a product prerequisite and routes the show through OBS;
**Syphon/NDI** share textures between production tools but never appear
as a camera to conferencing apps; **screen-sharing the window** surrenders
resolution, framing, and the privacy line all at once.

## 7. Measuring a live chain honestly

The parity experiment's methodology carries over, extended for the
multi-process reality: `measure-live.ts` walks the launcher's full process
tree, tags each process by role — `renderer`, `vision`, `mediapipe`,
`launcher` — and reports median/p10/p90 per role over a settled sampling
window. There is no pretending the chain is one process: **with
everything on, it is three processes of our code** (host, MediaPipe
sidecar, camera extension) plus the Vision bridge when active.

The distinction worth defending is *why* each process exists. Electron's
eight arrive before you draw anything — they are the vehicle. The live
chain's extras each mark a boundary that genuinely wants to be a process:
the sidecar quarantines a Python/ML runtime behind a JSON pipe (crash it,
the show keeps rendering and the character keeps idling), and the camera
extension is OS-mandated, sandboxed, and alive even when the host is dead
— which is exactly what §6's placeholder guarantee is made of. Processes
bought at isolation boundaries, not paid as vehicle tax; every one of
them terminates with its feature, and idle cost returns to the
one-process baseline.

## 8. The whole thing on one napkin

```
┌─ host (the 1-process core) ──────────────────────────────┐
│                                                           │
│  Rust @ 60 Hz                 QuickJS sandbox (low-freq)  │
│  anim → blink → springs ◀── commands ── policy bundle     │
│  → stage compositor ── facts ──▶  (new character =        │
│  → program texture                 new bundle)            │
│        │                                                  │
│  content is data: plugin.json + VRM + WGSL + vibe.json    │
└──────┬──────────────────────────────▲────────────────────┘
       │ BGRA frames                  │ blendshapes (NDJSON)
       ▼                              │
 CMIO system extension       MediaPipe / Vision sidecars
 (the fake camera)                    ▲ shared-memory frames
       │                              │
       ▼                              │
     Zoom                    real camera (tracking only)
```

Every seam is a narrow, boring protocol: plain JS objects
(facts/commands), JSON lines, BGRA bytes behind a C struct. Any box can
be replaced without the others noticing — and each section above listed
what it would be replaced *with*.

Two invariants decided every contested choice: **idle costs almost
nothing** (the show runs for hours beside real work), and **the host
knows nothing about specific content** (a performance is data — a vibe
file — not a build). The alternatives that lost — three-vrm, ML matting,
OBS's virtual camera, ARKit-over-iPhone, dlopen plugins — are mostly the
pragmatic choices for someone shipping fast; they just each break one of
those two lines somewhere.

Measurement methodology and build steps live in the pocket-character
repo's README and REPORT; the virtual-camera design in its
`docs/virtual-camera.md`; the plugin contract in its
`docs/PLUGIN_ARCHITECTURE.md`.
