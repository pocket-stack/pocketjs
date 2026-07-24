# Nokia E7 / Symbian Belle development

PocketJS includes a pinned, repeatable command-line bootstrap for building
standard Symbian Qt applications and an experimental PocketJS host for a Nokia
E7 (RM-626). The probe exercises the compiler, Qt ABI, E32 executable, resource
registration, SIS packaging, and signing. The private runtime additionally
links the PocketJS Rust core and pinned QuickJS, embeds a compiled application
and its `.pak`, and exposes the host operations needed to draw and accept
button input. The separate MTP command proves byte delivery to the phone;
installation and launch remain device-side confirmations.

This workflow does not flash or modify firmware. A CFW may relax installation
policy on the phone, but applications should still use the smallest possible
capability set. The runtime uses a private `symbian-e7-dev` build profile; it
does not register Symbian in the production `POCKET_TARGETS` registry.

## What gets installed

`pocket symbian setup --yes` downloads five pinned, SHA-256-verified inputs into
the shared Pocket Stack cache:

- Belle SDK for Qt SDK 1.2.1 (`SymbianSR1Qt474`)
- GCCE 4.6.3 for Linux/i686
- Qt 4.7.4 source, used to build a native Linux `qmake`
- GnuPoc's native EKA2 resource, executable, and SIS tools
- `pocket-stack/quickjs-rs` at revision
  `0fc946fb670c0c29bc0135f510bcb0f595415a61` (QuickJS `2026-06-04`)

Setup also uses `rustup` to install `nightly-2026-07-02` with the `rust-src`
component. That toolchain cross-compiles the no-std PocketJS core static
library for the ARMv6 Symbian EABI.

The build runs in an isolated `linux/amd64` container because the historical
GCCE binaries are 32-bit Intel Linux executables. The SDK and generated signing
identity live in separate named volumes, so a toolchain-version update does not
silently replace the signer. The repository is mounted read-only, only
`dist/symbian` is writable, and USB is never passed into the container. MTP
deployment remains a separate macOS host operation.

The historical SDK inputs are development dependencies and are not
redistributed by this repository. Review and comply with their original terms.

## One-time setup

On macOS, install the host prerequisites:

```sh
brew install libmtp libusb pkgconf
# Install rustup, if it is not already available, then verify:
rustup --version
# Install OrbStack or Docker Desktop, then verify:
docker version
```

Build and inspect the toolchain:

```sh
pocket symbian setup --yes
pocket symbian doctor
```

The setup is idempotent. Re-running it verifies every critical tool hash and
executes a fresh GCCE/E32/SIS/signing smoke build before reusing the pinned
downloads, container image, and toolchain generation.

The default cache is:

```text
${POCKET_STACK_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-stack}/symbian
```

`POCKETJS_SYMBIAN_DOWNLOADS` can point at a pre-populated directory containing
the exact manifest assets.

The development certificate and private key live in
`pocketjs-symbian-signing-v1`. Setup migrates an earlier PocketJS E7 signer but
never silently rotates a valid identity. `doctor` prints its SHA-256
fingerprint. Losing that volume means a replacement certificate cannot upgrade
an installed package with the same UID, so keep an offline, access-controlled
backup:

```sh
docker run --rm --network=none \
  --mount type=volume,src=pocketjs-symbian-signing-v1,dst=/signing,readonly \
  --mount type=bind,src="$PWD",dst=/backup \
  --entrypoint tar pocketjs-symbian-toolchain:sr1-qt474-v1 \
  -czf /backup/pocketjs-symbian-signing-v1.tgz -C /signing .
chmod 600 pocketjs-symbian-signing-v1.tgz
```

Treat that archive as a private signing credential. Docker volume pruning does
not preserve it.

## Build and stage a physical-device probe

Keep the E7 in **Nokia Suite / Ovi mode**, then run:

```sh
pocket symbian doctor --device
pocket symbian build probe
pocket symbian deploy dist/symbian/pocketjs-e7-probe.sis
```

