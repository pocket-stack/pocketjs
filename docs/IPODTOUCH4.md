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
- `ldid`, `uicache`, and `uiopen` for application deployment;
- **AppSync Unified and its Cydia Substrate dependencies** for local self-signed
  User applications. Install the `iphoneos-arm` package from the
  [upstream release](https://github.com/akemin-dayo/AppSync/releases), then
  reboot once to activate it. `doctor` checks the installed package. The
  deployment command reports an installation failure if the signing support
  is inactive; it does not fall back to a System application.

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
bun ipodtouch4 uninstall         # removes the app and its data
```

`build` resolves `apps/clear/pocket.json` against the `ipodtouch4-dev`
profile, produces the guest bundle and pak, compiles the shared legacy
runtime for `armv7-apple-ios6.0`, and links a `-no_pie` Mach-O with the app
embedded as `__pocket_js` / `__pocket_pak` sections. The build id hashes the
plan, the guest artifacts, every native object, the sysroot stubs, and the
baked artwork.

**`build` also produces `dist/ipodtouch4/PocketJSiPodTouch4.ipa`.** `deploy`
transfers that IPA over the pinned USB SSH tunnel and calls iOS 6
`MobileInstallationInstall` with `ApplicationType=User`. **iOS creates the
UUID container under `/var/mobile/Applications`, owns updates, and preserves
`Documents` and `Library` on update.** Every installed bundle file, including
the build receipt, must match its local SHA-256. A kernel file lock serializes
installation and CLI removal; process exit releases the lock.

The first deployment migrates the former `/Applications/PocketJSiPodTouch4.app`
installation. It checks the bundle identifier, retains the old bundle in a
root-owned migration journal, and refreshes its System registration before
installing the User app. The migration restarts `installd` to reload its
in-memory System map; SpringBoard is not restarted. A failed installation restores the old bundle; the
next deployment reconciles an interrupted migration. The journal is removed
after User registration and installed byte verification pass. The app's old
bundle-specific preferences are copied into its new container when present;
other files in the shared mobile home are not treated as app-owned data.

**Long-pressing the User app on SpringBoard exposes the native delete badge.**
Deleting there, or running `bun ipodtouch4 uninstall`, uses iOS's uninstall
service and removes the application container, including its data. A later
`deploy` installs a fresh container. The CLI verifies that the registration
and container are gone. The privileged installer bridge stays under
`/var/root/Library/PocketJS`; its install/uninstall entitlement is never added
to the application binary.

`launch`, `status`, and `capture` look up the current container from the iOS
installation record. The runtime resolves `NSTemporaryDirectory()` and keeps
its receipts and captures inside that container. **`status` reads
`<container>/tmp/pocketjs.status` twice** and
requires the running build id, an advancing frame counter and heartbeat, and
the GLES1 640×960 density-2 drawable. With `--require-action` it additionally
requires at least one completed touch sequence and a reported `clear_gesture`
action — a receipt that a gesture interaction completed on the hardware.

`capture` asks the running app for a raw RGBA frame and converts it to
`dist/ipodtouch4/device-frame.png`.

User application icons use **opaque 57×57 and 114×114 artwork**. SpringBoard applies the rounded mask and shadow; `UIPrerenderedIcon` suppresses the stock gloss. The System application path uses a precomposed transparent mask instead. Baking that mask into a User icon adds an inset rim under the native mask. Icon filenames include the artwork revision so an update selects a fresh SpringBoard cache entry.

## Persistent Pocket Runtime

**`bun ipodtouch4:runtime deploy` installs `PocketRuntime.app` as a separate
User application**, with bundle identifier `dev.pocket-stack.runtime.ipodtouch4`.
Its embedded recovery guest is Clear. The shell owns a **320×480 logical
surface at density 2**, publishes `ipodtouch4-dev` / ABI 8, and accepts other
applications built for that viewport and capability profile.

```sh
bun ipodtouch4:runtime deploy
bun ipodtouch4:runtime pair
bun ipodtouch4:runtime launch
bun ipodtouch4:runtime push --app clear
bun ipodtouch4:runtime dev --app clear
```

`deploy` builds and installs the native IPA through the deployment path above.
`pair` uses the pinned USB SSH connection to install a 32-byte development
key in the application's container and stores its local copy under
`.pocket/ipodtouch4/devices/`. A repeated `pair` retains the device key;
`pair --rotate` replaces it. Relaunch Runtime after rotation to activate the
replacement. The listener starts after a valid key is present.

**Guest updates use the 3DS Pocket Runtime wire protocol, with TCP and UDP on
port 8131.** The shared codec lives in `engine/runtime/dev_protocol.*`; the
desktop client lives in `tools/pocket-runtime-client.ts`. The default USB
route forwards TCP through the pinned SSH connection. It supports
`POCKETJS_IPODTOUCH4_VIA` and requires no Wi-Fi connection on the device.
The application service channel (`svcwire`, PKNT) has a separate connection
and lifecycle from the Runtime development channel (PKRT).

```sh
bun ipodtouch4:runtime discover
bun ipodtouch4:runtime status --lan
bun ipodtouch4:runtime push --app clear --lan
bun ipodtouch4:runtime dev --app clear --lan

# Select a device when UDP discovery cannot cross the network.
bun ipodtouch4:runtime status --host 192.168.1.42 --key /path/to/device.key
```

LAN discovery matches a device's pairing-derived identifier with a local key.
**The key authenticates the TCP connection; PKRT does not encrypt LAN traffic.**
The USB SSH route provides encryption through SSH.

### Package builds and development

**`pack` builds a `.pocket` without compiling or signing native code.** It
resolves the application's manifest against the private iPod profile and
packages the plan, identity, JavaScript and asset pack. A package upload checks
its manifest and plan on the desktop, then checks its footer, target, ABI,
JavaScript terminator and viewport on the device before replacing the guest.

```sh
bun ipodtouch4:runtime pack --app clear
bun ipodtouch4:runtime push --package dist/ipodtouch4/packages/clear-main/clear-main.pocket

bun ipodtouch4:runtime pack --manifest pocket.json --project-root /path/to/app
bun ipodtouch4:runtime dev --manifest pocket.json --project-root /path/to/app
bun ipodtouch4:runtime dev --package /path/to/app.pocket --lan
```

`dev` watches source changes, rebuilds the guest, pushes its package and opens
a connection to the existing DevTools hub. It prints the panel URL. Tree
inspection, evaluation and logs use the guest's DevTools bindings; status and
package installation remain in native code. `--no-push` attaches without an
initial update. Subsequent source changes trigger updates. A broken connection
starts a reconnect loop; LAN discovery follows the paired device across an
address change. Compile and admission errors wait for another source change.

The native capture command remains available:

```sh
bun ipodtouch4:runtime capture
```

It uses the USB capture path and writes `dist/ipodtouch4/device-frame.png`.
The Runtime TCP transport has no screenshot stream in this version.

### Replacement and recovery

Runtime keeps uploaded packages and generation records under
`<container>/Library/PocketRuntime`. Each transfer writes `upload.tmp` in
bounded binary chunks, then flushes and validates the completed file. Admission
failure leaves the running guest intact. A disconnected or incomplete upload
is discarded.

**A candidate becomes active after its first successful GLES presentation.**
The shell releases the previous guest's textures and QuickJS realm, clears
touch contacts and starts the candidate. It then commits a generation record
with the active and previous accepted package hashes. Stored package filenames
derive from their hashes. Garbage collection retains the active and last-good
packages, plus the newest two generation records.

A boot or frame error selects the previous accepted package. If that package
fails, Runtime tries the last-good package and then embedded Clear. A restart
reads the newest committed generation; a candidate that failed before
presentation cannot replace that record. Failure of the embedded recovery
guest leaves the native development listener available for another upload.

**Reload creates a new JavaScript realm and discards its in-memory state.**
Native code changes require an IPA update. The development shell caps the
QuickJS heap at 32 MiB, guest boot at two seconds and each guest turn at
500 ms. Those time limits include the pending job drain. They do not bound
native rendering calls. Packages are limited to 24 MiB.

**Runtime receives updates while the application is in the foreground.**
Resigning active closes its development sockets and discards a partial
upload. Returning to the foreground reopens the paired listener. The shell
disables auto-lock while active. The installed User app retains native
SpringBoard deletion; removing it deletes its packages and development key.

### Validation

```sh
bun test tests/ipodtouch4-package.test.ts
bun test tests/ipodtouch4-runtime.test.ts
```

The runtime tests link the real QuickJS sources, package reader and retained UI
core into a host process. They exercise TCP transfer, admission failures,
timeouts, guest replacement, recovery after restart and the compiled Clear
application. `POCKETJS_QUICKJS_SOURCE` can select the pinned QuickJS C source
directory; its default is the legacy Apple source cache. The Native C harness
workflow acquires those sources from the repository's pinned revision and
runs the tests on Linux and macOS. These tests do not exercise UIKit, device
installation or the iPod GPU.
