@ vapor/runtime/gba/crt0.s — cartridge header + startup for Pocket Vapor.
@ Same lineage as Pocket Static's crt0: the Nintendo logo bytes and header
@ checksum are patched into the final .gba by compiler/rom.ts; the zeros
@ here are placeholders. System mode with IRQs architecturally enabled
@ (REG_IME stays 0) — the 0xDF hang lesson.

    .section .crt0, "ax"
    .arm
    .global _start
_start:
    b rom_start

    .space 156          @ Nintendo logo (patched post-link)
    .space 12           @ game title (patched)
    .space 4            @ game code (patched)
    .byte 0x30, 0x31    @ maker "01"
    .byte 0x96          @ fixed
    .byte 0x00          @ main unit
    .byte 0x00          @ device type
    .space 7            @ reserved
    .byte 0x00          @ software version
    .byte 0x00          @ complement check (patched)
    .space 2            @ reserved

rom_start:
    mov r0, #0x5f
    msr cpsr_c, r0
    ldr sp, =0x03007f00

    @ copy .data ROM -> IWRAM
    ldr r0, =__data_lma
    ldr r1, =__data_start
    ldr r2, =__data_end
1:  cmp r1, r2
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo 1b

    @ zero .bss
    ldr r1, =__bss_start
    ldr r2, =__bss_end
    mov r3, #0
2:  cmp r1, r2
    strlo r3, [r1], #4
    blo 2b

    ldr r0, =main
    bx r0
3:  b 3b
