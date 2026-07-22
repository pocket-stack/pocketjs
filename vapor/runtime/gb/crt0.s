; vapor/runtime/gb/crt0.s — Game Boy startup for Pocket Vapor (sdasgb).
; Pocket Static lineage, ROM-only cart (no MBC): header logo/checksums are
; patched by rgbfix; makebin sizes the ROM. Debug block lives at 0xD800;
; the stack tops out at 0xDFF0, well above it.

    .module crt0
    .globl _main

    .area _HEADER (ABS)
    .org 0x0000
    ret
    .org 0x0040       ; vblank irq (unused; IME stays off)
    reti
    .org 0x0048
    reti
    .org 0x0050
    reti
    .org 0x0058
    reti
    .org 0x0060
    reti

    .org 0x0100
    nop
    jp init
    ; 0x0104-0x0133 Nintendo logo (rgbfix -v writes it)
    .ds 48
    ; 0x0134-0x0143 title (rgbfix -t writes it)
    .ds 16
    .db 0x00, 0x00     ; new licensee
    .db 0x00           ; sgb
    .db 0x00           ; cart type ROM only
    .db 0x00           ; rom size
    .db 0x00           ; ram size
    .db 0x01           ; dest
    .db 0x33           ; old licensee
    .db 0x00           ; version
    .db 0x00           ; header checksum (rgbfix)
    .db 0x00, 0x00     ; global checksum (rgbfix)

    ; init lives at the base of _HOME (0x0150, right after the header):
    ; crt0.rel links first, the sdcc library's _HOME fragments follow.
    .area _HOME
init:
    di
    ld sp, #0xDFF0

    ; zero WRAM 0xC000-0xDFEF (bss + debug block + shadow grid)
    ld hl, #0xC000
    ld bc, #0x1FF0
clr:
    xor a
    ld (hl+), a
    dec bc
    ld a, b
    or c
    jr nz, clr

    call gsinit
    jp _main

    ; sdcc initialized-data copy: GSINIT fragments run, GSFINAL returns.
    .area _GSINIT
gsinit:
    .area _GSFINAL
    ret

    .area _CODE