The deploy command:

1. discovers the current top-level `Mass memory/Installs` object ID;
2. uploads the SIS exactly once;
3. reads the new object back by its returned MTP object ID; and
4. compares the local and device SHA-256 values.

It deliberately does not report the app as installed. On the phone, open:

```text
File manager > Mass memory > Installs > pocketjs-e7-probe.sis
```

Accept the self-signed development warning and launch **PocketJS E7 Probe**.
The probe requires `CAPABILITY NONE` and displays a full-screen Qt status page.
If installation policy blocks it, check:

```text
Application manager > Installation settings > Software installation > All
```

Do not disable certificate checks globally unless the specific CFW workflow
requires that choice and its security consequences are understood.

## Build and stage a PocketJS application

The app builder resolves the manifest against the private
`symbian-e7-dev` profile, compiles the PocketJS JavaScript and `.pak`, builds
the Rust core, links the Qt/QuickJS host, and signs one SIS:

```sh
bun tools/symbian.ts build app \
  --manifest apps/hero/pocket.json \
  --sis-version 1.0.0
```

It writes both the installable package and a build receipt:

```text
dist/symbian/pocketjs-e7-runtime.sis
dist/symbian/pocketjs-e7-runtime.receipt.json
```

The receipt records the application output, package UID and version, pinned
QuickJS revision, and SHA-256 hashes for the JavaScript, `.pak`, resolved plan,
and Rust core. Stage the SIS over the same readback-verified USB/MTP path:

```sh
bun tools/symbian.ts doctor --device --coda-usb
bun tools/symbian.ts deploy dist/symbian/pocketjs-e7-runtime.sis
```

Install it from `File manager > Mass memory > Installs`, then launch
**PocketJS E7 Runtime**. Symbian package upgrades must use a version greater
than the version already installed on the phone. After installing `1.0.0`, for
example, pass `--sis-version 1.0.1` for the next build rather than reusing
`1.0.0`.

The experimental host has these runtime semantics:

- PocketJS uses the full native Qt window as its logical viewport: `640x360`
  in landscape and `360x640` in portrait. There is no PSP-shaped `480x272`
  surface, scaling, or black letterbox margin on the E7.
- Qt automatic orientation delivers window resize events. The host resizes the
  Rust core first, then calls the framework's live-viewport hook. Solid and Vue
  Vapor update their app and overlay roots in place, so application state,
  focus ownership, and timers survive rotation rather than being remounted.
- Applications targeting the E7 must declare a compatible dynamic viewport.
  Responsive rows should use wrapping or other flexible layout constraints;
  the Hero example keeps its PSP/Vita fixed viewport and adds a
  `360x360`–`640x640` dynamic variant with a `640x360` default.
- The host calls the JavaScript frame at 30 Hz and advances the PocketJS core
  with two `ui_tick()` calls per frame.
- Arrow keys map to the four directions, the navigation center/Select key and
  keyboard Enter to `CIRCLE`, Escape to `CROSS`, and Space to `START`.

The current public input wire has 9-bit touch coordinates and cannot represent
the E7's 640-pixel axis. The host therefore disables touch snapshots at native
E7 sizes, and `symbian-e7-dev` does not advertise `input.touch`. Applications
must not treat touch as a supported Symbian target contract yet.

For physical acceptance, launch the app in landscape, change some visible
state, then close/open the keyboard or rotate the phone. The UI should fill and
reflow at `360x640`, preserve that state, and return to `640x360` without a
restart, red error screen, stale strip, or black margin.

`PocketJS E7 Runtime` version `1.1.1` passed the manual landscape/portrait
launch and live-relayout check on an RM-626.

## Optional CODA device agent

Qt SDK 1.2.1 shipped `Public-CODA-1.0.6-for-S60v5-Anna-Belle-vFuture.sis`.
For Belle devices it selects CODA 4.0.23. If that original SIS has been
obtained from the historical Qt SDK, it can use the same verified staging path:

