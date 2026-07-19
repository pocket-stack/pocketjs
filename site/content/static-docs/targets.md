# GBA / GB / NES

One portable engine (`runtime/core/vm.c` + `rpg.c`) owns every gameplay
decision. Each console adds a small HAL — video, input, audio, ROM access —
and nothing else, which is why the logical state is identical by
construction.

## Game Boy Advance

Mode 0. BG0 is the map (charblock 0, hardware scroll), BG1 the textbox,
16x16 sprites through a shadow OAM committed at vblank. VRAM is CPU-writable
any time, so the HAL is direct. Cartridge header ships with the logo and
checksum patched — flashcart-friendly.

## Game Boy

The textbox is the **window layer**: showing dialogue is a register write,
and closing it never repaints the map. All steady-state VRAM traffic goes
through a write queue drained strictly inside vblank behind a STAT gate —
the DMG silently drops writes outside modes 0/1, which the E2E suite caught
as a single missing letter. OAM goes up via the classic HRAM DMA stub;
blobs bank-switch through MBC5.

The portable engine avoids u8xu8 multiplies entirely: sdcc 4.6's SM83 port
miscompiles some `__muluchar` frames, so hot arithmetic is accumulation and
shifts.

## NES

The NMI owns the PPU: OAM DMA plus a 64-entry VRAM ring (single writes and
fill-8 runs), then a scroll/latch reset. CHR-RAM is uploaded with rendering
off; sprites are 8x16 pairs in pattern table 1; the textbox owns tile rows
24-29 so palette attributes (16px granularity) never bleed into the map.
cc65 code can take more than a video frame per engine tick, so the headless
harness paces scenarios on the debug block's tick counter instead of frames
— scenarios stay tick-accurate at any speed.

## The contract

Every runtime mirrors one debug block (magic, player state, script/text
state, RNG, all flags and vars) to a fixed address each frame:

| console | debug block | emulator |
|---|---|---|
| GBA | `0x02000000` (EWRAM) | libmgba |
| Game Boy | `0xDF00` (WRAM) | libmgba |
| NES | `0x0700` (CPU RAM) | jsnes |

The cross-target suite drives identical scenarios through all three and
compares every checkpoint against the TypeScript reference VM.
