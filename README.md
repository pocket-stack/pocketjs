# psp-ui

A JSX UI stack for the Sony PSP (and beyond): **Solid** (universal renderer) +
a **build-time Tailwind-subset compiler** + **baked font atlases**, driving one
`no_std` Rust core (flexbox layout, styling, animation, text, DrawList) that
runs on real PSP hardware, PPSSPP, the browser (WASM) and headless Bun.
Full design + contracts: [DESIGN.md](./DESIGN.md).

## Quickstart

```sh
bun install
bun scripts/build.ts demos/hero.tsx   # -> dist/hero.js + dist/hero.dcpak
```

The build is two-pass: pass 1 babel-transforms every module reachable from the
entry (babel-preset-solid `generate:'universal'`, content-hash cached in
`.cache/`) while collecting class strings + text codepoints from the AST; then
the Tailwind compiler writes `styles.bin` + `src/styles.generated.ts`, the font
baker rasterizes Inter atlas slots for exactly the characters your app uses,
and everything is packed into `dist/<app>.dcpak`. Pass 2 bundles with Bun
(iife, unminified) from the cached transforms.

```tsx
// demos/hero.tsx — the only intrinsics are <view>, <text>, <image>
<view class="flex-col items-center gap-4 p-4 bg-slate-50">
  <text class="text-xl text-slate-950">Count: {count()}</text>
  <view class="p-2 rounded-md bg-blue-600 focus:bg-blue-500 transition-colors duration-150"
        focusable onPress={() => setCount(count() + 1)} />
</view>
```

Mounting entries should look like ordinary app bootstrap code; the framework
handles host detection, the generated style table, dcpak image uploads and the
host frame callback:

```tsx
import { mount } from "../src/index.ts";
import App from "./app.tsx";

mount(() => <App />);
```

Styling rules (compile-time, no runtime CSS): a class literal compiles iff
*every* token is a supported utility (see DESIGN.md "Tailwind subset (v1)");
dynamic styling is ternaries of full literals, `style={{...}}`, or `animate()`.
`classList`, `hover:` and template-interpolated classes are compile errors.
`rounded-full` requires `w-N h-N` in the same literal.

## Commands

```sh
bun run test                          # spec contract + tailwind parser tests
bun scripts/build.ts <app> [--extra-chars=…]  # extra codepoints for the atlases
bun run psp / bun run dev / bun run wasm      # EBOOT / web host / wasm core
bun run hw hero --trace              # real PSP via PSPLINK + host0 trace
bunx tsc --noEmit                     # typecheck (babel owns the JSX transform)
```

Fonts: Inter (OFL), vendored in `assets/fonts/`.
