# PocketJS Windows Mobile 6 VS2005 probe

This solution is the first hardware gate for the HP iPAQ 212 port. It is a
native, C++03-compatible Smart Device application rather than a desktop Win32
project. The executable exercises the OS surface that a future PocketJS host
will need:

- ARMV4I code generation for the PXA310 device;
- a fullscreen, dynamically sized native window;
- a double-buffered GDI presentation loop;
- stylus press, drag, and release coordinates;
- hardware key events;
- runtime screen and memory reporting.

It does **not** embed QuickJS or the PocketJS retained UI core yet. A successful
run proves only the device/SDK/deployment layer; see
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
5. Select `Release | Windows Mobile 6 Professional SDK (ARMV4I)`.
6. Build, then deploy `bin\Release\PocketJS.WM6.Probe.exe` through Visual
   Studio or copy it to the device and launch it.

The probe has no MFC, ATL, .NET Compact Framework, or redistributable runtime
dependency. Press the device's Back/Escape key to exit. If that key is not
mapped by the ROM, stop it from **Settings > System > Memory > Running
Programs**.
