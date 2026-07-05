@ aot/runtime/crt0.s — GBA cartridge header + bare-metal startup.
@ Header bytes 0x04..0x9F (Nintendo logo) and 0xBD (complement) are patched by
@ the compiler's ROM writer (aot/compiler/rom.ts) after objcopy.
    .section .init, "ax"
    .global _start
    .cpu arm7tdmi
    .align 2
    .arm
_start:
    b .Lstart                 @ 0x00: branch past the 0xC0-byte header
    .space 156, 0             @ 0x04: Nintendo logo (patched)
    .ascii "POCKET TOWN "     @ 0xA0: game title (12)
    .ascii "PJAE"             @ 0xAC: game code (4)
    .ascii "PJ"               @ 0xB0: maker code (2)
    .byte 0x96                @ 0xB2: fixed value
    .byte 0x00                @ 0xB3: main unit code
    .byte 0x00                @ 0xB4: device type
    .space 7, 0               @ 0xB5: reserved (7)
    .byte 0x00                @ 0xBC: software version
    .byte 0x00                @ 0xBD: complement check (patched)
    .space 2, 0               @ 0xBE: reserved (2)
.Lstart:                      @ 0xC0
    @ IRQ-mode stack (IRQ+FIQ disabled)
    msr cpsr_c, #0xD2
    ldr sp, =0x03007FA0
    @ system-mode stack (IRQ+FIQ disabled)
    msr cpsr_c, #0xDF
    ldr sp, =0x03007F00

    @ copy .data (ROM LMA -> IWRAM VMA), word-wise
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

    @ main()
    ldr r0, =main
    mov lr, pc
    bx r0
.Lhang:
    b .Lhang
