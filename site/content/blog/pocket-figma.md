The Sony PSP is twenty-two years old: 333 MHz, 32 MB of RAM, a GPU with no shaders. For the past weeks we have been teaching it modern UI — our runtime, [PocketJS](/blog/introducing-pocketjs/), runs real Solid and Vue JSX components on it at a locked 60 FPS, and it has already [shipped a 3D shooter](/blog/shipping-openstrike/). But every screen so far was *ours*: our components, our layouts, sized to the machine. The honest test of a 2D UI runtime is a document drawn by someone who never once thought about your hardware — and the most demanding documents in the world come out of **Figma**.

So that became the challenge: open a real Figma Community file, as published. Not a cooked-up demo document — the [Paper Wireframe Kit](https://www.figma.com/community/file/1075811850250564922): 14,430 nodes, 2,293 component instances, a canvas 26,000 pixels wide, hand-drawn Patrick Hand lettering, photos, masks, the works. If the runtime can hold *that*, there is not much 2D left to be afraid of. It worked out better than we expected: you pan with the analog nub and zoom with the shoulder triggers, at 60 FPS, and it ships as one `EBOOT.PBP` you drop on a Memory Stick. We call it **Pocket Figma**.

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-psp-cover-zoom.png" alt="Pocket Figma on a PSP at 59% zoom: the Paper Kit cover — a hand-drawn character asking 'I'm out of paper, got any?' in a speech bubble, the word Wireframe in handwriting, dot-grid paper texture — with the viewer HUD along the bottom" />

<p class="text-sm text-slate-500 -mt-4">Native 480×272 output of the shipping build at 59% zoom, mid-pan across the kit's cover. This frame — like every PSP screenshot in this post — is the executable's own framebuffer, captured in the deterministic emulator our byte-exact tests run on.</p>

Pocket Figma is open source at [pocket-stack/pocket-figma](https://github.com/pocket-stack/pocket-figma). And like OpenStrike before it, it exists to make a point about architecture: **the device never parses, it only consumes.** A design file is just the most literal possible test of that law, because a design file is nothing *but* things to parse.

This post is the full story: what is actually inside a `.fig` file, the two-character bug that turned a smiley into a black hole, how you turn a 26,000-pixel-wide canvas into something a fixed-function GPU can stream, and why the whole thing is a pure function of the button mask.

## A .fig file is a database, not a picture

Export any Figma document and you get a `.fig` — a ZIP with a thumbnail, the referenced images, and one opaque blob called `canvas.fig`. That blob opens with the magic bytes `fig-kiwi`, and the name is the first delight of this project: **kiwi** is [Evan Wallace's schema format](https://github.com/evanw/kiwi) — Figma's co-founder wrote the serialization layer, published it as open source, and the file format carries his name in its header. More on him at the end.

The blob is a sequence of compressed chunks (deflate historically, zstd in current exports — the header tells you). Chunk one is a **kiwi binary schema**; chunk two is the document, encoded in that schema. Read that again: *the file tells you how to read itself.* You do not chase a version-specific spec — you decode the embedded schema with the kiwi library and get back a typed tree of everything Figma knows about the document. For our kit, that is a 3 MB blob inflating to a 9.8 MB message: 14,430 node records and 4,066 binary geometry blobs.

```text
Paper Wireframe Kit (Community).fig      22 MB (zip)
├─ canvas.fig                            fig-kiwi, 2 chunks
│   ├─ chunk 0: kiwi schema              the decoder ring, embedded
│   └─ chunk 1: the document             14,430 nodes / 4,066 blobs
│        ELLIPSE ×3537 · VECTOR ×2410 · INSTANCE ×2293
│        SYMBOL ×1937 · TEXT ×1522 · BOOLEAN_OPERATION ×177 …
├─ images/                               44 bitmaps (the photos)
└─ thumbnail.png
```

Here is the discovery that made this project feasible in a weekend rather than a quarter: **Figma bakes its own render into the file.** Every shape node carries `fillGeometry` and `strokeGeometry` — flattened path blobs where strokes have already been outlined into fills, boolean operations already evaluated, dashes already cut. Every text node carries `derivedTextData`: the full text layout, glyph by glyph, each with a *vector outline blob* in em units. We never wrote a stroker, never evaluated a boolean, never loaded a font — the hand-drawn Patrick Hand lettering renders from outlines the file itself provides. The path encoding is almost quaint: one command byte (move/line/quad/cubic/close), then float32 coordinates.

If you build on the web this pattern should feel familiar from the other direction: it is a *lockfile for rendering*. Figma's editor spent real CPU deciding exactly what those shapes look like; the file pins the result; any consumer — including, it turns out, a handheld from 2004 — just replays the answer.

## The two-character bug

One thing the file does not hand you is component instances. An `INSTANCE` node stores a pointer to its `SYMBOL` plus a list of *overrides* — "this nested text says 9:41", "this icon's fill is red" — each keyed by a `guidPath`, a path of node GUIDs. Expansion is recursive tree-grafting with two scoping rules that took most of a debugging evening:

First, within one symbol expansion, a descendant is addressed by a **single-element** path no matter how deep it sits — path segments accumulate only when you cross *nested instance* boundaries. Get this wrong and every override silently misses everything below the first level.

Second — and this is the one with the picture — nodes carry a field called `overrideKey`. When a component is copied between files (this kit imported its icon set from a library), every node gets a fresh GUID, but overrides keep referencing the *original*. The `overrideKey` is the original identity, preserved. Match overrides against `node.overrideKey ?? node.guid` and 1,040 remapped nodes snap into place. Match against `node.guid` alone and you get the left half of this:

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-instance-pair.png" alt="Before and after of the Paper Kit logo component: left, a mangled black rounded square with a stray white notch; right, the correct smiling paper-document icon in a dark rounded square" />

<p class="text-sm text-slate-500 -mt-4">The kit's logo component, before and after one line: overrides matched by <code>guid</code> (left) versus <code>overrideKey ?? guid</code> (right). The derived-geometry overrides that carve the smiling document out of the black plate simply never bound on the left.</p>

The renderer that produces these images — decode, expand, rasterize any region at any scale — is about 600 lines of TypeScript ([`tools/fig.ts`](https://github.com/pocket-stack/pocket-figma/blob/main/tools/fig.ts)) plus a canvas library. It reproduces every page of the kit pixel-close to Figma's own thumbnails. That was the checkpoint where this stopped being archaeology and became a build pipeline.

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-welcome-page.png" alt="The Paper Kit Welcome page rendered by tools/fig.ts: the Wireframe PAPER KIT cover with dozens of wireframe components, and six white document cards with illustrations, text and forms" />

<p class="text-sm text-slate-500 -mt-4">The kit's Welcome page, rendered entirely by our decoder from the file's own derived geometry — instances expanded, masks applied, glyph outlines filled. No Figma runtime, no fonts, no network.</p>

## A bundler for design files

Now the PSP part. The naive plan — ship the vectors, tessellate on device — dies on arithmetic: tens of thousands of antialiased paths per screen against a 333 MHz in-order CPU with no JavaScript JIT. The honest plan is the one every map application converged on: **rasterize offline into a tile pyramid, stream tiles on demand.** Google Maps, for wireframes, on a PSP.

So Pocket Figma's build step is a cooker, exactly parallel to [OpenStrike's](/blog/shipping-openstrike/) `pocket3d-cook`, and it bakes just as aggressively:

<svg viewBox="0 0 760 348" width="100%" role="img" aria-label="Pipeline diagram: the .fig file flows into fig.ts (kiwi-decode the embedded schema, expand 2,293 instances, rasterize pages in strips) then into the tile cooker (one 256-color palette per page, classify tiles as background, solid or textured, PackBits-RLE the indices, dedupe identical tiles), producing four TILESET pyramids totaling 5.9 MB which are linked into the EBOOT" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="96" width="180" height="112" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="106" y="124" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PaperKit.fig</text>
  <text x="106" y="143" fill="#94a3b8" font-size="11" text-anchor="middle">fig-kiwi · 22 MB</text>
  <text x="106" y="164" fill="#94a3b8" font-size="11" text-anchor="middle">14,430 nodes</text>
  <text x="106" y="183" fill="#64748b" font-size="10.5" text-anchor="middle">carries its own schema</text>
  <path d="M196 152 L228 152" stroke="#475569" stroke-width="1.5"/>
  <path d="M228 152 l-8 -5 M228 152 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="234" y="40" width="240" height="224" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="354" y="66" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">tools/fig.ts</text>
  <text x="354" y="84" fill="#38bdf8" font-size="11" text-anchor="middle">build time, on your laptop</text>
  <text x="252" y="112" fill="#94a3b8" font-size="11.5">· decode via the embedded schema</text>
  <text x="252" y="134" fill="#94a3b8" font-size="11.5">· expand 2,293 instances</text>
  <text x="252" y="156" fill="#94a3b8" font-size="11.5">  (overrideKey remap · masks)</text>
  <text x="252" y="178" fill="#94a3b8" font-size="11.5">· fills + strokes + glyphs from</text>
  <text x="252" y="200" fill="#94a3b8" font-size="11.5">  the file's derived geometry</text>
  <text x="252" y="222" fill="#94a3b8" font-size="11.5">· rasterize pages in strips</text>
  <text x="252" y="248" fill="#64748b" font-size="10.5">a ladder of halving scales per page</text>
  <path d="M474 152 L506 152" stroke="#475569" stroke-width="1.5"/>
  <path d="M506 152 l-8 -5 M506 152 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="512" y="40" width="232" height="224" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="628" y="66" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">tile cooker</text>
  <text x="628" y="84" fill="#22d3ee" font-size="11" text-anchor="middle">TILESET pyramids · 'PKTS'</text>
  <text x="530" y="112" fill="#94a3b8" font-size="11.5">· one 256-color CLUT per page</text>
  <text x="530" y="134" fill="#94a3b8" font-size="11.5">· classify: bg / solid / textured</text>
  <text x="530" y="156" fill="#94a3b8" font-size="11.5">· PackBits-RLE the indices</text>
  <text x="530" y="178" fill="#94a3b8" font-size="11.5">· dedupe identical tiles</text>
  <text x="530" y="204" fill="#e2e8f0" font-size="11">Welcome 0.8 MB · Components 1.9</text>
  <text x="530" y="222" fill="#e2e8f0" font-size="11">Stickers 0.2 · Examples 3.1</text>
  <text x="530" y="248" fill="#64748b" font-size="10.5">= 5.9 MB, four pages, committed</text>
  <path d="M628 264 L628 292" stroke="#475569" stroke-width="1.5"/>
  <text x="380" y="316" fill="#94a3b8" font-size="11.5" text-anchor="middle">linked into the EBOOT — tiles decode straight out of read-only memory; nothing is ever “loaded”</text>
  <text x="380" y="338" fill="#475569" font-size="11" text-anchor="middle">same ideology as the Tailwind→binary style table, the font atlases, and OpenStrike's .p3d — moved cost is free cost</text>
</svg>

Three cooker decisions carry most of the weight:

- **CLUT8, one palette per page.** Tiles are 8-bit indices into a 256-color palette — 4× smaller than RGBA before compression, and the format the PSP's GPU natively samples through its hardware color-lookup table. A paper wireframe kit is nearly monochrome; 256 colors per page is generous enough to hold the photos too.
- **Whitespace is a directory entry, not pixels.** A wireframe page is *mostly* nothing — paper background and flat card fills. The cooker classifies every tile: background tiles vanish entirely, uniform-color tiles become a 4-byte "solid" marker in the tile directory, and only tiles with actual ink get a pixel stream (run-length encoded, because flat fills compress brutally).
- **The zoom ladder is capped per page.** Each page bakes at halving scales from a chosen maximum — 100% where small labels justify it (the Components sheet), 50% where they don't (the poster-sized Examples wall) — down to a level that fits one screen.

The classification is worth seeing, because it is the whole memory story in one image:

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-tile-grid.png" alt="The Examples page overlaid with its finest-level tile grid: blue tiles cover the phone wireframes (textured), yellow tiles cover the white section backgrounds (solid), unshaded tiles are page background" />

<p class="text-sm text-slate-500 -mt-4">The Examples page — sixteen sections of phone mockups on a 52×21 tile grid at the finest zoom level. <span style="color:#38bdf8">Blue</span> tiles carry pixels (615). <span style="color:#eab308">Yellow</span> tiles are solid colors — a directory entry, zero texture memory (441). Unshaded is page background (36). 44% of the sharpest level of the busiest page costs nothing to draw.</p>

## Streaming a canvas through 2 MB of VRAM

At runtime the viewer is a new PocketJS component, **`<DeepZoom>`**, and underneath it, the engine grew the plumbing every deep-zoom canvas needs — which was the real agenda all along. Pocket Figma is the first consumer; the machinery is generic.

<svg viewBox="0 0 760 320" width="100%" role="img" aria-label="Runtime diagram: the DeepZoom component's three nodes — a clipped viewport, a pinned low-res overview world, and an active mip-level world whose tiles stream in. A tile request flows through the loadTileTexture op to the TILESET bytes in read-only memory, gets RLE-decoded into a CLUT8 texture with a generation-tagged handle, and is drawn by the GE through its hardware palette with bilinear filtering" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="16" width="360" height="272" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="196" y="42" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">&lt;DeepZoom&gt; — three nodes</text>
  <rect x="36" y="60" width="320" height="52" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="50" y="82" fill="#e2e8f0" font-size="12">viewport · overflow-hidden, never moves</text>
  <text x="50" y="100" fill="#64748b" font-size="10.5">the scissor comes from its own box — Gallery's rule</text>
  <rect x="36" y="120" width="320" height="52" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="50" y="142" fill="#e2e8f0" font-size="12">overview world · coarsest level, pinned</text>
  <text x="50" y="160" fill="#64748b" font-size="10.5">a not-yet-streamed tile shows its low-res self, never a hole</text>
  <rect x="36" y="180" width="320" height="52" rx="8" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="50" y="202" fill="#e2e8f0" font-size="12">active world · the mip that matches the zoom</text>
  <text x="50" y="220" fill="#22d3ee" font-size="10.5">tiles mount imperatively · 2 streams/frame · LRU eviction</text>
  <text x="196" y="262" fill="#94a3b8" font-size="11" text-anchor="middle">per frame: 3 paint-only writes per world</text>
  <text x="196" y="278" fill="#64748b" font-size="10.5" text-anchor="middle">translateX · translateY · scale — native-ticked, no relayout</text>
  <path d="M376 206 L420 206" stroke="#475569" stroke-width="1.5"/>
  <path d="M420 206 l-8 -5 M420 206 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="426" y="60" width="318" height="196" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="585" y="86" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">loadTileTexture(key, index)</text>
  <text x="444" y="112" fill="#94a3b8" font-size="11.5">TILESET bytes sit in .rodata —</text>
  <text x="444" y="130" fill="#94a3b8" font-size="11.5">the EBOOT's read-only data, already in RAM</text>
  <text x="444" y="156" fill="#94a3b8" font-size="11.5">RLE-decode one 64 KB tile → CLUT8 texture</text>
  <text x="444" y="174" fill="#94a3b8" font-size="11.5">zero JavaScript-heap transit on the PSP</text>
  <text x="444" y="200" fill="#e2e8f0" font-size="11.5">handle = generation ⊕ slot — a freed handle</text>
  <text x="444" y="218" fill="#e2e8f0" font-size="11.5">draws nothing, never a stranger's texture</text>
  <text x="444" y="242" fill="#22d3ee" font-size="11.5">GE samples through its 256-entry CLUT, bilinear</text>
  <text x="380" y="310" fill="#475569" font-size="11" text-anchor="middle">solid tiles never reach this path at all — the tile directory says “that tile is #ffffff” and a colored rect draws it</text>
</svg>

A few of these boxes deserve a sentence. Tile churn is the fastest way to discover why texture handles need **generations**: pan for ten seconds and hundreds of textures are created and freed; a stale handle that silently pointed at a *recycled slot* would paint the wrong tile somewhere on screen, rarely, unreproducibly. Generation-tagged handles (the same trick PocketJS node ids already use) turn that whole bug class into "draws nothing." The **streaming budget** — two tile decodes per frame, nearest-to-center first — keeps the worst frame bounded; the pinned overview underneath means the cost of not-yet-streamed is *blur*, not blankness. And **bilinear filtering** is per-texture opt-in: the rest of PocketJS stays on nearest sampling (its byte-exact goldens depend on it), while tiles get the GE's free smooth minification between mip levels.

The result, on hardware whose entire video memory is 2 MB: a 26,000-pixel-wide artboard you can sweep across with the nub while the mip ladder swaps under your thumb.

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-psp-fit.png" alt="Pocket Figma on PSP showing the whole Welcome page fit to screen at 8% zoom: the cover and six document cards, with the HUD reading Welcome, the controls hint, and 8%" />

<p class="text-sm text-slate-500 -mt-4">Frame 0 on the PSP: the Welcome page fit-to-screen at 8%. Every visible tile streamed from read-only memory during boot; the HUD is ordinary PocketJS text nodes.</p>

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-sim-calendar.png" alt="The viewer at 100% zoom on the kit's calendar component: JANUARY 20.., weekday headers M T W Th and handwritten dates, dot-grid background on the left" />

<p class="text-sm text-slate-500 -mt-4">100% zoom on the kit's calendar component — Patrick Hand digits from the file's own glyph outlines, antialiased at bake time, CLUT-sampled at runtime. This capture is from the wasm reference rasterizer; the PSP's GE output of the same frame differs only in its bilinear rounding.</p>

## Time is still an input

Everything above obeys [the determinism rules](/blog/ui-runtime-that-cant-flake/) — and panning a canvas turned out to be their nicest stress test yet, because it forced a real decision. The analog nub is *new input surface*: the frame contract grew from `frame(buttons)` to `frame(buttons, analog)`, the DevTools flight recorder now tapes the stick alongside the buttons (a centered stick adds zero bytes, so every pre-analog tape replays unchanged), and hosts without a stick just... don't pass one.

The decision was about motion. The obvious pan integrator — "each frame, move by velocity" — quietly breaks the [subsampling theorem](/blog/ui-runtime-that-cant-flake/): a 15 Hz world would pan a quarter the distance per virtual second. `<DeepZoom>` instead integrates **once per 1/60 s tick**, however many ticks the host's clock policy packs into a frame. Our CI drives the same scripted journey — zoom in, nub-pan to the cover, release into the momentum glide — at 60, 15, and 5 Hz, and asserts the settled screens are **byte-identical**. It also re-runs the journey with random sleeps, garbage-collector churn, and allocation pressure injected between frames. Nothing changes. The wall clock is not an input; now the stick is, and it is *recorded*.

The same property is why we could verify the PSP build without owning a fleet of them: the emulator's deterministic software renderer dumps framebuffers, and the byte-exact e2e goldens for every pre-existing PocketJS demo passed unchanged through the entire engine surgery — new texture formats, new ops, a re-keyed GPU cache, a two-argument frame contract. Thirty-five wasm goldens, four PSP demos, zero diffs. That is what let three parallel strands of this work land in one branch without fear.

## What it costs

```text
PSP user RAM                                24.0 MB
├─ executable (engine + QuickJS + bundle
│    + all four tile pyramids)               ~8.9 MB
├─ arena (QuickJS heap, core, resident
│    tile textures ≈ 24 × 65 KB) — budget    ~4 MB
└─ free                                     ~11 MB
frame budget: JS integrator + ≤2 tile decodes + GE ≪ 16.7 ms
```

The shipped `EBOOT.PBP` is 9.1 MB — 6.2 MB of that is the four tile pyramids, and another 150 KB is the XMB art (the backdrop is the kit's own cover, rendered from the .fig). The viewer's per-frame JavaScript is a few hundred microseconds of integrator math plus at most two 64 KB RLE decodes in Rust; the GE draws a screenful of textured quads through its palette and is idle again. This machine has headroom to spare — the interesting ceiling is the Memory Stick's patience for nine-megabyte executables, not the frame.

## Standing in Evan Wallace's world

A closing note, from me personally. Nearly everything this project decoded — the **kiwi** schema language the `.fig` announces itself with, the derived geometry that made a weekend port possible — is Evan Wallace's work. Five years ago, when I was first learning how collaborative apps work, [his write-ups](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) carried me further than anything else I read, and he has been a role model to me ever since: the kind of engineer who answers a hard problem by quietly building the missing piece, then telling everyone exactly how it works. Deeply understanding, and then faithfully reconstructing, a corner of the world he built — with an AI collaborator at my side — has been one of the most beautiful experiences I have had making software.

## Open it

- **[pocket-stack/pocket-figma](https://github.com/pocket-stack/pocket-figma)** — MIT. `bun run build` for the bundle, `bun run psp` for the EBOOT (XMB art included — the backdrop is rendered from the .fig itself), `bun run desktop` for a windowed build. The engine layer — TILESET format, streaming ops, `<DeepZoom>` — lives in [PocketJS](https://github.com/pocket-stack/pocketjs).
- The kit is the [Paper Wireframe Kit by Method](https://www.figma.com/community/file/1075811850250564922) (CC BY 4.0) — the baked tiles are committed; re-baking from the .fig is one command.
- No PSP? PPSSPP runs the EBOOT as-is. Real hardware wants custom firmware and a Memory Stick with 10 MB to spare.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
