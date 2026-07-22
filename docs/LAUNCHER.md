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
| 41 | `appShot` | `() -> handle \| -1` | Texture handle of the frozen frame captured when the running app was summoned away: the FULL 480×272 frame downscaled into 256×128 PSM_8888 (stored slightly squeezed; drawn at screen aspect, which undoes it). Valid in the guest booted by a summon until the next switch; -1 otherwise. |

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

The embedded set is COMPUTED, not curated: every `apps/*/pocket.json` whose
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

`bun tools/launcher.ts` owns the artifact chain:

1. **scan** — resolve every demo manifest for `psp`, dedupe by `app.output`,
   emit `dist/launcher-registry.json` + `apps/launcher/registry.generated.ts`.
2. **covers** — boot each admitted app in hosts/sim, settle 90 virtual frames,
   render, box-downscale the full frame to 256×128, write
   `apps/launcher/covers/cover-<output>.png` (generated, deterministic —
   the sim is the oracle, so goldens over cover-bearing frames stay stable).
3. **pack** — every admitted app + the launcher becomes a `.pocket`
   package (contracts/spec/pocket-package.ts, psp variant) under `dist/packages/`.
4. **build** — the PSP backend embeds those packages VERBATIM
   (`hosts/psp/build.rs` + the core reader extract js/pak zero-copy at boot);
   the FNV-1a64 build identity covers the package files in table order
   (`tools/bundle-hash.ts` twin), so the stale-embed tripwire keeps
   firing across all of them. Single-app EBOOTs keep the classic inline
   embed, byte-identical.

## Hosts

- **native (PSP)** — the reference implementation of everything above.
- **hosts/sim** — `hosts/sim/launcher.ts` drives the same protocol over
  per-guest `bootWorld`s: strips SELECT, performs the downscale with the
  same box filter, uploads the shot into the next world, answers the three
  ops. Switch flows are therefore deterministic traces, golden-able, and
  chaos-provable like any other scenario.
- **web (Pocket Stage)** — the pocketjs.dev hero boots the SAME launcher on
  the wasm core: `site/playground/host.js` `enableAppSwitching()` is the
  browser twin of the native policy (ops overlay per reset, SELECT
  stripping + summon edge, fetch-and-eval swap with the frozen shot
  re-uploaded), fed from `/stage/apps/` which the site build assembles from
  the registry. Verified headlessly by driving the protocol through
  PocketHost (site/verify.ts probe).
- **hosts/vita** — not wired; the ops are absent there, which is exactly
  the degraded mode the framework wrapper handles.

## Verification

- `tests/launcher-sim.test.ts` — admission matrix, the full
  launch/summon/resume protocol on the sim host policy runner
  (hosts/sim/launcher.ts), SELECT stripping + host-edge latching, and
  determinism (two identical journeys hash identically frame by frame).
- `tests/e2e/launcher-ppsspp.ts` (`bun run e2e:launcher`) — the same journey
  on the REAL native host in PPSSPPHeadless with a baked input script. A
  switch discards exactly one presented frame, so the capture signature is
  exact: 217/220 files with gaps precisely at the three switch frames.
- Neither suite commits launcher pixels as goldens: covers are live sim
  renders of the other demos, and a committed deck PNG would break on any
  demo's visual change. Determinism is asserted by hash equality instead.
- Native gotcha the e2e caught: the GE leaves framebuffer alpha at 0, so
  the frozen-shot capture forces alpha 255 or the background blends away.
- Real-hardware pass: DONE (PSPLINK, iterated live) — it found the clock
  never being set, the affine seam, the texture-heap OOM, 4444 banding,
  the crop deformation and the sweep seams; each fix is annotated at its
  site. PPSSPP's software GE reproduces most of these; the sim none.

## The launcher app

`apps/launcher` — an ordinary manifest app (requires `text.glyphs.baked` +
`input.buttons`). Cover Flow built on the 2D core's perspective pipeline
(the same TEX_TRI path motions page 4 ships): one `perspective` root, one
screen-aspect (192×109) cover card per app, center card flat, neighbors angled with `rotateY` ±
rail `translateX` + recession `translateZ`. Browse motion is short
`animate()` tweens retargeted per step (springs let a mashed d-pad outrun
the deck — a real-hardware find), so steady state still runs zero per-frame
JS. When summoned, the frozen shot stretches under a dim scrim — the
"overlay" is honest compositing inside one guest, over a baked Aqua-era
stage gradient. All four browse inputs (d-pad LEFT/RIGHT and the L/R
triggers) are ONE mechanism: holding scrubs the deck continuously through
fractional positions at 18 cards/s (per-frame `jump()`s; release tweens
home from the exact fraction), and a quick tap always lands exactly one
card — a flow that ends displaced never rounds back onto its origin.
CIRCLE launches the centered card — console convention; SELECT/CROSS
resume the interrupted app. XMB identity ships in `apps/launcher/psp/`
(Psp.toml + committed icon0/pic1, regenerated by the build's art step).
