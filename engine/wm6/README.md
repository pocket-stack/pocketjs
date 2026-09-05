# PocketJS Core for Windows Mobile 6

This target reuses the complete retained `pocketjs-core` through the existing
Symbian C ABI. The two legacy hosts have the same useful boundary: a C/C++
application owns its event loop and presentation surface, while a freestanding
Rust static library owns the tree, style table, layout, animation, DrawList,
font/image registries, and deterministic CPU rasterizer.

Rust deliberately emits ordinary `armv4t-none-eabi` ELF first. CeGCC and
Visual Studio 2005 cannot consume that object directly, so `build-core.sh`
performs a narrow, checked conversion to `pe-arm-wince` COFF:

1. rustc builds the complete core for the ARMv4T soft-float baseline;
2. GNU ARM ELF ld folds Rust's per-item sections into `.text`, `.rdata`,
   `.data`, and `.bss`, and removes unwind/LLVM metadata;
3. a dual-target CeGCC binutils `objcopy` writes WinCE COFF;
4. `patch_arm_coff_relocs.py` maps the three emitted ARM relocations and
   rebuilds every relocation symbol index from the authoritative ELF tables.
   It also clears the ELF branch instruction's `-8` PC-bias addend because
   WinCE `ARM_26` uses the CeGCC convention of a zero immediate;
5. WinCE ld performs a second relocatable link as a structural verification;
6. the build rejects a core that is not ARMv4T, does not contain exactly the
   four folded COFF sections, loses a required `ui_*` entry point, or imports
   anything beyond the four allocator/abort functions supplied by the host.

The WM6 build disables the Symbian GLES2 backend. It uses `ui_render_incremental`
to obtain the real PocketJS ARGB32 framebuffer, then converts/presents that
buffer through the WM6 RGB565 DirectDraw layer.

This requires an ordinary `arm-none-eabi` binutils installation and the
CeGCC 9.3 binutils configured with both `arm-mingw32ce` and
`arm-none-eabi` BFD targets. Point the script at those installed tools, or at
the corresponding build-tree executables:

```sh
WM6_CE_OBJCOPY=/opt/cegcc/bin/arm-mingw32ce-objcopy \
WM6_CE_OBJDUMP=/opt/cegcc/bin/arm-mingw32ce-objdump \
WM6_CE_LD=/opt/cegcc/bin/arm-mingw32ce-ld \
WM6_CE_NM=/opt/cegcc/bin/arm-mingw32ce-nm \
  bash engine/wm6/build-core.sh
```

The default output is
`hosts/wm6/vs2005/prebuilt/PocketJS.WM6.Core.obj`. The QuickJS runtime build
links that object into `PocketJS.WM6.QuickJS.v3.dll`; the standalone object is a
generated intermediate and is not deployed.
