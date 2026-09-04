# iPod touch 4

The private iPod touch 4 target runs PocketJS on an exact `iPod4,1` device
with iOS 6.1.6 build `10B500`. **The application owns a 320×480-point surface
backed by the device's 640×960 Retina display, rendered through the required
OpenGL ES 1.1 path of the shared legacy UIKit runtime.** The target id is
`ipodtouch4-dev`; it shares host ABI 8 with `iphone4s-dev` because the guest
protocol — the op table, the frame entry, the embedded `__pocket_js` /
`__pocket_pak` sections — is the same runtime compiled for the same
architecture. The target remains outside the public `POCKET_TARGETS` registry.

The bundled application is Pocket Clear (`apps/clear`), a Vue Vapor guest
whose input is entirely gestures; its acceptance receipt is the
`clear_gesture` action counter.

## Multi-contact touch

This target is the reason the legacy UIKit runtime tracks a touch slot table
instead of one contact. **`hosts/ios-legacy/runtime.c` keeps eight slots — the
guest wire cap — with the slot index as the wire contact id, release-latched
delivery (a sub-frame tap is still delivered for at least one guest frame),
and a bounds hit fact resolved once at each contact's down edge.** The frame
entry is `pocket_runtime_frame_contacts`, which packs every contact into the
`frame()` wire words: `x:9 | y:9 | id:8` below 512 logical pixels, the bit-31
wide form above. A single id-0 contact produces the same bytes as the old
single-touch entry points, so existing tapes and hosts decode unchanged. The
1.x GSEvent fallback has no per-finger identity and owns slot 0 alone.

## Device state

The device must be jailbroken before the PocketJS tool connects (p0sixspwn on
iOS 6.1.6 is untethered). The completed bootstrap provides:

- Cydia and a read/write root filesystem;
- OpenSSH on device port 22;
- a dedicated RSA client key and pinned device host key;
- `PasswordAuthentication no` after public-key login succeeds;
- `ldid`, `uicache`, and `uiopen` for application deployment.

The default local files are:

```text
~/.cache/pocket-stack/ipodtouch4/ssh/id_rsa
~/.cache/pocket-stack/ipodtouch4/ssh/known_hosts
```

`POCKETJS_IPODTOUCH4_KEY`, `POCKETJS_IPODTOUCH4_KNOWN_HOSTS`, and
`POCKETJS_IPODTOUCH4_UDID` override those paths and the selected USB device.

## Build inputs

**The toolchain is the iPhone 4S one, byte for byte: the validated iOS 6.1.3
ARMv7 sysroot, Apple's pinned Csu bootstrap, the pinned QuickJS sources, and
the pinned dyld extractor.** The sysroot supplies link-time TAPI stubs and
Mach-O images extracted from the 6.1.3 shared cache; iOS 6.1.6 is the 6.1.3
SDK surface plus a TLS fix, so every linked install name resolves identically
on the device. `bun ipodtouch4 setup-sources` and `bun ipodtouch4
prepare-sysroot` delegate to the iPhone 4S commands so the provenance stays
pinned exactly once.

```sh
bun ipodtouch4 setup-sources
bun ipodtouch4 prepare-sysroot   # needs POCKETJS_IPHONE4S_IPSW on a fresh machine
bun ipodtouch4 doctor
```

## Build and deploy

```sh
bun ipodtouch4 build
bun ipodtouch4 deploy
bun ipodtouch4 launch
bun ipodtouch4 status [--require-action]
bun ipodtouch4 capture
```

`build` resolves `apps/clear/pocket.json` against the `ipodtouch4-dev`
profile, produces the guest bundle and pak, compiles the shared legacy
runtime for `armv7-apple-ios6.0`, and links a `-no_pie` Mach-O with the app
embedded as `__pocket_js` / `__pocket_pak` sections. The build id hashes the
plan, the guest artifacts, every native object, the sysroot stubs, and the
baked artwork.

`deploy` copies the bundle over the USB SSH tunnel, verifies every file's
SHA-256 on the device against the local receipt, and installs under a leased
transactional lock with rollback — the same protocol as the iPhone 4S, with
device paths under `pocketjs-ipodtouch4`.

`status` reads `/private/var/tmp/pocketjs-ipodtouch4.status` twice and
requires the running build id, an advancing frame counter and heartbeat, and
the GLES1 640×960 density-2 drawable. With `--require-action` it additionally
requires at least one completed touch sequence and a reported `clear_gesture`
action — a receipt that a gesture interaction completed on the hardware.

`capture` asks the running app for a raw RGBA frame and converts it to
`dist/ipodtouch4/device-frame.png`.
