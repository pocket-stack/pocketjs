/* saga/runtime/gba.ld — GBA link map for @pocketjs/saga.
   .iwram.text (the HBlank ISR) is copied to IWRAM together with .data so the
   per-scanline raster handler never pays ROM waitstates. EWRAM stays free for
   the debug block at 0x02000000. */
OUTPUT_FORMAT("elf32-littlearm")
OUTPUT_ARCH(arm)
ENTRY(_start)

MEMORY {
  rom   (rx)  : ORIGIN = 0x08000000, LENGTH = 32M
  iwram (rwx) : ORIGIN = 0x03000000, LENGTH = 32K
  ewram (rwx) : ORIGIN = 0x02000000, LENGTH = 256K
}

SECTIONS {
  .init : {
    KEEP(*(.init))
    *(.text .text.*)
    *(.rodata .rodata.*)
    . = ALIGN(4);
  } > rom

  __data_lma = .;
  .data : AT (__data_lma) {
    . = ALIGN(4);
    __data_start = .;
    *(.iwram .iwram.*)
    . = ALIGN(4);
    *(.data .data.*)
    . = ALIGN(4);
    __data_end = .;
  } > iwram

  .bss (NOLOAD) : {
    . = ALIGN(4);
    __bss_start = .;
    *(.bss .bss.*)
    *(COMMON)
    . = ALIGN(4);
    __bss_end = .;
  } > iwram

  /DISCARD/ : { *(.comment) *(.note*) *(.ARM.attributes) }
}
