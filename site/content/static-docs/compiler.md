# Pipeline & assets

```
evaluate    run the declaration zone; freeze script generators as ASTs
scripts     generator ASTs -> stack-VM bytecode (per console: text pages differ)
model       layouts/legends -> tile grids, collision, actors, warps, budgets
link        blobs + tables; symbolic warp/actor operands patched
targets/*   native art encodings + data emission + toolchain drive
```

`spec/isa.ts` is the single source of truth for the ISA, record layouts, and
the debug block; `spec/gen-c.ts` derives the C header every runtime compiles
against, so TypeScript and C cannot drift.

## Assets

Art is authored (or generated) as palette-indexed hex rows — 8x8 tiles and
16x16 sprite frames with three facings (left mirrors right in hardware on
all three consoles). Encoders produce each console's native format:

- **GBA** — 4bpp packed, 16-color banks in BGR555.
- **Game Boy** — 2bpp interleaved; colors map to 4 shades by luma, with
  sprite colors clamped to visible shades.
- **NES** — 2bpp planar; palettes reduce to the console's 64-color master
  palette, one background subpalette plus up to four sprite subpalettes.

## Data placement

Every blob (scripts, text banks, maps, tile stores) is placed whole. The GBA
keeps a flat address space; the Game Boy (MBC5) and NES (UNROM) assign each
blob to a 16 KB bank and the runtime latches banks per access — on the NES
through a bus-conflict-safe identity table.

## Budgets

Budgets are compile errors, not runtime surprises: map sizes per console
(NES maps stop at 32x24 so the textbox owns whole attribute rows), one text
bank entry per wrapped page, 16 KB per blob, 12 sprites, 256 flags, 64 vars.
