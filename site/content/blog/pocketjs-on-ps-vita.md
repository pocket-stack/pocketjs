The entire PS Vita port of PocketJS is now one command:

```sh
bun play vita gallery --fullscreen
```

That builds a VPK, installs it into Vita3K, and launches the same Gallery app we
already run on PSP. There is no Vita entry file, no Vita component tree, and no
`if (vita)` in the application. PocketJS keeps the 480×272 world the app was
written for, but bakes and samples raster resources at density 2 before filling
the Vita's native 960×544 screen. The layout stays portable; the pixels do not
stay low resolution.

<img class="w-full rounded-xl border border-line" src="https://raw.githubusercontent.com/pocket-stack/pocket-figma/0735cf2/test/goldens-vita/zoom.png" alt="Pocket Figma running at 960 by 544 for PS Vita, zoomed into a dense design-system page with the PocketJS status bar and controller hints" />

<p class="text-sm text-slate-500 -mt-4">A 960×544 Pocket Figma Vita golden. This image is produced by the capture build's deterministic CPU renderer inside the guest; the production frame beside it still goes through vita2d and GXM, with texture residency checked separately.</p>

The interesting part is not that we taught a second Sony handheld to draw a
rectangle. It is that the port refused to become a fork. The same manifest,
JavaScript bundle, pak format, layout engine, input model, and rendering
semantics now end at two very different native backends—and the build system can
prove which host contract each artifact was made for.

## The port that refused to become a fork

PocketJS applications do not render pixels themselves. Solid or Vue Vapor
updates a native tree through HostOps; `pocketjs-core` lays that tree out and
emits a DrawList; the last host-specific layer submits those drawing commands to
the machine.

<svg viewBox="0 0 760 404" width="100%" role="img" aria-label="PocketJS architecture: one application and QuickJS guest flow through HostOps and pocketjs-core, then fan out to the PSP sceGu backend and the Vita vita2d GXM backend" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="150" y="12" width="460" height="60" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="37" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">app.tsx + app.pak</text>
  <text x="380" y="57" fill="#94a3b8" font-size="11.5" text-anchor="middle">one product bundle · Solid or Vue Vapor</text>
  <path d="M380 72 L380 100" stroke="#475569" stroke-width="1.5"/>
  <rect x="205" y="100" width="350" height="54" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="123" fill="#e2e8f0" font-size="13" text-anchor="middle">QuickJS guest → HostOps ABI 1</text>
  <text x="380" y="142" fill="#64748b" font-size="11" text-anchor="middle">buttons · left analog · baked glyphs</text>
  <path d="M380 154 L380 182" stroke="#475569" stroke-width="1.5"/>
  <rect x="205" y="182" width="350" height="62" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="207" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">pocketjs-core</text>
  <text x="380" y="227" fill="#22d3ee" font-size="11" text-anchor="middle">layout · clip · paint transforms · DrawList</text>
  <path d="M315 244 L186 290" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M445 244 L574 290" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="40" y="290" width="292" height="78" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="186" y="316" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PSP host</text>
  <text x="186" y="338" fill="#94a3b8" font-size="11.5" text-anchor="middle">sceGu · fixed-function GE</text>
  <text x="186" y="356" fill="#64748b" font-size="11" text-anchor="middle">480×272 physical</text>
  <rect x="428" y="290" width="292" height="78" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="574" y="316" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PS Vita host</text>
  <text x="574" y="338" fill="#c4b5fd" font-size="11.5" text-anchor="middle">vita2d · GXM</text>
  <text x="574" y="356" fill="#64748b" font-size="11" text-anchor="middle">960×544 physical · raster density 2</text>
  <text x="380" y="394" fill="#475569" font-size="11" text-anchor="middle">the fork is one native submission layer, not the application</text>
</svg>

On PSP that final layer translates the DrawList to `sceGu`, Sony's
fixed-function Graphics Engine API. On Vita, a new Rust host embeds QuickJS,
feeds the same pak into the same core, then translates the same DrawList through
vita2d to GXM. The VPK contains the native host, compiled JavaScript, styles,
font atlases, and images as one installable application.

This boundary matters. A rounded corner is not a Vita feature and DrawList is
not an application capability. Rounded-corner masks, clipping, and paint-only
transforms are PocketJS semantics implemented above either GPU. The backend is
allowed to be completely different; the visible contract is not.

## Same layout, four times the raster budget

