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
- stable Rust has no Windows CE 5.2 / ARMV4I target, and its modern
  ARM-Windows object format cannot simply be linked into a VC8 Smart Device
  executable;
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

Do not begin with the full PocketJS bundle. QuickJS will need a dedicated
WinCE compatibility layer for time, allocation, file APIs, missing CRT calls,
and any missing runtime facilities. Keep those changes as a reviewable patch,
as the Symbian toolchain already does. Gate 1 remains open until the 100-cycle
probe passes on physical iPAQ hardware with before/after free-memory receipts;
emulator success validates the binary and ABI but cannot close the hardware
gate.

The repository-pinned QuickJS revision cannot be compiled directly by VC8: it
uses C99 syntax, flexible arrays, GCC builtins/attributes, compound literals,
and designated initializers. Compiling it as C++ is also not a shortcut because
the C sources rely on implicit `void *` conversions and C linkage rules. Gate 1
therefore uses a separately owned GNU WinCE build. The future VS2005 host will
load a CeGCC-built DLL through a narrow C ABI; QuickJS values and allocator
ownership must never cross that boundary.

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

### Gate 2 — renderer choice

The existing Rust core cannot be treated as a linkable WM6 library. Choose one
of these paths only after Gate 1:

1. **Guest-compatible host (preferred, larger):** port the backend-agnostic
   retained UI and software rasterizer to portable C/C++03 behind the existing
   `ui_*` ABI. Reuse `hosts/symbian/runtime/pocketjs_symbian_core.h` as the ABI
   inventory, but create a platform-neutral header before sharing it.
2. **AOT-first host (implemented as an early milestone, different execution
   class):** adapt the C Pocket Vapor runtime to VC8 and compile applications
   ahead of time. This puts Pocket-authored UI on the device sooner, but it is
   not a PocketJS guest and cannot be advertised as compatible with ordinary
   JS bundles.

For the guest path, start with solid rectangles, clipping, text atlas blits,
and touch hit testing. Use a 240×320 or 480×272 logical viewport rendered to a
16-bit back buffer, then scale/letterbox to the VGA panel. A full 480×640
32-bit double buffer consumes about 2.34 MiB before textures; RGB565 halves
that cost and is a better first hardware target.

### Gate 3 — PocketJS HostOps

After QuickJS and rendering work independently, bind the append-only HostOps
surface. Start with lifecycle, node creation, style/property batches, text,
tick/render, touch, and buttons. Then boot the smallest compiled fixture, not
the gallery or launcher. Add WM6 to the private development profiles only
after its manifest resolver rejects unsupported capabilities.

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
