; static/runtime/nes/crt0.s — NES startup + NMI for Pocket Static (ca65).
;
; The NMI owns the PPU: OAM DMA from $0200, then drains the shared VRAM
; write ring (single 3-byte entries; hi-bit entries mean "fill 8 bytes"),
; then resets the scroll/address latch. The C side only ever touches the
; PPU directly during init and map loads (rendering + NMI off).

.import _main
.importzp sp
.import _q_hi, _q_lo, _q_val, _q_head, _q_tail, _ppuctrl, _nmi_count
.export _ps_banktable

.segment "CODE"

reset:
    sei
    cld
    ldx #$40
    stx $4017          ; APU frame IRQ off
    ldx #$ff
    txs
    inx                ; x = 0
    stx $2000          ; NMI off
    stx $2001          ; rendering off
    stx $4010          ; DMC off

    bit $2002
@vb1:
    bit $2002
    bpl @vb1

    ; clear RAM $0000-$07FF
    lda #0
    tax
@clr:
    sta $0000,x
    sta $0100,x
    sta $0200,x
    sta $0300,x
    sta $0400,x
    sta $0500,x
    sta $0600,x
    sta $0700,x
    inx
    bne @clr

@vb2:
    bit $2002
    bpl @vb2

    ; cc65 C stack at $06FF, growing down
    lda #$ff
    sta sp
    lda #$06
    sta sp+1

    jsr _main
@halt:
    jmp @halt

; ---------------------------------------------------------------------------
nmi:
    pha
    txa
    pha
    tya
    pha

    ; OAM DMA from $0200
    lda #$00
    sta $2003
    lda #$02
    sta $4014

    ; drain the ring: budget 32 units (single = 1 unit, fill-8 = 8)
    ldy #32
@loop:
    lda _q_head
    cmp _q_tail
    beq @done
    and #$3f
    tax
    lda _q_hi,x
    bpl @single
    ; fill-8 entry
    and #$3f
    sta $2006
    lda _q_lo,x
    sta $2006
    lda _q_val,x
    ldx #8
@fill:
    sta $2007
    dex
    bne @fill
    inc _q_head
    tya
    sec
    sbc #8
    tay
    beq @done
    bpl @loop
    bmi @done
@single:
    sta $2006
    lda _q_lo,x
    sta $2006
    lda _q_val,x
    sta $2007
    inc _q_head
    dey
    bne @loop
@done:
    ; reset address latch + scroll, restore control
    bit $2002
    lda #0
    sta $2005
    sta $2005
    lda _ppuctrl
    sta $2000

    inc _nmi_count

    pla
    tay
    pla
    tax
    pla
irq:
    rti

; UNROM bus-conflict-safe bank latch table (write index to matching byte).
_ps_banktable:
    .byte 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15

.segment "VECTORS"
    .word nmi
    .word reset
    .word irq