The PSP screen is 480×272. The Vita screen is 960×544: exactly twice the width
and height. The first port used that relationship only as a presentation
transform, which preserved layout but also preserved every PSP-sized jagged
edge. The finished contract separates two facts: logical viewport and raster
density.

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="PocketJS keeps a 480 by 272 logical layout while the Vita profile bakes text vectors images and masks at raster density two and renders a native 960 by 544 framebuffer" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="30" y="42" width="270" height="190" rx="10" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="165" y="27" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">logical layout · 480×272</text>
  <rect x="72" y="78" width="186" height="108" rx="18" fill="#111c2e" stroke="#334155"/>
  <text x="165" y="117" fill="#f1f5f9" font-size="20" font-weight="700" text-anchor="middle">Mission</text>
  <text x="165" y="145" fill="#94a3b8" font-size="12" text-anchor="middle">same metrics · same wrapping</text>
  <circle cx="235" cy="172" r="9" fill="#22d3ee"/>
  <path d="M318 126 L442 126" stroke="#475569" stroke-width="2"/>
  <path d="M442 126 l-12 -7 M442 126 l-12 7" stroke="#475569" stroke-width="2" fill="none"/>
  <text x="380" y="87" fill="#c4b5fd" font-size="12" text-anchor="middle">profile.rasterDensity = 2</text>
  <text x="380" y="107" fill="#64748b" font-size="10.5" text-anchor="middle">fonts · SVG · masks · @2x assets</text>
  <rect x="460" y="24" width="270" height="226" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="595" y="276" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">physical raster · 960×544</text>
  <rect x="493" y="66" width="204" height="130" rx="22" fill="#111c2e" stroke="#475569" stroke-width="1.5"/>
  <text x="595" y="112" fill="#f1f5f9" font-size="26" font-weight="700" text-anchor="middle">Mission</text>
  <text x="595" y="146" fill="#94a3b8" font-size="14" text-anchor="middle">2× coverage · native edges</text>
  <circle cx="670" cy="180" r="12" fill="#22d3ee"/>
  <text x="380" y="296" fill="#64748b" font-size="11" text-anchor="middle">no relayout · no crop · no letterbox · no target branch</text>
</svg>

Font atlas v3 keeps advances, baselines, line heights, and glyph cells in
logical pixels while storing density-scaled coverage. SVGs and PocketJS's own
rounded-corner masks follow the same rule. PNG, sprite, and pre-baked pak
assets prefer an `@2x` sibling with build-time dimension checks. Dynamic
texture producers read `platform.pixelRatio`. Geometry, gradients, and
triangles are sampled directly on the 960×544 target rather than rendered at
480×272 and copied afterward.

The application always fills the Vita framebuffer. `--fullscreen` controls the
Vita3K window around it, so the command can also fill your desktop display. We
do not ask every component to rediscover a scale factor, and we do not hide a
Vita-only `scale = 2` in the JavaScript compiler. The resolved target profile
owns physical size, presentation, and raster density; every later build stage
consumes those resolved values.

## An app asks; a host answers

The port forced us to answer a larger question: what does an application say
when it may run on more than one handheld?

Not this:

```json
{ "psp": true, "vita": true, "scale": 2 }
```

Those are host facts. The app writes the public APIs it needs and the logical
world it was designed for:

```json
{
  "engine": {
    "capabilities": {
      "requires": ["input.buttons", "text.glyphs.baked"],
      "enhances": ["input.analog.left"]
    }
  },
  "app": {
    "entry": "app/main.tsx",
    "framework": "solid",
    "viewport": {
      "logical": [480, 272],
      "presentation": "integer-fit"
    }
  }
}
```

PocketJS owns the other half: a small profile declaring the HostOps ABI,
physical display, accepted logical viewports, presentation modes, raster
density, and public framework APIs the stock host has actually implemented and
tested. The resolver combines manifest and profile exactly once:

```text
pocket.json × target profile → ResolvedBuildPlan
                                 ├─ JS compiler
                                 ├─ Cargo/native backend
                                 └─ VPK packager
```

Every later stage consumes that answer. It does not reinterpret the manifest or
ask `if target === "vita"` again. A PSP-shaped application therefore resolves
for Vita unchanged when the Vita profile satisfies its requirements and accepts
its 480×272 logical viewport. Compatibility is a build result, not a platform
allowlist.

The capability registry is intentionally tiny: buttons, left analog, and baked
glyph text. A capability names stable public behavior an application can
observe. It does not name hardware, a permission, an internal wire format, or a
backend implementation. That is why `ui.drawlist` disappeared during review:
DrawList is how PocketJS talks to its own renderers, not something app code can
request. If a future API offers a meaningfully different execution level or
guarantee, it gets a different id rather than an extra platform conditional.

## Optional means removable

An enhancement is useful only if its fallback is honest. PocketJS exposes the
resolved answer through `@pocketjs/framework/platform`:

```ts
import { hasFeature } from "@pocketjs/framework/platform";

if (hasFeature("input.analog.left")) {
  installAnalogNavigation();
} else {
  installButtonNavigation();
}
```

For manifest builds, the compiler proves that this `hasFeature` binding is the
framework import and that the argument is a string literal, then replaces the
call with `true` or `false`. Bun removes the dead branch even with minification
disabled. A PSP package therefore does not carry a Vita-only implementation
merely because the source contains a fallback pair.

