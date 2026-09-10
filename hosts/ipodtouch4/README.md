# PocketJS iPod touch 4 host

This host targets the exact `iPod4,1` / iOS 6.1.6 / `10B500` hardware tuple.
It compiles the shared legacy UIKit runtime (`hosts/ios-legacy/runtime.c`) for
ARMv7 and links it against the validated iPhone 4S sysroot — the same 6.1.3
ARMv7 shared-cache extraction, reused because the stubs are link-time only
and iOS 6.1.6 resolves the same install names. Apple system binaries are
never committed or included in the npm package.

The wrapper requires OpenGL ES 1.1. The retained UI core and UIKit view both
use density 2, and the host accepts only a 640×960 renderbuffer for the
320×480 logical surface. The runtime delivers up to eight touch contacts per
frame from its slot table; this device is the multi-touch acceptance hardware
for the legacy Apple hosts.

SpringBoard artwork reuses the classic PocketJS icon pipeline
(`tools/iphone-classic-icon.ts`).

Deployment produces an IPA and uses iOS 6 MobileInstallation to register a
**sandboxed User application with native SpringBoard deletion**. AppSync
Unified is required for these local self-signed builds. Updates retain app
data; uninstall removes the container and its runtime receipt files.

Use `bun ipodtouch4 doctor`, then the build, deploy, launch, status, capture,
and uninstall commands documented in `docs/IPODTOUCH4.md`.

`bun ipodtouch4:runtime deploy` builds a separate `PocketRuntime.app`. After
`pair` and `launch`, `push` replaces the guest with a validated `.pocket`, and
`dev` watches source changes and bridges DevTools. USB uses the pinned SSH
forwarder; `--lan` uses paired discovery and the shared 3DS Runtime protocol.
The native shell confirms an update after its first GLES presentation and
retains a previous accepted package for recovery. See the persistent Runtime
section of `docs/IPODTOUCH4.md` for commands and acceptance boundaries.
