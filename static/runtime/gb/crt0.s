; static/runtime/gb/crt0.s — Game Boy startup for Pocket Static (sdasgb).
; Header logo/checksums are patched by rgbfix; makebin sizes the ROM.
; No GBDK: this is the whole bare-metal bring-up.

    .module crt0
    .globl _main

    .area _HEADER (ABS)
    .org 0x0000
    ; rst vectors + unused irq vectors: point everything harmless
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
    .db 0x19           ; cart type MBC5
    .db 0x00           ; rom size (rgbfix/makebin fix)
    .db 0x00           ; ram size
    .db 0x01           ; dest
    .db 0x33           ; old licensee
    .db 0x00           ; version
    .db 0x00           ; header checksum (rgbfix)
    .db 0x00, 0x00     ; global checksum (rgbfix)

init:
    di
    ld sp, #0xDF00     ; debug block owns 0xDF00-0xDFBB; stack below it

    ; zero WRAM 0xC000-0xDEFF (bss + queue + shadow OAM)
    ld hl, #0xC000
    ld bc, #0x1F00
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
