# Repository structure

The tree mirrors the platform ontology from [RUNTIMES.md](RUNTIMES.md) —
**Cores + Surfaces + Guest** — plus the compiler family, the contracts that
bind the layers, and the products built on top. One axis per top-level
directory; nothing else gets a top-level name.

```
pocketjs/
├─ engine/       Cores: the Rust simulation cores
│  ├─ core/       pocketjs-core — retained UI tree, taffy layout, raster (standalone crate)
│  ├─ wasm/       core compiled to wasm32 for web/sim hosts (standalone crate)
│  ├─ pocket3d/   the 3D core family (bsp, cook, gu, vita) + desktop examples
│  ├─ crates/     non-3D engine crates: pocket-mod, pocket-ui-wgpu, pocket-vrm, pocket-widget
│  └─ Cargo.toml  the desktop workspace root (core/, wasm/ and the console-
│                 toolchain crates are deliberately excluded and standalone —
│                 cargo-psp/vitasdk need lone crates; see engine/core/Cargo.toml)
├─ hosts/        Surfaces: every embedding of the cores
│  ├─ psp/        QuickJS + rust-psp EBOOT host
│  ├─ vita/       Vita host
│  ├─ switch/     QuickJS + libnx/Rust NRO host
│  ├─ web/        browser dev host (wasm core)
│  └─ sim/        deterministic headless simulation host (docs/DETERMINISM.md)
├─ framework/    Guest: @pocketjs/framework
│  ├─ src/        the TS runtime (Solid + Vue Vapor renderers, components, input, osk…)
│  └─ compiler/   the interpreted-path build pipeline (jsx-plugin, tailwind, pak)
├─ vapor/        Pocket Vapor: the AOT compiler family (Vue Vapor subset → GBA/GB/NES/ESP32)
├─ contracts/    single sources of truth binding the layers
│  ├─ spec/       op contract, platform contracts, manifest + package spec, gen-rust
│  └─ schema/     published JSON schemas (pocket-2.json)
├─ apps/         demo apps (pocket.json manifests; built by tools/build.ts)
├─ tools/        every command: build/dev/device/release bun scripts (flat),
│                plus cli/ (@pocketjs/cli), psplink/, imagegen/
├─ tests/        the test suite: *.test.ts flat at the root, plus
│                e2e/ (PPSSPP, Vita3K drivers), goldens/{web,psp,vita}, tapes/, fixtures/
├─ site/         pocketjs.dev (Cloudflare)
├─ docs/         design docs (DESIGN, RUNTIMES, DETERMINISM, PLATFORM, …)
├─ skills/       repo Claude skills
├─ assets/       brand, fonts, shared art
└─ README.md, CLAUDE.md, AGENTS.md — the only markdown that lives at root
```

## Placement rules

New things go where the axis says — never invent a top-level directory:

- **A new Rust simulation core** → `engine/` (workspace member if it builds on
  desktop; excluded standalone crate if it needs a console toolchain).
- **A new platform embedding** (ESP32, 3DS, …) → `hosts/<platform>/`.
- **A new AOT backend** (Pocket Vapor gains a device) →
  `vapor/runtime/<device>/`; the vapor compiler grows a target entry, the top
  level does not change. A QuickJS guest host such as `hosts/switch/` does not
  imply an AOT backend: Vue Vapor guests already use the shared framework
  runtime and `HostOps`.
- **A new demo** → `apps/<name>/` with a `pocket.json`. Standalone products
  keep the `pocket-<name>` separate-repo convention and do not move in.
- **A new command** → `tools/<name>.ts`. No single-file top-level directories.
- **A new cross-layer contract** → `contracts/spec/`; generated code stays
  generated (`gen-rust.ts` style), never hand-forked per layer.
- **A new design doc** → `docs/`. Root keeps only README/CLAUDE/AGENTS.

## Invariants the layout preserves

- **npm surface is frozen**: `@pocketjs/framework/*` export *keys* never
  change; the `exports`/`files` maps in package.json absorb internal moves.
- **Cargo stays non-workspace where toolchains demand it**: `engine/core`,
  `engine/wasm`, `hosts/psp`, `hosts/vita`, `hosts/switch`, and the gu/vita 3D
  crates each stand alone with their own lockfiles. `engine/Cargo.toml` is the
  one desktop workspace.
- **Moves are `git mv`** — history stays traceable.
