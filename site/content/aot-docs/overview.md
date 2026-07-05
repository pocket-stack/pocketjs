# PocketJS AOT

PocketJS AOT is a separate product line for GBA-class cartridge games. It uses
TypeScript and JSX as an authoring DSL, but the final program does not ship a
JavaScript engine. The build executes the static declarations, lowers the
supported residual scripts, and links compact game data into a fixed native
runtime.

The framework docs describe the PSP-oriented UI runtime powered by QuickJS,
Solid, Vue Vapor, and PocketJS host components. AOT is intentionally different:
it targets tile maps, sprites, palettes, dialogue, flags, choices, and warps.

## Current slice

- Author maps, layers, NPCs, warps, and scripts in TypeScript/JSX.
- Bake GBA-native 4bpp graphics, BGR555 palettes, and packed glyph data.
- Lower supported generator scripts into bytecode for a small runtime VM.
- Preview captured cartridge states in the independent [web demo](/aot/#demo).

## Boundaries

AOT docs live under `/aot/docs/*` so the framework docs can stay focused on
PocketJS UI applications. The AOT browser demo is also separate from the
framework playground: it is a static canvas viewer for generated cartridge
states, not a QuickJS/Solid runtime.
