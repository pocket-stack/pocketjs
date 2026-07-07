PocketJS just grew an animation engine. Not a tween helper — a compile-time keyframe system with CSS-grade choreography, a stroke-arc primitive, and a real 3D transform pipeline, all running at a locked 60 FPS on a 2004 Sony PSP. The homepage hero is running it right now, live in WebAssembly; on hardware it is the same Rust core behind the same binary style table.

<img class="w-full rounded-xl border border-line" src="/assets/blog/page-3d.gif" alt="The 3D page of the motion studies: a swinging door, spinning cubes, a rising slab, a stretching cube, page flips and a room transition — every face a projected quad" />

The forcing function was a fidelity exercise: port a set of [yui540](https://yui540.com/)'s motion studies — beautifully engineered functional-UI animations written in CSS `@keyframes` — *one-to-one*, timings, easings and all, onto a machine with a 333 MHz MIPS CPU, no CSS engine, and an 8 MB memory budget. Feature parity was the contract; the interesting engineering came from everything that contract flushed out. This post covers the architecture and the four hardware lessons that shaped it.

## Keyframes that compile away

PocketJS already compiled Tailwind classes into a binary style table at build time. Animations follow the same philosophy: you author `keyframes` and `animation` in the exact shape of a `tailwind.config.js`, and the compiler bakes every referenced animation into frame-precise, per-property segment timelines inside `styles.bin`:

```ts
// pocket.config.ts
theme: {
  keyframes: {
    "menu-open":  { from: { width: 38 }, "60%": { width: 144 }, to: { width: 141 } },
    "menu-close": { from: { width: 141 }, "60%": { width: 31 }, to: { width: 38 } },
  },
  animation: {
    "menu-pill": {
      value: "menu-open 0.6s ease-in-out 0.2s both, menu-close 0.6s ease-in-out 1.2s forwards",
      loop: "4000ms",
    },
  },
}
```

```tsx
<View class="w-[38] h-[38] rounded-[19px] bg-white overflow-hidden animate-menu-pill">
```

<img class="rounded-xl border border-line" src="/assets/blog/menu.gif" width="231" alt="The menu study: a pill stretches open, three dots morph into an X, editor icons bounce in — all from class utilities" />

At runtime the core never parses a string. A timeline is pure data — *property P goes from bits A to bits B over frames [t₀, t₁) under easing E* — sampled once per tick at a fixed dt of 1/60 s. That fixed timestep is load-bearing: frame content is a pure function of the frame index, which is what lets the same animation render byte-identically on the PSP's GPU, in the browser through WebAssembly, and headless under Bun where our golden tests diff PNGs byte-for-byte.

Full CSS shorthand semantics survive the bake: comma lists with independent delays, `forwards`/`backwards`/`both` fills, `reverse` (baked as flipped segments), `infinite`, and `cubic-bezier(…)` — including the named easings, which bake to their canonical browser curves rather than approximations. Comma-list precedence works the CSS way too: the last animation currently *applying* a property wins, so an intro that fills forwards hands off to an outro that starts later, with no JavaScript sequencing anything.

Bake-ability is enforced loudly. Keyframe values must be build-time absolute — a `translateX(-50%)` or a `calc()` is a compile error, not a silent guess, because the core has no reference box at runtime. It is the same rule that already governed `rounded-full`, extended to motion.

## The loop CSS cannot write

One thing plain CSS cannot express: *replay this whole comma list — delays included — every N milliseconds*. The original studies loop by remounting the page. PocketJS adds a style-level loop period instead:

```tsx
<View class="… animate-dpad-up" />   // "dpad-up 0.5s ease-in-out both,
                                     //  dpad-up 0.5s ease-in-out 2s forwards"
                                     //  + loop: "4000ms"
```

<img class="rounded-xl border border-line" src="/assets/blog/dpad.gif" width="231" alt="The d-pad study: four pentagon keys press outward in a strictly uniform 0.5s cadence that wraps seamlessly" />

Every node's animation clock wraps modulo the period, so a whole page of tiles restarts in sync — and because 8 press slots × 0.5 s exactly equals the 4 s loop, the d-pad's cadence is seamless across the wrap. No remounts, no timers, no drift.

## An arc is a primitive, not a hack

The reload study draws an SVG circle stroke with animated `stroke-dasharray`/`dashoffset` inside a rotating container. There is no path renderer in the core, and faking it with dots would betray the whole exercise. So the engine gained an **arc primitive**: `arc-start`, `arc-sweep` and `arc-width` turn a node's background into a round-capped annular sector, and all three are animatable.

```ts
// The dasharray draw + container rotation, sampled into two baked tracks:
"reload-arc-start": { "0%": { arcStart: 45 }, /* … */ "100%": { arcStart: 637 } },
"reload-arc-sweep": { "0%": { arcSweep: 0 },  /* … */ "100%": { arcSweep: 315 } },
```

<img class="rounded-xl border border-line" src="/assets/blog/reload.gif" width="231" alt="The reload study: stroke arcs wind clockwise while drawing on, refresh icons spin — the arc is an engine primitive" />

The compiler samples the combined motion — rotation plus dash-window advance — into keyframe stops, so the visible arc winds ~1.6 clockwise turns per cycle exactly like the CSS original. The rasterizer is deterministic supersampled coverage with squared-distance ring tests (no `sqrt` in the inner loop) and per-row span clamping, because it runs every frame on a 333 MHz CPU.

## 3D, projected by the core

The highlight: [motions/64](https://yui540.com/motions/64) is real CSS 3D — `perspective`, `preserve-3d`, cubes built from six `rotateX/rotateY/translateZ` faces, a room the camera sits inside. PocketJS now models the useful subset: `perspective-[N]` marks a node as a **3D context root**; its whole subtree composes 3×4 affine matrices, projects through the perspective distance about the root's center, and painter-sorts every quad by camera depth before clipping into triangles.

```tsx
<View class="absolute inset-0 opacity-70 perspective-[190]">
  <View class="absolute left-[32] top-[36] w-[28] h-[28]
               rotate-x-[-40] translate-z-[-14] animate-spin3d">
    <View class="absolute inset-0 bg-[#888] translate-z-[-14]" />
    <View class="absolute inset-0 bg-[#999] translate-y-[-14] rotate-x-[90]" />
    <View class="absolute inset-0 bg-[#bbb] translate-y-[14] rotate-x-[90]" />
    <View class="absolute inset-0 bg-[#aaa] translate-x-[14] rotate-y-[90]" />
    <View class="absolute inset-0 bg-[#ccc] translate-x-[-14] rotate-y-[90]" />
    <View class="absolute inset-0 bg-[#888] translate-z-[14]" />
  </View>
</View>
```

<p>
  <img class="inline-block rounded-xl border border-line align-top" src="/assets/blog/spin.gif" width="231" alt="Two cubes: one spinning forever on Y, one somersaulting on X — six faces each, painter-sorted per frame" />
  <img class="inline-block rounded-xl border border-line align-top" src="/assets/blog/room.gif" width="231" alt="The room transition: the camera sits inside a box that turns from wall A to wall B — the letters are baked path textures riding the walls" />
</p>

`rotateX`/`rotateY`/`translateZ` are ordinary keyframe properties, so the cube spin is just another baked timeline. Textures work in 3D too: a new `TEX_TRI` DrawList op (implemented in the wasm software rasterizer, the desktop wgpu renderer and the PSP GPU backend) carries UVs through the polygon clipper, which is how the room's letters — baked SVG path textures — rotate *with* their walls instead of floating upright. The same op un-culled 2D-rotated images as a side effect. Texture sampling is affine in screen space, no perspective-correct divide: exactly what the PSP's GPU does natively, so the era-authentic warble is a feature.

## What the hardware taught us

Everything above ran beautifully in the browser on the first try. The PSP had opinions. Four of them reshaped the engine — each one measured on the device over PSPLINK with microsecond timers baked into the executable, because every one of these hypotheses *sounded* plausible and only one number at a time proved which was real.

**Rounded corners were 7 ms.** The old renderer emitted antialiased rounded boxes as per-row coverage spans — elegant, deterministic, and 40% of the frame budget on a screen full of rounded tiles. Flat rounded corners now render as four sprites sampling a lazily baked antialiased disc texture, plus three rects: O(1) DrawList ops per box. Gradients keep the exact span path.

**Layout was rebuilt from scratch every frame.** Keyframes animating `width`/`top` dirty layout at 60 Hz, and relayout used to rebuild the entire taffy tree each time. Layout is now incremental: style-only changes restyle just the dirty nodes in the live tree and let taffy recompute the affected subtrees; only structural changes (mounts, unmounts, text edits) rebuild. The refactor was gated on the golden suite staying byte-identical — it did.

**A cache with per-frame keys is a jank generator.** The circular-reveal study scales a `rounded-full` splash 18×, which means a *different radius every frame* — and the disc cache happily baked a fresh texture for each one. First visit to that page: a 118 ms frame. Every visit after: silky, because the cache was now full of single-use textures. The fix is a key-discipline rule, not a bigger cache: discs bake only for radii ≤ 32 px (recurring UI corners), everything else takes the analytic span path.

<img class="rounded-xl border border-line" src="/assets/blog/reveal.gif" width="231" alt="The circular reveal study — the splash whose per-frame radius exposed the cache-key lesson" />

**The GPU can hide from your profiler.** With all of the above shipped, one moment still stuttered — and the bench swore every frame fit the budget. It was sampling *before* `sceGuSync`: the GPU's execution tail (4.9 ms) ran serially after the CPU's 13 ms, invisible to the counters, 17.7 ms of real wall time. The frame loop is now pipelined the way PSP games always did it:

```text
serial:      [ CPU N ][ GPU N ]│[ CPU N+1 ][ GPU N+1 ]│   17.7 ms wall
pipelined:   [ CPU N+1        ]│[ CPU N+2        ]│        max(CPU, GPU)
             [ GPU N     ]─────│[ GPU N+1   ]─────│        + 1 frame latency
```

The GPU draws frame N−1 while the CPU builds frame N; the sync waits only for the leftover — measured at 42 µs. Worst-case overlap window on hardware: 13.9 ms CPU, locked 60 FPS. The deterministic-capture contract survived the reordering (dumped frames are indexed by what was *presented*), so the emulator-based end-to-end goldens stayed byte-exact.

The journey, in numbers — average work per frame on the busiest page:

| stage | avg / max per frame |
|---|---|
| baseline (all features, no tuning) | 17.4 / 21.7 ms |
| + disc corners, incremental layout | 10.4 / 17.7 ms |
| + radius cap, arc row-clamp | 9.8 / 16.0 ms |
| + pipelined frame loop | **13.9 ms CPU ∥ GPU, every frame < 16.7 ms** |

## The point

None of this is a demo hack. The keyframe baker, the loop period, the arc primitive, the 3D projector and the pipelined loop are engine features behind Tailwind-shaped utilities; the demo contributes nothing but a config file, some geometry and a few baked SVG icons. The audit is one grep long: the engine tree contains no reference to the demo.

Try it: the [homepage](/) hero is the motion studies live in WebAssembly, and the [playground](/playground/) opens the same source ready to edit — change a keyframe stop and the whole choreography recompiles under your cursor. On a real PSP, `bun psplink` and pick *Motion Lab*.
