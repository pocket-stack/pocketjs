# iPhone 2G / iPhone OS 1.1.4 host

This is the deliberately private first-stage host for the original iPhone.
It validates the risky platform seam before the target is advertised in the
production registry: Xcode 26 emits ARMv6, `ld-classic` links against the
byte-verified stock 4A102 sysroot, and UIKit 229 presents a real 320-pixel-wide
touch surface.

The host is C on purpose. Modern `ld-classic` can link ARMv6 code and stock
ObjC libraries, but crashes while translating ObjC1 class-reference
relocations emitted for an `@implementation`. `runtime.c` therefore registers
its view and delegate with the Objective-C runtime API. Device input is read
from the iPhone OS 1.x `GSEvent`; it is exposed to PocketJS as the
hardware-neutral `input.touch` capability.

Run the read-only checks and build the complete demo bundle:

```sh
bun tools/iphone2g.ts doctor
bun tools/iphone2g.ts build
```

Artifacts are written to `dist/iphone2g/PocketJSDemo.app`. The app contains
the generated Solid/PocketJS guest, pinned QuickJS, PocketJS raster core, and
UIKit host. Firmware, the decrypted sysroot, Apple Csu and QuickJS sources,
pairing records, SSH keys, ramdisks, historical bootstrap packages, and Cargo
target cache live only under the shared Pocket Stack cache. They are never
copied into the repository.

Deployment is intentionally gated on a raw pre-change filesystem image and a
key-only SSH bootstrap. See `docs/IPHONE2G.md`; do not run ZiPhone, change the
baseband, alter activation, enable AFC2, or make the stock `fstab` writable.
