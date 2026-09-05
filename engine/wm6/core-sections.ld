/*
 * Rust and LLVM emit one section per function/data item. The old CeGCC PE
 * linker treats unknown .text.* and .rodata.* inputs as separate output
 * sections, creating thousands of 512-byte-aligned PE sections. Fold them
 * while the object is still ELF, where GNU ld understands all ARM relocs.
 */
SECTIONS
{
    .text 0 : ALIGN(4)
    {
        *(.text)
        *(.text.*)
    }
    /* WinCE PE names its read-only data section .rdata. */
    .rdata 0 : ALIGN(8)
    {
        *(.rodata)
        *(.rodata.*)
    }
    .data 0 : ALIGN(8)
    {
        *(.data)
        *(.data.*)
    }
    .bss 0 : ALIGN(8)
    {
        *(.bss)
        *(.bss.*)
        *(COMMON)
    }
    .noinit 0 : ALIGN(4)
    {
        *(.noinit)
        *(.noinit.*)
    }
    /DISCARD/ :
    {
        *(.ARM.exidx*)
        *(.comment)
        *(.llvmbc)
        *(.llvmcmd)
        *(.note.GNU-stack)
        *(.ARM.attributes)
    }
}
