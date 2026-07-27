# QuickJS for Windows Mobile 6

This directory is the first executable QuickJS toolchain milestone for the
WM6 port. It builds the repository's pinned `pocket-stack/quickjs-rs` revision
as an ARM Windows CE application with the native CeGCC toolset. Code generation
uses the SDK's ARMV4I-compatible instruction baseline (`-march=armv4t`), so
the same binary runs in the WM6 emulator and on the ARMv5TE PXA310.

Visual C++ 2005 remains the windowing, deployment, and debugger tool for the
PocketJS host. QuickJS itself uses CeGCC because current QuickJS is
GNU C99 and cannot be compiled by VC8. A narrow C DLL API is the integration
boundary; QuickJS values and allocations stay on the CeGCC side.

## Pinned source

- repository: `https://github.com/pocket-stack/quickjs-rs`
- revision: `0fc946fb670c0c29bc0135f510bcb0f595415a61`
- QuickJS version: `2026-06-04`

These values deliberately match `tools/cli/symbian-toolchain.json`.

## Build the probe

Install or extract the native-API `mingw32ce` CeGCC toolchain, then run:

```sh
WM6_CEGCC_ROOT=/opt/mingw32ce-0.59.1 \
  hosts/wm6/quickjs/build-probe.sh
```

Old CeGCC Linux binaries may require compatible 32-bit MPFR, GMP, and zlib
shared libraries. If they are not installed system-wide, point the loader at
their directory:

```sh
WM6_CEGCC_ROOT=/opt/mingw32ce-0.59.1 \
WM6_CEGCC_LIBDIR=/opt/mingw32ce-compat/lib \
  hosts/wm6/quickjs/build-probe.sh
```

For a repeat build without another network fetch, set `WM6_QUICKJS_SOURCE` to
a local checkout at the pinned revision.

The default output is
`hosts/wm6/vs2005/prebuilt/PocketJS.WM6.QuickJS.Probe.exe`. The executable
performs 100 create/evaluate/drain/destroy cycles with an 8 MiB-limited
QuickJS runtime and 256 KiB stack. Each cycle calls a native `print` function
from a Promise job. Success shows `QuickJS 6,10,16,26` under the title
`QuickJS: 100 cycles passed` in a native WM6 message box.

## Hero demo host

`build-runtime.sh` builds `PocketJS.WM6.QuickJS.dll` with a versioned C ABI,
statically linked libgcc, and the native Rust core produced by
`engine/wm6/build-core.sh`. The DLL installs the same `ui` HostOps boundary as
the Symbian host: JavaScript node/style/texture/animation calls go directly to
the real retained Rust `Ui`. It also copies the PAK into QuickJS before mount,
advances `globalThis.frame` and `ui_tick` at the host cadence, and exposes the
core's incremental ARGB32 framebuffer.

`build-demo.sh` packages the unmodified real `dist/hero-main.js` output; it no
longer prepends a JavaScript tree or hand-authored draw-list adapter.
VS2005 builds `PocketJS.WM6.QuickJS.exe`, deploys the DLL, bundle, and PAK,
and mounts the Solid application. The native
screen size after WM6 rotation becomes `ui.__viewport`. Each Rust ARGB32 frame
is converted to the application-owned RGB565 buffer and presented through a
locked DirectDraw primary surface. Arrow keys and Enter/Space are mapped to the
PocketJS directional and Circle button bits. Stylus contacts use the wide
PocketJS touch encoding so the full 640×480 VGA coordinates are preserved.

The compatibility patch:

- disables QuickJS atomics because WM6 has no pthread/C11 atomic API;
- uses GCC built-ins for stack allocation and `signbit`;
- avoids `_msize`, which is absent from the Windows CE CRT;
- temporarily reports UTC for `Date#getTimezoneOffset`;
- supplies the C99 `fmax` and `fmin` functions missing from the CE CRT.

The UTC fallback is intentionally conservative and must be replaced with a
WinCE `SYSTEMTIME`/timezone implementation before shipping a general runtime.

## Native integration smoke test

`test-runtime-native.sh` compiles the exact WM6 QuickJS bridge against the
same Rust core on the development host, evaluates the checked-in Hero bundle,
installs its PAK, forwards one wide touch frame, and verifies a non-empty
640×480 ARGB32 framebuffer. This does not replace ARMV4I emulator acceptance,
but it catches JS/HostOps/core integration regressions before deployment:

```sh
WM6_QUICKJS_SOURCE=/path/to/pinned/quickjs-rs \
  hosts/wm6/quickjs/test-runtime-native.sh
```
