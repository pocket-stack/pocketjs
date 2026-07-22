/* vapor/runtime/gba/gba.ld — ROM + IWRAM layout (Pocket Static lineage).
 * EWRAM (0x02000000) is deliberately left out of every section: the Pocket
 * Vapor debug block owns its base. */
OUTPUT_ARCH(arm)
ENTRY(_start)

MEMORY {
  rom   (rx)  : ORIGIN = 0x08000000, LENGTH = 32M
  iwram (rwx) : ORIGIN = 0x03000000, LENGTH = 32K
}

SECTIONS {
  .text : {
    KEEP(*(.crt0))
    *(.text*)
    *(.rodata*)
    . = ALIGN(4);
  } > rom

  __data_lma = .;
  .data : AT(__data_lma) {
    __data_start = .;
    *(.data*)
    . = ALIGN(4);
    __data_end = .;
  } > iwram

  .bss : {
    __bss_start = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    __bss_end = .;
  } > iwram
}
