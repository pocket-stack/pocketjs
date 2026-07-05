# GBA runtime

The AOT runtime is a fixed native program that consumes PJGB data. It is designed
around predictable memory, simple scene stepping, and GBA hardware features.

## Responsibilities

- Initialize Mode 0 backgrounds, OBJ sprites, palettes, and VRAM transfers.
- Step the active map, actor state, warps, flags, and script VM.
- Render textbox windows with baked glyph data.
- Decode player input into scene movement and script choices.
- Expose a small debug block for emulator inspection during development.

## Non-goals

The runtime does not run Solid, Vue Vapor, QuickJS, or the PocketJS framework
component system. That keeps AOT independent from the PSP UI product line and
lets the compiler own most of the complexity.