```text
SHA-256 db1a0b4208ab90a8c08f62e73aada2f4dbfaa7cea60557bf4fe7d89e0b3cc333
```

```sh
pocket symbian deploy /absolute/path/to/Public-CODA-1.0.6-for-S60v5-Anna-Belle-vFuture.sis
```

Install it manually and open **RnD Tools**. USB is the preferred path on this
macOS workflow: keep the phone in Nokia Suite mode, select USB in CODA, and run:

```sh
pocket symbian coda usb
# Or include it in the complete device check:
pocket symbian doctor --device --coda-usb
```

The host opens only the exact Nokia E7 Suite-mode VID/PID and claims CODA's
control/data interfaces 3 and 4 directly through `libusb`. It sends the
historical CODA serial ping followed by the TCF Locator handshake, without
querying a serial number or IMEI. This avoids relying on the old Nokia USB
driver binding that modern macOS no longer provides. A successful check reports
the agent version, for example `4.0.23:app`.

WLAN remains an alternative. Connect the phone and host to the same network,
select WLAN in CODA, and use the IP and port shown on the phone (the historical
Qt Creator default is `65029`). Belle can tear down an idle WLAN bearer, so USB
is more reliable for a long development session.

CODA's historical Nokia certificate is expired and the package contains
protected capabilities. Its signer is valid from 2011-10-21 through 2016-01-02;
do not re-sign it with the PocketJS development key. If the phone reports
`Certificate expired`, disconnect it from networks, disable automatic time,
temporarily set the date to `2015-06-01`, install the original SIS, and restore
the correct date immediately. A CFW can still block that path according to its
install-server policy.

## PocketJS port boundary

The toolchain now implements the GCCE-compatible Rust core, QuickJS execution
and Promise-job draining, the base HostOps surface, embedded compiled
JavaScript and `.pak` resources, fixed-step presentation, live native-viewport
relayout, and button input. The app build and MTP readback checks make both the
native package and delivery substrate repeatable. A signed SIS is
time-dependent and therefore is not expected to be byte-for-byte reproducible
between builds.

Those implementation milestones do not make Symbian a production PocketJS
target. Installation, launch, visible output, and live landscape/portrait
relayout are confirmed on one RM-626, but that single manual check is not
repeatable golden validation. The CODA USB command verifies the transport and
TCF Locator session, while MTP remains the implemented file-delivery path.
`symbian-e7-dev` stays private until the host passes a full physical-device
acceptance suite and repeatable visible-output/button-input golden tests. Touch
is specifically outside the published contract during that period.

## Device and privacy boundaries

The device doctor uses MTP discovery only. The separate AT investigation used
only read-only model and firmware commands; the toolchain never queries an
IMEI or serial number. Logs redact 14–16 digit identifiers and modem device
paths. The tested device was an RM-626 running firmware `111.040.1514`
(Symbian Belle Refresh), whose ROM Qt 4.8 remains compatible with this Qt 4.7.4
application build.

## Sources

- [Qt SDK 1.2.1 release](https://www.qt.io/blog/2012/04/18/qt-sdk-1-2-1-update-released)
- [Qt 4.7 source archive](https://download.qt.io/archive/qt/4.7/)
- [GnuPoc package](https://github.com/mstorsjo/gnupoc-package)
- [Qt's historical Symbian support notes](https://wiki.qt.io/Support_for_Symbian)
- [Qt Creator 2.4 CODA serial transport](https://code.qt.io/cgit/qt-creator/qt-creator.git/tree/src/shared/symbianutils/codadevice.cpp?h=v2.4.1)
- [Qt Creator 2.4 macOS Symbian device discovery](https://code.qt.io/cgit/qt-creator/qt-creator.git/tree/src/shared/symbianutils/symbiandevicemanager.cpp?h=v2.4.1)
- [libmtp `mtp-sendfile` implementation](https://github.com/libmtp/libmtp/blob/v1.1.23/examples/sendfile.c)
