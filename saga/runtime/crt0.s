@ saga/runtime/crt0.s — GBA cartridge header + startup for @pocketjs/saga.
@ Logo (0x04) and complement (0xBD) are patched by saga/compiler/rom.ts.
    .section .init, "ax"
    .global _start
    .cpu arm7tdmi
    .align 2
    .arm
_start:
    b .Lstart
    .space 156, 0             @ Nintendo logo (patched)
    .ascii "SAGA        "     @ 0xA0: title (12)
    .ascii "PJCE"             @ 0xAC: game code
    .ascii "PJ"               @ 0xB0: maker code
    .byte 0x96
    .byte 0x00
    .byte 0x00
    .space 7, 0
    .byte 0x00
    .byte 0x00                @ complement (patched)
    .space 2, 0
.Lstart:
    @ IRQ-mode stack
    msr cpsr_c, #0xD2
    ldr sp, =0x03007FA0
    @ system-mode stack, IRQs ENABLED at the CPU (the saga runtime is
    @ interrupt-driven: VBlank frame sync + HBlank raster FX)
    msr cpsr_c, #0x5F
    ldr sp, =0x03007F00

    @ copy .data + .iwram code (ROM LMA -> IWRAM VMA)
    ldr r0, =__data_lma
    ldr r1, =__data_start
    ldr r2, =__data_end
.Lcopy:
    cmp r1, r2
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo .Lcopy

    @ zero .bss
    ldr r1, =__bss_start
    ldr r2, =__bss_end
    mov r3, #0
.Lbss:
    cmp r1, r2
    strlo r3, [r1], #4
    blo .Lbss

    ldr r0, =main
    mov lr, pc
    bx r0
.Lhang:
    b .Lhang
