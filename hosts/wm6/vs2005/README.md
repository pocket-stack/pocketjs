# PocketJS Windows Mobile 6 VS2005 projects

This solution contains three native Smart Device applications for the HP iPAQ
212 port:

- `PocketJS.WM6.Probe` is the first hardware gate. It exercises the screen,
  GDI, stylus, keys, timer, memory reporting, and deployment path.
- `PocketJS.WM6.Vapor` runs the repository's Pocket Vapor Todo component after
  ahead-of-time compilation to portable C. It is the first application UI on
  WM6, but it is not a QuickJS host and cannot load ordinary PocketJS bundles.
- `PocketJS.WM6.QuickJS` builds a VC8 host and deploys the CeGCC-built QuickJS
  DLL plus the real `apps/hero` bundle (`JSX at 60 FPS.`). It mounts Solid,
  derives a draw list from the HostOps tree, paints the Hero screen into an
  RGB565 framebuffer, rasterizes the PAK's Inter fonts and RGBA logo/spinner
  assets into the same buffer, and presents it through DirectDraw. GDI is
  retained only as a compatibility fallback.

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
retained UI core. A successful QuickJS probe proves the JavaScript runtime,
but does not yet connect PocketJS lifecycle, input, or rendering APIs; see
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
5. To rebuild the Hero host assets, run `tools/build.ts hero-main`, then
   `..\quickjs\build-demo.sh` and `..\quickjs\build-runtime.sh` under WSL.
   Known-good ARM/WinCE and JavaScript files are checked in for deployment.
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
