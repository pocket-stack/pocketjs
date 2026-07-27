# HP iPAQ 212 / Windows Mobile 6 port

## Decision

PocketJS should reach the iPAQ 212 through a native Windows Mobile host, built
by Visual C++ 2005 for the Windows Mobile 6 Professional SDK's ARMV4I target.
The repository now contains a first, deployable solution at
`hosts/wm6/vs2005/PocketJS.WM6.sln`.

This is intentionally an experimental port, not a production target in
`POCKET_TARGETS`. Adding a target profile before the complete guest runtime and
its capabilities work on hardware would make build admission promise behavior
that the host does not deliver.

## Why this target

The HP iPAQ 212 belongs to the iPAQ 210 series. It has a 624 MHz Marvell
PXA310, 128 MB SDRAM, and a 4-inch 480×640 touch display, and ships with
Windows Mobile 6 Classic. Despite the device name, Microsoft's SDK mapping is:

| Device class | Required WM6 SDK |
| --- | --- |
| Classic / Pocket PC | Professional SDK |
| Professional / Pocket PC Phone | Professional SDK |
| Standard / Smartphone | Standard SDK |

The Visual Studio platform must therefore read
`Windows Mobile 6 Professional SDK (ARMV4I)`. ARMV4I is the SDK ABI and is
compatible with the PXA310; selecting an unofficial CPU-specific target would
make the binary less portable and would bypass the SDK libraries.

## Honest feasibility boundary

Creating a `.sln` is necessary but not sufficient for the existing guest
runtime:

- the native PocketJS hosts embed QuickJS;
- the retained renderer lives in the Rust `engine/core` crate;
- Visual C++ 2005 predates modern C/C++ language features;
- stable Rust has no Windows CE 5.2 / ARMV4I target; the implemented build
  therefore emits ARMv4T ELF and performs a checked relocation/symbol
  conversion to WinCE COFF with dual-target CeGCC binutils;
- Windows Mobile 6 has neither a suitable browser runtime nor modern Web APIs,
  so wrapping the web host is not a viable shortcut.

The lowest-risk route is to validate each irreversible assumption on the real
device before porting the next layer.

## Port gates

### Gate 0 — native hardware probe (implemented)

Build and run `hosts/wm6/vs2005/PocketJS.WM6.sln`. Accept this gate only when
the physical iPAQ shows:

- `screen: 480 x 640` in portrait (or `640 x 480` after rotation);
- a steadily increasing frame count near the 33 ms timer interval;
- touch coordinates and DOWN/up state following the stylus;
- distinct hexadecimal key codes for the D-pad and centre button;
- stable free RAM after leaving the probe running for ten minutes.

Record the ROM version, orientation, displayed memory values, D-pad key codes,
and whether the Back/Escape key exits. Emulator-only success is insufficient.

Windows Mobile virtualizes a VGA device as `240×320` for legacy applications.
The probe embeds `HI_RES_AWARE CEUX { 1 }` to opt out of that compatibility
scaling. A QVGA result therefore means an older or incorrectly linked resource
was deployed; it is not the iPAQ panel's physical resolution.

### Gate 1 — toolchain-owned QuickJS probe (first executable implemented)

Current QuickJS cannot be built by VC8. The implemented split toolchain keeps
VS2005 as the WM6 window/deployment/debug host and builds QuickJS with CeGCC's
native-API `arm-mingw32ce` compiler. The checked-in ARM/WinCE probe now proves:

1. runtime/context creation;
2. evaluation of an embedded UTF-8 script;
3. a native `print` callback plus Promise pending-job draining;
4. explicit 8 MiB memory and 256 KiB stack limits;
5. 100 repeated create/evaluate/drain/destroy cycles.

Its pinned source, compatibility patch, and reproducible build command live in
`hosts/wm6/quickjs`. `PocketJS.WM6.QuickJS` in the VS2005 solution deploys the
resulting CeGCC executable and starts it on the selected device or emulator.
The CeGCC build targets ARMV4T with interworking rather than the PXA310's
ARMv5TE extensions: the WM6 ARMV4I emulator rejects ARMv5-only instructions
such as `CLZ`, while the physical PXA310 remains backward-compatible.

QuickJS now has a dedicated WinCE compatibility layer for allocation, missing
CRT calls, and the subset used by the Hero guest. Those changes remain a
reviewable patch, as the Symbian toolchain does. Gate 1 remains open until the 100-cycle
probe passes on physical iPAQ hardware with before/after free-memory receipts;
emulator success validates the binary and ABI but cannot close the hardware
gate.

