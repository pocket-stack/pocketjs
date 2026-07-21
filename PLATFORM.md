# From launcher to platform — the Pocket app-runtime roadmap

LAUNCHER.md specifies what ships today: one EBOOT, every admissible app
embedded, whole-guest switching behind three append-only surface ops. This
document is the forward design: what turns that launcher into a platform —
a mini-app runtime with an install story, a system transition, and a DX
that stays instant — without breaking the contracts that got us here.

The one-line thesis: **Pocket is already most of a mini-app runtime, and
its unfair advantage is determinism.** Same bundle + same inputs = same
bytes on screen, on every host. That means third-party packages can be
admission-checked, golden-verified and byte-audited by CI — platform
review as a pure function, not a queue of humans.

## Layers (what exists, what's missing)

| layer | contents | status |
|---|---|---|
| L0 contract | spec.ts ISA, append-only ops, capability registry, manifest admission | SHIPPED — the platform's constitution |
| L1 hosts | psp / vita / sim / web against one HostOps contract; guest lifecycle (boot/teardown/switch) | switching shipped on psp + sim; vita inherits when the lifecycle is lifted out of main.rs |
| L2 distribution | `.pocket` package, on-device install, host-relay push | DESIGNED HERE, not built |
| L3 experience | launcher-as-Home, switch veil, DevTools time travel | launcher shipped; veil below |

Rule 5 of RUNTIMES.md stays the platform's first law: every capability a
guest can observe is a surface op behind a capability id — never a host
branch. The launcher followed it (ops 39..41) and stayed testable on every
host; distribution must follow it too.

## The switch veil (system transition)

A guest swap has a dead window: teardown is instant but the incoming
bundle's `JS_Eval` blocks the worker for 0.3–0.5 s (dev-trace builds print
boot stages there, which is the "QuickJS log stream" seen on hardware;
production builds hold the last frame). The veil turns that window into a
designed moment:

- After the outgoing frame presents (and the summon shot is captured), the
  HOST owns the GE. It plays a short direct-drawn animation — ~24 vblanks:
  frozen shot (or stage black) dimmed underneath, the baked Pocket mark
  fading in centered, a highlight sweeping across it — then starts the
  eval. The display holds the settled last veil frame through the eval,
  and the incoming guest's first present replaces it.
- Everything is host-side and asset-baked (the mark rasterizes from
  `assets/brand/` at build time into an embedded RGBA texture; the sweep
  is vertex-alpha strips over the same texture, additive-blended — the
  PSP-era way to mask a glow to a glyph without a second texture).
- The guest never knows. No op, no capability, no sim/golden impact: veil
  frames present outside the input-indexed frame loop, so the capture
  identity (input at frame N ↔ file fN) and the e2e switch signature are
  untouched.
- Budget: one 128×128 RGBA texture (64 KB rodata) + ~100 lines of GE code.

Two refinements stack on top later, both cheap: the launcher can play a
200 ms card-zoom before calling `appLaunch` (pure JS, no host change), and
qjsc bytecode (below) shrinks the hold the veil is papering over.

## `.pocket` — the package format (draft)

One file per app, produced by `pocket pack`:

```
magic  "PCKT" u32 version
u32    manifest length   -> pocket.json (verbatim, the SAME file the
                            build resolver admitted)
u32    js length         -> dist/<output>.js bytes
u32    pak length        -> dist/<output>.pak bytes
u32    cover length      -> 256×128 cover PNG (deck display)
u64    fnv1a64           -> over everything above (the existing build-
                            identity algorithm, scripts/bundle-hash.ts)
```

Design rules:

- The manifest travels INSIDE the package and is re-admitted on device
  (below) — a package is self-describing, never trusted by filename.
- The hash footer makes torn copies and stale syncs self-announcing — the
  same tripwire philosophy as the embedded-bundle hash (a stale embed once
  burned two rounds of hardware verification; distribution inherits the
  lesson for free).
- Corrupt or inadmissible packages fail into the launcher's existing
  broken-guest path (log + return to deck), never a halt.

## Dynamic install & runtime admission

- **Loading**: the eval path already treats bundles as data — the PSP host
  reads `.pocket` files from `ms0:/POCKET/apps/` into the arena and evals
  exactly like an embedded entry (svc/video proved runtime file IO). The
  appTable becomes the union of embedded entries and scanned packages;
  covers come from the package. Memory model is unchanged except the
  current app's js+pak live in the heap instead of rodata — the budget
  table gains one line.
- **Admission on device**: build-time admission is
  `validateAndResolveBuildPlan`, a pure function. The device re-runs the
  decision — either a minimal Rust port of the capability-superset +
  viewport check, or (simpler first step) the pack tool embeds the
  resolved plan and the device verifies plan.target/abi/viewport against
  its own profile. Either way: no capability, no boot — same rule as the
  build.
- **Channels, honestly ordered**: (1) copy to the memory stick — works
  today, zero code; (2) `pocket push` over the existing USB svc relay —
  the Mac downloads, verifies, writes to ms0; (3) wireless on-device
  fetch — LAST, because the PSP has no TLS and an 802.11b radio; the
  trusted downloader stays on the tethered host. Every step e2e-testable
  before the next.

## Bytecode (the eval wall)

QuickJS evals ~100 KB of source in ~0.3–0.5 s at 333 MHz; that is the
whole switch latency. qjsc bytecode loads 5–10× faster and shrinks
bundles. Plan: `pocket pack --bytecode` emits qjsc output alongside source
(sim keeps evaling source — the wasm core has no qjsc), the PSP host
prefers bytecode when the package carries it, and the bundle hash covers
whichever form is embedded. Risk to manage: bytecode pins the exact
QuickJS version — the package header gains an engine-abi field, and a
mismatch falls back to source.

## Memory governance

The PSP-1000's 24 MB is the floor and texture heap is the cliff (the
reflection feature OOM'd it once — the handler parks on vblank, which in
PPSSPPHeadless looks like a silent timeout). Platform rule: `pocket pack`
computes a per-app memory line (js + pak + expected texture heap) and the
launcher displays it; admission warns when a package cannot fit the
device's arena. Budgets become data, not folklore.

## The DX pipeline (what keeps it silky)

The launcher's hardware round found four bugs invisible to the sim
(nearest-sampling shimmer, the affine seam kink, the texture-heap OOM,
4-bit-alpha banding) — PPSSPP's software GE caught three, real hardware
the rest. That gradient is the platform's QA design:

1. **sim** — second-scale iteration, deterministic traces, tree asserts;
2. **PPSSPPHeadless** — the real GE semantics (affine sampling, texture
   cache quirks, RAM ceiling) under baked input scripts;
3. **hardware** — PSPLINK hot-reload (`reset` → `ldstart`), trace file
   over host0:, `pspsh cp` to install to the stick.

Single-command chains (`launcher.ts scan|covers|build`), append-only
contracts, and goldens as gates keep third-party DX at "write TSX → see it
in a second → one command to the handheld."

## Non-goals (so the platform stays honest)

- No suspend/resume state for guests — resume is relaunch, the frozen
  shot is an affordance. A KV-style `app.state` op can come later as its
  own capability; nothing in the switch protocol presumes it.
- No on-device code signing theater — the hash footer is integrity, not
  security; the PSP's threat model is a memory stick.
- No host branches for "special" apps — the launcher itself is an
  ordinary manifest app and must stay one.
