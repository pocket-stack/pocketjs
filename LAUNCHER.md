# The Pocket Launcher — in-device app switching

One EBOOT, every compatible app inside, a Cover Flow picker on top. This
document is the contract for the multi-app host, the three `app*` surface
ops, and the SELECT summon policy. RUNTIMES.md owns the ontology; nothing
here changes it — a launcher is an ordinary Guest that happens to pick the
next Guest (rule 5: the capability is a surface op, not a host branch).

## Model

The runtime stays `⟨Cores, Surfaces, Guest⟩` with exactly ONE guest alive at
a time. "Switching" is the same whole-guest swap every host already performs
(browser `load()`, pocket-mod drop-and-rebuild, golden's per-demo fresh
core): finish the current frame, tear the guest down (free the QuickJS
runtime, drop the `Ui` core), boot the next bundle from scratch (fresh core,
pak feed, fresh realm, eval). There is no suspend: **resume = relaunch**.
The frozen last frame of the interrupted app is a visual affordance handed
to the launcher, not a saved state.

What IS new: the host can hold more than one embedded bundle, expose the
table of them to the guest, accept a switch request, and reserve SELECT as
the system summon chord.

## Surface ops (spec.ts, append-only)

| op | name | signature | semantics |
|----|------|-----------|-----------|
| 39 | `appTable` | `() -> string` | JSON `{ apps: [{output, id, title}], current, resume }`. `current` is the running bundle's output name; `resume` is the app interrupted by the last SELECT summon (null after a cold boot or an explicit launch). Hosts without app switching omit the op (same rule as `debugStats`). |
| 40 | `appLaunch` | `(output: string) -> 0\|1` | Request a switch. The host finishes the CURRENT frame (draw + present), then swaps guests before the next one. Returns 0 for an unknown output (no switch scheduled). Calling it with `current` relaunches fresh. |
| 41 | `appShot` | `() -> handle \| -1` | Texture handle of the frozen frame captured when the running app was summoned away: 256×128 PSM_8888, the 480×272 framebuffer center-cropped to 2:1 and box-downscaled. Valid in the guest booted by a summon until the next switch; -1 otherwise. |

`@pocketjs/framework/launcher` wraps these (`appTable()`, `launchApp()`,
`frozenShot()`, `launcherActive()`) and degrades to `null`/no-op on hosts
that lack the ops, so the launcher bundle itself stays admissible anywhere.

## SELECT summon policy (host-owned)

A multi-app host (APPS table length > 1) reserves SELECT:

- Guests other than the launcher NEVER see the SELECT bit — the host strips
  `0x0001` from the mask before `frame(mask, analog)`.
- On a SELECT press-edge (host-tracked, not guest-latched) the host captures
  and downscales the framebuffer, then switches to the launcher with
  `resume = <interrupted output>`.
- While the launcher itself runs, SELECT is forwarded untouched (the
  launcher binds it to resume; CIRCLE does the same).

Single-app EBOOTs have an APPS table of length 1: no interception, no ops
behavior change, bit-identical to today's builds. Apps that bind SELECT
(e.g. Pocket Talk) keep it in their standalone EBOOTs and lose it under the
launcher — that is the price of a system chord, stated here once.

## Admission

The embedded set is COMPUTED, not curated: every `demos/*/pocket.json` whose
manifest resolves against the `psp` target profile via
`validateAndResolveBuildPlan` (the same admission gate `pocket build` runs —
capability superset + viewport fit). Today that admits 15 demos and excludes
`ipod-nano` (176×132 panel) and `note` (dynamic viewport). The registry tool
prints per-app bundle sizes and takes `--exclude <output>` for RAM budgeting;
nothing is silently dropped.

## Memory math (PSP-1000 floor)

24 MB user RAM. The EBOOT (host code ≈ 2.5 MB + 15 bundles ≈ 8.5 MB + covers
≈ 1 MB) sits in .rodata ≈ 12 MB; the arena takes the remaining free memory
minus its 2 MB margin ≈ 10 MB — comfortably above the 2–4 MB a demo's
QuickJS heap needs. Teardown returns a guest's allocations to the arena's
segregated free lists; classes are power-of-two so cross-swap reuse is exact
and fragmentation does not accumulate by construction.

## Build pipeline

`bun scripts/launcher.ts` owns the artifact chain:

1. **scan** — resolve every demo manifest for `psp`, dedupe by `app.output`,
   emit `dist/launcher-registry.json` + `demos/launcher/registry.generated.ts`.
2. **covers** — boot each admitted app in host-sim, settle 90 virtual frames,
   render, center-crop 480×240, box-downscale to 256×128, write
   `demos/launcher/covers/cover-<output>.png` (generated, deterministic —
   the sim is the oracle, so goldens over cover-bearing frames stay stable).
3. **build** — `pocket compile` every admitted app + the launcher, then the
   PSP backend with `POCKETJS_LAUNCHER_REGISTRY=dist/launcher-registry.json`.
   `native/build.rs` embeds app 0 = launcher plus every registry entry and
   generates the `APPS` table; the FNV-1a64 build identity covers every
   embedded byte in table order (`scripts/bundle-hash.ts` twin grows the
   same mode), so the stale-embed tripwire keeps firing across all of them.

## Hosts

- **native (PSP)** — the reference implementation of everything above.
- **host-sim** — `host-sim/launcher.ts` drives the same protocol over
  per-guest `bootWorld`s: strips SELECT, performs the downscale with the
  same box filter, uploads the shot into the next world, answers the three
  ops. Switch flows are therefore deterministic traces, golden-able, and
  chaos-provable like any other scenario.
- **host-web / native-vita** — not wired in this change; the ops are absent
  there, which is exactly the degraded mode the framework wrapper handles.

## Verification

- `test/launcher-sim.test.ts` — admission matrix, the full
  launch/summon/resume protocol on the sim host policy runner
  (host-sim/launcher.ts), SELECT stripping + host-edge latching, and
  determinism (two identical journeys hash identically frame by frame).
- `test/e2e-launcher-ppsspp.ts` (`bun run e2e:launcher`) — the same journey
  on the REAL native host in PPSSPPHeadless with a baked input script. A
  switch discards exactly one presented frame, so the capture signature is
  exact: 217/220 files with gaps precisely at the three switch frames.
- Neither suite commits launcher pixels as goldens: covers are live sim
  renders of the other demos, and a committed deck PNG would break on any
  demo's visual change. Determinism is asserted by hash equality instead.
- Native gotcha the e2e caught: the GE leaves framebuffer alpha at 0, so
  the frozen-shot capture forces alpha 255 or the background blends away.
- Real-hardware pass: pending (PPSSPP software-renderer verified).

## The launcher app

`demos/launcher` — an ordinary manifest app (requires `text.glyphs.baked` +
`input.buttons`). Cover Flow built on the 2D core's perspective pipeline
(the same TEX_TRI path motions page 4 ships): one `perspective` root, one
2:1 cover card per app, center card flat, neighbors angled with `rotateY` ±
rail `translateX` + recession `translateZ`. Browse motion is short
`animate()` tweens retargeted per step (springs let a mashed d-pad outrun
the deck — a real-hardware find), so steady state still runs zero per-frame
JS. When summoned, the frozen shot stretches under a dim scrim — the
"overlay" is honest compositing inside one guest. LEFT/RIGHT steps, a held
d-pad key-repeats, holding the L/R triggers streams the deck at 10 cards/s
(each step retargets the tweens, so the deck glides); CROSS launches,
SELECT/CIRCLE resumes the interrupted app.