The repository-pinned QuickJS revision cannot be compiled directly by VC8: it
uses C99 syntax, flexible arrays, GCC builtins/attributes, compound literals,
and designated initializers. Compiling it as C++ is also not a shortcut because
the C sources rely on implicit `void *` conversions and C linkage rules. Gate 1
therefore uses a separately owned GNU WinCE build. The future VS2005 host will
load a CeGCC-built DLL through a narrow C ABI; QuickJS values and allocator
ownership must never cross that boundary. That DLL boundary is now
implemented as ABI v2; it also owns the linked Rust core so QuickJS values,
Rust allocations, and framebuffer pointers stay on the CeGCC side.

### AOT milestone — Pocket Vapor Todo (implemented)

`PocketJS.WM6.Vapor` is an independent application project in the same VS2005
solution. It links:

- a checked-in copy of the target-independent `vapor/runtime/vapor_core.c`
  (kept inside the solution so a `Y:\vs2005` VM mount is self-contained);
- deterministic C generated from `vapor/examples/todo/todo.tsx`;
- a WM6 GDI cell-grid host with D-pad, centre, Back, soft-key, and stylus
  mappings.

This milestone deliberately follows the AOT-first option described below. It
proves that Pocket-authored reactive UI can execute on the SDK ABI without a
heap or JavaScript engine, and it gives the real iPAQ a useful memory/input
test while QuickJS compatibility work continues. It must not be described as
ordinary PocketJS guest compatibility.

### Gate 2 — native Rust renderer (implemented; runtime receipt pending)

The guest-compatible path now reuses the actual Rust core rather than
rewriting it in C:

1. nightly rustc builds the freestanding core for `armv4t-none-eabi`;
2. ARM ELF ld merges per-item sections and discards unwind/LLVM metadata;
3. dual-target CeGCC binutils converts ELF to WinCE COFF;
4. a repository tool reconstructs all COFF relocation symbol indices and
   strictly maps `R_ARM_ABS32`, `R_ARM_CALL`, and `R_ARM_JUMP24`;
5. CeGCC links that object into the QuickJS DLL.

The final DLL has 16 PE sections instead of thousands of Rust per-item
sections. The core renders its real incremental ARGB32 framebuffer at the
rotated native viewport; the VC8 host converts it to an RGB565 staging buffer
and presents it through DirectDraw. The next emulator run must provide the
runtime receipt before this gate is considered closed.

### Gate 3 — PocketJS HostOps (implemented; runtime receipt pending)

The ABI v2 DLL installs native lifecycle, node, style/property batch, text,
texture/font, animation, focus/hit-test, debug, tick, and render operations.
It copies the PAK into QuickJS before evaluating the unmodified Hero bundle,
calls `globalThis.frame` at the WM6 timer cadence, ticks the core, and returns
the incremental framebuffer. The former JavaScript tree and hand-authored
draw-list adapter have been removed. D-pad keys and Enter/Space currently feed
the PocketJS directional/Circle button bits; stylus forwarding remains a
follow-up after the first core-rendered emulator receipt.

### Gate 4 — packaging and production admission

Produce a CAB only after direct EXE deployment is stable. The CAB should
install one application under `\Program Files\PocketJS`, add a Start Menu
shortcut, and uninstall without touching shared storage. Promote WM6 to
`POCKET_TARGETS` only when:

- the stock host boots a real `.pocket` guest;
- viewport and input contracts have device tests;
- memory has a measured ceiling;
- suspend/resume and orientation behavior are defined;
- an iPAQ 212 hardware receipt identifies the ROM and binary hash.

## Recommended build machine

Use an isolated 32-bit Windows XP SP3 VM for the shortest path, with Visual
Studio 2005 SP1, the Smart Device C++ feature, and the WM6 Professional SDK
Refresh. ActiveSync 4.5 is the period-correct XP deployment path. A Vista VM
can use Windows Mobile Device Center plus Microsoft's VS2005 Vista updates,
but modern Windows hosts add driver and installer failure modes unrelated to
the port.

Keep the VM offline except while obtaining original toolchain installers.
Never flash the iPAQ as part of this workflow; copying or debugging an
application does not require a ROM change.

## Sources

- [Microsoft: Windows Mobile 6 SDK Refresh download and SDK mapping](https://www.microsoft.com/en-us/download/details.aspx?id=6135)
- [HP: iPAQ 200 series product specifications](https://support.hp.com/tw-zh/document/c01419121)
