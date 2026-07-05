# Compiler pipeline

The AOT compiler turns author files into a PJGB cartridge blob and a linked GBA
ROM. Each stage keeps the boundary between build-time JavaScript and runtime
game data explicit.

## Stages

1. **Evaluate** the static DSL with Bun and collect maps, actors, assets, and
   residual script entry points.
2. **Bake** image assets into 8x8 GBA tiles, 4bpp tile maps, sprite sheets, and
   BGR555 palettes.
3. **Bake text** into the subpixel dialogue glyph format used by the textbox
   renderer.
4. **Residualize** supported script generators into VM instructions.
5. **Pack** the PJGB chunks with offsets, sizes, and debug metadata.
6. **Link** the blob into the fixed C runtime and emit a `.gba` ROM.

## Failure model

The compiler should fail early when author code crosses the supported AOT
surface. That keeps the ROM deterministic and keeps the native runtime small.
