# PocketJS Windows Mobile 6 VS2005 projects

This solution contains three native Smart Device applications for the HP iPAQ
212 port:

- `PocketJS.WM6.Probe` is the first hardware gate. It exercises the screen,
  GDI, stylus, keys, timer, memory reporting, and deployment path.
- `PocketJS.WM6.Vapor` runs the repository's Pocket Vapor Todo component after
  ahead-of-time compilation to portable C. It is the first application UI on
  WM6, but it is not a QuickJS host and cannot load ordinary PocketJS bundles.
- `PocketJS.WM6.QuickJS` builds a VC8 host and deploys the CeGCC-built QuickJS
  DLL plus the real `apps/hero` bundle (`JSX at 60 FPS.`). That DLL contains
  the native ARMv4T Rust PocketJS core. QuickJS HostOps call the core's real
  tree, styles, Taffy layout, animation, texture/font, and software-raster
  APIs. Each incremental ARGB32 core frame is converted to RGB565 and
  presented through DirectDraw. The host requests the absolute
  `DMDO_90` orientation relative to the device's default portrait mode before
  mounting the bundle and restores the previous mode when it exits. The
  rotated `SM_CXSCREEN` and `SM_CYSCREEN` values become the PocketJS viewport
  and the dynamically allocated logical framebuffer dimensions, so VGA uses
  640x480 while QVGA uses 320x240. PocketJS performs layout directly against
  that viewport rather than scaling a fixed 480x272 screenshot. The window
  title reports whether landscape rotation succeeded, even without a debugger.
  Pixel masks are queried from the primary surface separately after a display
  rotation; a missing 16-bit mask falls back to the WM6 RGB565 layout instead
  of silently converting every source color to black.

The Probe and Vapor applications are VC8-compatible Smart Device projects
rather than desktop Win32 projects. The QuickJS deployment anchor is also a
VC8 Smart Device project; only its QuickJS DLL comes from CeGCC. The probe
exercises the OS surface that a future full PocketJS host will need:

- ARMV4I code generation for the PXA310 device;
- a fullscreen, dynamically sized native window;
- a double-buffered GDI presentation loop;
- a `HI_RES_AWARE` executable resource so VGA devices expose native pixels;
- stylus press, drag, and release coordinates;
- hardware key events;
- runtime screen and memory reporting.

The hardware and Vapor executables do not embed QuickJS or the PocketJS
retained UI core. The QuickJS project does: its v2 DLL ABI owns the Rust core
and forwards native HostOps, PAK loading, fixed-step frames, and framebuffer
capture; see
[`docs/WM6_IPAQ_212.md`](../../../docs/WM6_IPAQ_212.md) for the staged port.

## Build

1. Install Visual Studio 2005 Standard or higher with **Visual C++ Smart
   Device Programmability**.
2. Install Visual Studio 2005 SP1 and the relevant Vista update if the build
   VM uses Vista.
3. Install **Windows Mobile 6 Professional SDK Refresh**. Microsoft maps
   Windows Mobile Classic/Pocket PC devices to this SDK; the similarly named
   Standard SDK is for non-touchscreen Smartphones.
4. Open `PocketJS.WM6.sln`.
5. To rebuild the native core and Hero host assets under WSL, run
   `engine/wm6/build-core.sh`, `tools/build.ts hero-main`,
   `hosts/wm6/quickjs/build-demo.sh`, and
   `hosts/wm6/quickjs/build-runtime.sh`. The first and last commands require
   the tool paths documented in their adjacent READMEs. Known-good ARM/WinCE
   and JavaScript files are checked in for deployment.
6. Select `Release | Windows Mobile 6 Professional SDK (ARMV4I)`.
7. Right-click the project you want to run and choose **Set as StartUp
   Project**.
8. Build and deploy through Visual Studio, or copy the corresponding executable
   from `bin\Release` to the device.

The applications have no MFC, ATL, .NET Compact Framework, or redistributable
runtime dependency.

## Pocket Vapor Todo controls

The WM6 host maps the D-pad directly. Centre/Enter is A, Back is B, and the two
soft keys are Select and Start. On an emulator without those buttons, stylus
taps provide a minimal fallback:

- top third: Up;
- middle third: Down;
- bottom-left: A;
- bottom-right: B.

The Todo component itself uses Up/Down to select, A to toggle, B to delete,
Right to change the filter, and Start to open the editor. The checked-in
`generated\todo.gba.c` is deterministic output from
`vapor\examples\todo\todo.tsx`; the WM6 host reuses its 30×20 logical grid and
RGB555 style table. `runtime\vapor.h` and `runtime\vapor_core.c` are checked-in
copies of the repository runtime so the `vs2005` directory remains
self-contained when it is mounted as `Y:\vs2005` in the build VM.

Press an unmapped Back/Escape key to exit. If the ROM consumes that key, stop
the application from **Settings > System > Memory > Running Programs**.

If the probe reports `240 x 320` on a 480×640 iPAQ, the device is running an
older executable without the `HI_RES_AWARE` resource. Clean the solution,
rebuild it, and confirm that `resources\probe.rc` appears in the build log
before redeploying.
