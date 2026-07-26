; vapor/runtime/nes/crt0.s — NES startup + NMI for Pocket Vapor (ca65).
; Pocket Static lineage, simplified: no sprites, no banking (NROM-256,
; CHR-ROM font). The NMI owns the PPU: it blits up to two staged rows
; (converted from the shadow grid by the C side) and resets the scroll.

.import _main
.importzp sp, tmp1
.import _stage_n, _stage_hi, _stage_lo, _stage_data, _nmi_count

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

    ; cc65 C stack at $07FF, growing down
    lda #$ff
    sta sp
    lda #$07
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

    lda _stage_n
    beq @scroll
    ldx #0             ; row index
@row:
    cpx _stage_n
    bcs @rowsdone
    bit $2002          ; reset address latch
    lda _stage_hi,x
    sta $2006
    lda _stage_lo,x
    sta $2006
    txa                ; data offset = row * 32
    asl a
    asl a
    asl a
    asl a
    asl a
    tay
    lda #22            ; VP_GRID_W cells per row
    sta tmp1
@cell:
    lda _stage_data,y
    sta $2007
    iny
    dec tmp1
    bne @cell
    inx
    bne @row
@rowsdone:
    lda #0
    sta _stage_n

@scroll:
    bit $2002
    lda #0
    sta $2005
    sta $2005
    lda #$80           ; NMI on, pattern table 0, nametable $2000
    sta $2000

    inc _nmi_count

    pla
    tay
    pla
    tax
    pla
irq:
    rti

.segment "VECTORS"
    .word nmi
    .word reset
    .word irq