Alias imports work. Dynamic feature names, local functions also named
`hasFeature`, and computed introspection deliberately stay runtime lookups. The
transform cache includes the sorted feature map, too, so compiling the same
source for PSP and Vita cannot accidentally reuse the first target's answer.
Both the Solid and Vue Vapor pipelines run the same specialization.

This is a small build contract, not a capability-token language. TypeScript
still checks ordinary application code. Hard requirements fail resolution;
enhancements become guarded booleans; the bundle and native host verify target
id plus HostOps ABI when they meet.

## The texture that crashed when we freed it

The clean architecture did not make the native port uneventful.

Pocket Figma streams large design pages as texture tiles. Zooming changes mip
level; switching pages retires one set of logical texture handles and creates
another. The first Vita host mirrored the obvious ownership rule: when the core
freed a texture handle, call `vita2d_free_texture` immediately.

In Vita3K 0.2.1 on macOS, repeated destruction of live vita2d allocations could
fault inside GXM emulation during exactly that mip/page transition. Keeping
everything forever avoided the fault but turned a lifecycle bug into a memory
leak—hardly a fix for a handheld.

The durable fix separates two lifetimes:

```text
logical handle                       physical vita2d allocation
generation-tagged · may retire       width × height · may be recycled
          │                                      ▲
          └──── free removes binding ────────────┘
                         same-size reuse on the next upload
```

Freeing a logical handle now removes it from the live map immediately, so stale
DrawList references still fail. Its physical allocation enters a same-sized
recycler instead of being destroyed mid-session. A later upload can reuse that
memory and overwrite its pixels. Correct handle generations and bounded GPU
allocation churn coexist; neither layer lies about ownership.

We call this a Vita3K compatibility fault because that is what we reproduced.
We have not claimed the same crash on physical Vita hardware. The distinction
is important: an emulator is a target we support, not evidence for a bug on a
machine we did not observe.

## Forty-four frames as a proof

“It launches” is not the acceptance criterion for a renderer port. The Vita
suite installs a capture VPK into an isolated VitaFS, starts Vita3K, drives the
real QuickJS/input/layout loop with deterministic controller tracks, and waits
for completion markers written by the guest.

It then checks 44 frames:

- every capture is exactly 960×544 RGBA;
- the frame contains physical detail inside at least one logical 2×2 block,
  proving capture did not regress to low-resolution duplication;
- every frame has its own reviewed Vita physical golden;
- every texture and font atlas referenced by production GXM is resident;
- all 44 960×544 images match their committed golden exactly.

There is one caveat worth making visible. Vita3K's current macOS Vulkan path
does not provide a coherent GXM framebuffer readback after presentation. The
pixel oracle is therefore a deterministic CPU renderer inside the capture
guest, consuming the same DrawList and rasterizing geometry, gradients,
textures, density-aware glyph coverage, and scissors directly at 960×544. The
production vita2d/GXM pass still runs, and the suite separately asserts that
all textures and font atlases it uses—including PocketJS's internally generated
rounded-corner masks—are resident. These PNGs are not mislabeled GPU
framebuffer dumps.

The port also had to survive real applications rather than only framework
demos. Pocket Figma contributes four Vita journeys: fit, zoom, zoom-and-pan,
and page switching—the path that found the texture recycler bug. OpenStrike
contributes five golden moments across spawn, walking, and firing, plus live
Pocket3D scene counters proving that the native world submission is not an
empty HUD over a black frame.

That layered evidence is more useful than a single screenshot: deterministic
pixels for the shared UI contract, native residency and scene assertions for
the GPU backends, and emulator liveness for the packaged application.

## One command, and what is deliberately missing

With [VitaSDK](https://vitasdk.org/) and
[Vita3K](https://vita3k.org/) installed, try any bundled demo:

```sh
bun play vita hero
bun play vita gallery --fullscreen
bun play --help
```

The runner resolves the Vita plan, compiles the app, builds and validates the
VPK, replaces the installed test title, safely restarts an existing Vita3K
process, and launches the new build. It is the same short loop as a browser
preview, except the output is a native console package.

Touch is deliberately absent today. The Vita has touch hardware; PocketJS does
not yet have a public touch API, HostOps delivery, and tests, so the profile does
not advertise `input.touch`. Dynamic host-shaped text layout is also future
work; current text is the same deterministic baked-glyph contract as PSP.
Those features should arrive as framework behavior with manifests, types,
native delivery, fallback rules, and tests together—not as `if (vita)` patches.

The implementation is under review in
[pocket-stack/pocketjs#92](https://github.com/pocket-stack/pocketjs/pull/92),
with the build-contract foundation in
[#98](https://github.com/pocket-stack/pocketjs/pull/98). The two downstream
proofs are [Pocket Figma](https://github.com/pocket-stack/pocket-figma/pull/1)
and [OpenStrike](https://github.com/pocket-stack/open-strike/pull/9). If you want
the contract rather than the port story, start with
[Platform contracts](/docs/platform-contracts/).

One app, two PlayStations, one compatibility answer—and no platform fork hiding
in the component tree.
