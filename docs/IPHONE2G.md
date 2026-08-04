# iPhone 2G / iPhone OS 1.1.4 development

This document describes the deliberately narrow path for developing and testing
PocketJS on an original iPhone (`iPhone1,1`) running stock iPhone OS 1.1.4
(`4A102`). It is a preservation-oriented device-lab procedure, not a general
jailbreak, unlock, or restore guide.

The native artifact is `PocketJSDemo.app`: an ARMv6 UIKit host containing the
generated PocketJS JavaScript and asset pack, pinned QuickJS, and the PocketJS
raster core. Building the combined bundle proves that these inputs link
together; it does not prove that the guest code executes on the phone. That
requires the live acceptance at the end of this document.

## Safety and scope

The supported target is exact:

- device: `iPhone1,1` (original iPhone / iPhone 2G);
- installed OS: iPhone OS 1.1.4, build `4A102`;
- CPU and executable format: ARMv6 Mach-O;
- normal-mode USB identity: Apple `05ac:1290`;
- application location: the stock root-volume `/Applications` directory.

This procedure does **not**:

- flash, restore, upgrade, or downgrade iPhone OS;
- unlock or modify the baseband, bootloader, NOR, seczone, or radio state;
- activate, deactivate, or replace Lockdown activation records;
- install Installer.app or a package manager;
- enable AFC2 or replace `System/Library/Lockdown/Services.plist`;
- replace the stock `private/etc/fstab`, stash system directories, or make the
  root filesystem permanently writable;
- run ZiPhone or Legacy-iOS-Kit's automated install/dump actions.

That list is about what this procedure *intends*. One step in it turns out to
carry a one-way cost that the list does not cover: booting the temporary SSH
ramdisk upgrades the NAND format epoch and permanently prevents 1.1.4 from
booting. It flashes no OS and no baseband, and the phone is still unbootable
afterwards. Read
[NAND epoch: a one-way hazard](#nand-epoch-a-one-way-hazard-measured-on-this-device)
before the device-side procedure, and decide there whether a stock 1.1.4 install
is something you are willing to spend.

The stock filesystem policy remains:

```text
/dev/disk0s1 /            hfs ro                    0 1
/dev/disk0s2 /private/var hfs rw,noexec,nodev       0 2
```

Executable application bundles therefore stay in `/Applications`. The data
partition remains `noexec`. Root is remounted read/write only for a bounded
manual install or deployment, then returned to read-only or rebooted.

There is intentionally no repository command that enters DFU, boots a ramdisk,
backs up a phone, mounts its installed filesystems from the ramdisk, installs
SSH, or changes boot/radio state. Those preservation-sensitive steps remain
operator-reviewed in this runbook. After that one-time bootstrap,
`bun iphone2g deploy` and `bun iphone2g device-status` use the dedicated
USB-only SSH path described below.

## Repository commands and cache

`package.json` exposes `bun iphone2g`, which currently dispatches to
`tools/iphone2g.ts`. The supported end-to-end local workflow is:

| Command | Effect | Device access |
| --- | --- | --- |
| `bun iphone2g doctor` | Checks local Xcode tools and pinned cached artifacts. This is the default command. | None |
| `bun iphone2g setup-sources` | Clones and verifies Apple `Csu-76`, QuickJS, and Legacy-iOS-Kit checkouts if absent. | None |
| `bun iphone2g prepare-bootstrap` | Verifies two cached historical packages, builds the 1.1.4 device helper, generates keys/configuration, and stages an eight-file SSH bootstrap. | None |
| `bun iphone2g build` | Builds the guest bundle, QuickJS/PocketJS runtime, and combined `dist/iphone2g/PocketJSDemo.app`. It may run `setup-sources`. | None |
| `bun iphone2g deploy` | Builds, atomically installs, byte-for-byte reads back, and asks SpringBoard to rescan the demo through the USB SSH tunnel. | USB SSH |
| `bun iphone2g device-status` | Reads the device-local runtime acceptance record after the app has launched. | USB SSH |

`setup-csu`, `build-demo`, and `build-runtime` remain lower-level entry points.
`build-probe` is a compatibility alias for the full guest-plus-runtime build;
despite its historical name, its output is `PocketJSDemo.app`.

By default, proprietary and device-specific material lives outside the
repository at:

```text
~/.cache/pocket-stack/iphone2g
```

The supported overrides are:

```sh
export POCKETJS_IPHONE2G_ROOT=/absolute/cache/root
export POCKETJS_IPHONE2G_SYSROOT=/absolute/path/to/read-only-derived-sysroot
export POCKETJS_IPHONE2G_CSU=/absolute/path/to/Csu-76
export POCKETJS_IPHONE2G_QUICKJS=/absolute/path/to/pinned-quickjs-rs
export POCKETJS_IPHONE2G_IDENTITY=/absolute/path/to/dedicated-client-key
```

Do not commit firmware, decrypted system files, ramdisks, pairing or activation
records, SSH keys, or historical binary packages. The canonical versions,
URLs, revisions, and hashes are in
[`tools/cli/iphone2g-toolchain.json`](../tools/cli/iphone2g-toolchain.json).

### Local artifact preparation

`doctor` verifies bytes that already exist; it does not download firmware,
decrypt the root image, or extract a sysroot. Supply these cache artifacts by a
separately audited local process:

```text
downloads/iPhone1,1_1.1.4_4A102_Restore.ipsw
sysroot-1.1.4/iPhoneOS-1.1.4-rootfs.raw
sysroot-1.1.4/rootfs/usr/lib/libSystem.B.dylib
sysroot-1.1.4/rootfs/usr/lib/libgcc_s.1.dylib
sysroot-1.1.4/rootfs/usr/lib/libgcc_s_v6.1.dylib
sysroot-1.1.4/rootfs/usr/lib/libobjc.A.dylib
sysroot-1.1.4/rootfs/System/Library/Frameworks/UIKit.framework/UIKit
sysroot-1.1.4/rootfs/System/Library/Frameworks/Foundation.framework/Foundation
sysroot-1.1.4/rootfs/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics
sysroot-1.1.4/rootfs/System/Library/Frameworks/GraphicsServices.framework/GraphicsServices
downloads/bootstrap/openssh_4.7p1-1_iphoneos-arm.deb
downloads/bootstrap/openssl_0.9.8g-1_iphoneos-arm.deb
sources/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6/
  saved/iPhone1,1/ramdisk_7E18/saved/{iBSS,Ramdisk.dmg,DeviceTree.dec,Kernelcache.dec}
```

The pinned 1.1.4 IPSW SHA-256 is:

```text
25fa72bc07e1879646a690e49090ff376904128cfa333b606a19337d4d02b586
```

The decrypted raw root image SHA-256 expected by `doctor` is:

```text
14fbd2206049e6d48a17791a92c1ddda0ff82a71638f0b9bfdb4107dcc576b90
```

The sysroot check hashes every framework and library that the host or device
helper links. Its provenance remains the pinned raw image rather than files
copied from a modified phone; the build receipt records both that raw-image hash
and the exact linked-file hashes.

Install the pinned Rust toolchain used to build the freestanding PocketJS raster
core, then fetch the public Apple Csu and pinned QuickJS sources:

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal --component rust-src
bun iphone2g setup-sources
```

The source setup verifies Csu tag `Csu-76`, revision
`a02bd5830f6fbe841d5b0bd54b90ee5f35b99a4e`, and the exact `start.s` and
`dyld_glue.s` bytes. It checks out QuickJS-rs revision
`ba5bdd0dc013518768e76cd9e05cd30ed53dd35b` and requires embedded QuickJS
version `2026-06-04`. `doctor` also checks that the pinned Rust compiler is
available; the actual build is the stronger check that its `rust-src`
component is present.

Place the two historical bootstrap packages in
`$POCKETJS_IPHONE2G_ROOT/downloads/bootstrap` (or the default cache equivalent)
and verify them before staging:

```text
openssh_4.7p1-1_iphoneos-arm.deb
SHA256 77f4f02594a0bdcaa54a7e3d9719e4cdab510582f0565c5129d64a87f1e18bda

openssl_0.9.8g-1_iphoneos-arm.deb
SHA256 13819c6d8ba21d85296f85994f21b92f9d22dfb51bdfbba02d08d0c1edc1ec12
```

Then run the read-only local checks:

```sh
bun iphone2g doctor
```

Every required line must report `[ok]`. `ldid` is optional and is not used for
the unsigned 1.1.4 app.

## Build

Build the generated guest and native runtime as one workflow:

```sh
bun iphone2g build
```

For diagnosis, the two lower-level stages are:

```sh
bun iphone2g build-demo
bun iphone2g build-runtime
```

Outputs:

```text
dist/iphone2g/guest/
dist/iphone2g/PocketJSDemo.app/
```

The native build uses current Xcode Clang for ARMv6 object generation and invokes
`ld-classic` directly against the byte-pinned 1.1.4 sysroot and Apple `Csu-76`.
It compiles pinned QuickJS, builds the PocketJS raster core with the pinned Rust
nightly, and embeds the generated JavaScript and `.pak` as Mach-O sections. The
Rust target directory is retained under the external iPhone 2G cache, so the
first standard-library build can take several minutes while later demo builds
reuse it. Removing `~/.cache/pocket-stack/iphone2g/build/rust-target` forces a
clean Rust rebuild. The
host stays in C and registers its small UIKit view/delegate classes through the
Objective-C runtime because the current classic linker cannot safely translate
old ObjC1 class-reference relocations emitted by an `@implementation`.

The runtime build checks that the result is an ARMv6 Mach-O executable and that
its load commands include UIKit, Foundation, CoreGraphics, GraphicsServices,
libobjc, libSystem, and `libgcc_s_v6.1`. It writes `build-receipt.json` with the
toolchain, sysroot, Csu, QuickJS, Rust, guest JavaScript, guest pack, core
library, and executable identities plus `unsigned: true`.
It also assigns the per-build identifier later used to bind deployment,
rollback, and runtime-status evidence to these exact bundle bytes.

Useful independent inspection is:

```sh
file dist/iphone2g/PocketJSDemo.app/PocketJSDemo
xcrun otool-classic -L dist/iphone2g/PocketJSDemo.app/PocketJSDemo
plutil -lint dist/iphone2g/PocketJSDemo.app/Info.plist
shasum -a 256 dist/iphone2g/PocketJSDemo.app/PocketJSDemo
```

A successful build proves only the host compiler/linker/package layer. It says
nothing about USB deployment, SpringBoard discovery, process launch, drawing,
or touch on the phone.

## Boot a temporary SSH ramdisk

### NAND epoch: a one-way hazard, measured on this device

**Booting the `ramdisk_7E18` SSH ramdisk on a 1.1.4 phone permanently stops
1.1.4 from booting.** This was established on hardware, not predicted. Read this
before running any step in this section.

The Legacy-iOS-Kit SSH ramdisk for `iPhone1,1` is built from iPhone OS **3.1.3**
(`7E18`). Its WMR/FTL driver rewrites the NAND format signature — the "epoch" —
from the `C003` that 1.1.4 requires up to `C005`, as a side effect of opening
the flash translation layer. The upgrade is one-way and happens before anything
is mounted. From that point the native 1.1.4 bootloader reports:

```text
no signature or no production format
root filesystem mount failed
```

and the phone returns to Recovery on every boot attempt.

Three consequences are easy to get wrong, so state them plainly:

- **The file data is not the problem, and restoring it does not help.** On this
  device the full 8,120,172,544-byte disk image was written back and re-read;
  the MBR, every allocated `disk0s1` block and every allocated `disk0s2` block
  matched the backup by SHA-256, and the era-matched `fsck_hfs -q` reported both
  volumes `FILESYSTEM CLEAN`. 1.1.4 iBoot still refused to boot, because the
  rejection happens *below* the partition table.
- **The step is not read-only, despite touching neither OS nor baseband.** The
  paragraph below is accurate that the ramdisk does not flash the installed OS
  or the baseband. It changes NAND metadata anyway, and that is enough to make
  the installed OS unbootable.
- **It cannot be undone in place by hand.** Rewriting `C005` back to `C003`
  needs a 1.1.4-era kernel driving the NAND FTL epoch selector. Attempting that
  with a hand-built kernel and helper wedged the device (see the recovery
  section below).

The only reliable repair is a **full restore that reformats the NAND**, which
rewrites the epoch as a normal part of its work. Note the asymmetry this
creates, because it decides the whole plan:

| Target | Restorable on `iPhone1,1` today |
| --- | --- |
| 3.1.3 (`7E18`) | Yes — Legacy-iOS-Kit ships a prebuilt jailbroken custom IPSW; no SHSH needed on S5L8900. |
| 2.0 – 3.1.2 | Yes — Kit menu `Other (Custom IPSW)`. |
| 1.x, including 1.1.4 | **No.** `restore.sh` states outright that `1.x will not work`. |

So a 1.1.4 phone that has had the 7E18 ramdisk booted on it cannot simply be put
back. Treat the stock 1.1.4 install as the irreplaceable artifact it is: if the
goal only needs a device to develop against, restore to 3.1.3 and retarget,
rather than spending the one-way step to keep a 1.1.4 that will not boot again.

### If a custom boot chain wedges the phone

A hung custom kernel shows a **plain white screen** — the framebuffer is
initialised, nothing is drawn — with no USB enumeration at all.

**The button combination will not rescue it.** The original iPhone implements
Home + top-button force-restart in iBoot/kernel software; S5L8900 has no
PMU-level hardware reset combination. When the kernel is wedged with interrupts
off, no amount of holding reaches anything. Holding for 30 seconds is not a
longer version of the same idea; it is the same nothing.

Recover by power depletion:

1. Disconnect **all** power, Mac and wall charger alike. On power, a white-screen
   hang persists indefinitely.
2. Wait for the screen to go dark by itself — roughly 3–5 hours with the
   backlight lit.
3. Leave it a further 10 minutes, then connect it to the Mac and press nothing.

The S5L8900 bootrom is mask ROM and cannot be damaged, so the device recovers to
Recovery or DFU once the SoC actually loses power. The phone is not bricked; it
is only unreachable. Expect to charge it before restoring, and note that a
deep discharge is hard on an 18-year-old cell.

### Prerequisites

Use [Legacy-iOS-Kit](https://github.com/LukeZGD/Legacy-iOS-Kit) only to boot the
temporary ramdisk. The checkout and four boot artifacts are prerequisites, not
material to fetch or build after the phone has entered DFU. Prepare them in the
external cache first:

```text
sources/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6/
saved/iPhone1,1/ramdisk_7E18/saved/iBSS
saved/iPhone1,1/ramdisk_7E18/saved/Ramdisk.dmg
saved/iPhone1,1/ramdisk_7E18/saved/DeviceTree.dec
saved/iPhone1,1/ramdisk_7E18/saved/Kernelcache.dec
```

`bun iphone2g setup-sources` creates the detached checkout. Supply the saved
ramdisk artifacts through the separately audited local preparation path, then
run:

```sh
bun iphone2g setup-sources
bun iphone2g doctor
```

Do not start the device-side procedure unless `doctor` reports both `pinned
Legacy-iOS-Kit` and `verified SSH ramdisk` as `[ok]`. This proves the checkout
is at clean revision `1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6` and each boot
artifact matches the manifest. Then, from that exact checkout on Apple Silicon,
start the already verified ramdisk:

```sh
IPHONE2G_KIT=/absolute/cache/path/to/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6
cd "$IPHONE2G_KIT"
./restore.sh --sshrd --no-finder
```

Do not select the Kit actions named `Get iOS Version`, `Dump
Baseband/Activation`, or `Install OpenSSH`, and do not run its `mount.sh`.
Those paths have broader filesystem behavior than this procedure. This runbook
never reads or changes the baseband and never replaces activation records, AFC
services, or `fstab`.

For the S5L8900 device, follow the on-screen prompt precisely:

1. Starting from Recovery, hold the top and Home buttons together for 8
   seconds.
2. Release the top button and continue holding Home for 13 seconds.
3. The device first presents WTF mode (`0x1222`); the Kit sends patched Apple WTF
   and transitions it to true DFU (`0x1227`).
4. If detection fails, force-restart and retry. Do not choose Restore.

A direct, simple USB cable/dongle is preferable to an unreliable hub. The
ramdisk sets `auto-boot=1` in NVRAM and starts temporary services, so even this
step is not literally zero-write. It does not flash the installed OS or
baseband — but it does raise the NAND epoch, which is the one-way cost described
at the top of this section. Do not read "does not flash the OS" as "the OS still
boots afterwards"; on this device it did not.

Keep the Kit menu open while using a second terminal. The Kit maintains an SSH
forward on `127.0.0.1:6414`; the ramdisk account is the historical
`root`/`alpine` pair:

```sh
IPHONE2G_KIT=/absolute/cache/path/to/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6

sshrd() {
  [ "$#" -eq 1 ] || return 64
  "$IPHONE2G_KIT/bin/macos/arm64/sshpass" -palpine \
    /usr/bin/ssh -F "$IPHONE2G_KIT/resources/ssh_config" \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa \
    -p 6414 root@127.0.0.1 "$1"
}

sshrd_script() {
  "$IPHONE2G_KIT/bin/macos/arm64/sshpass" -palpine \
    /usr/bin/ssh -F "$IPHONE2G_KIT/resources/ssh_config" \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa \
    -p 6414 root@127.0.0.1 /bin/bash -s
}
```

The `alpine` password applies only to the temporary ramdisk. The persistent
bootstrap below is key-only and does not alter the phone's root password.
Every multi-step remote block below starts with `set -e`; an error must stop the
write path. Never paste a semicolon-separated write sequence without this
fail-closed behavior.

## Back up before the first write

### Whole filesystem disk image

First prove that only the temporary memory disk is mounted, and inspect the
whole-disk partition table without repairing or changing it:

```sh
sshrd_script <<'RAMDISK'
set -e
/sbin/mount
/bin/ls -l /dev/disk* /dev/rdisk*
/usr/sbin/fdisk -d /dev/rdisk0
RAMDISK
```

Stop if `/dev/disk0s1` or `/dev/disk0s2` is mounted at all at this point. Do not
run `fsck`, `fsck_hfs`, a restore, or any other convenience repair. The known
device geometry is 1,982,464 blocks of 4,096 bytes: exactly
**8,120,172,544 bytes**. The `fdisk -d` record must show the two HFS partitions
at start/size `63/76800` and `76923/1905498`; stop if it does not.

The backup belongs in the external iPhone 2G cache, never in the repository.
Use a new absolute path with restrictive permissions and make the geometry
checks part of the recorded evidence:

```sh
set -euo pipefail
umask 077

IPHONE2G_CACHE=/absolute/cache/path/printed/by/doctor
BACKUP_DIR="$IPHONE2G_CACHE/backups/pre-jailbreak-$(date +%Y%m%d-%H%M%S)"
EXPECTED_DISK_BYTES=8120172544

case "$BACKUP_DIR" in
  "$PWD"|"$PWD"/*)
    printf '%s\n' 'refusing to place the device backup in the repository' >&2
    false
    ;;
esac

mkdir -p "$BACKUP_DIR/metadata" "$BACKUP_DIR/raw" "$BACKUP_DIR/config"
chmod 0700 "$BACKUP_DIR" "$BACKUP_DIR/metadata" "$BACKUP_DIR/raw" "$BACKUP_DIR/config"

sshrd '/usr/sbin/fdisk -d /dev/rdisk0' >"$BACKUP_DIR/metadata/fdisk-dump.txt"
LAST_BLOCK_BYTES=$(sshrd '/bin/dd if=/dev/rdisk0 bs=4096 skip=1982463 count=1 2>/dev/null' | wc -c | tr -d ' ')
PAST_END_BYTES=$(sshrd '/bin/dd if=/dev/rdisk0 bs=4096 skip=1982464 count=1 2>/dev/null' | wc -c | tr -d ' ')
[ "$LAST_BLOCK_BYTES" -eq 4096 ]
[ "$PAST_END_BYTES" -eq 0 ]
printf 'block_size=4096\nblock_count=1982464\nbyte_size=%s\n' \
  "$EXPECTED_DISK_BYTES" >"$BACKUP_DIR/metadata/disk-geometry.txt"

sshrd '/bin/dd if=/dev/rdisk0 bs=1048576' \
  2>"$BACKUP_DIR/metadata/rdisk0.dd.stderr" |
  /usr/bin/tee "$BACKUP_DIR/raw/rdisk0.img" |
  /usr/bin/shasum -a 256 >"$BACKUP_DIR/metadata/rdisk0.stream.sha256"

/usr/bin/shasum -a 256 "$BACKUP_DIR/raw/rdisk0.img" \
  >"$BACKUP_DIR/metadata/rdisk0.file.sha256"
/usr/bin/stat -f '%z' "$BACKUP_DIR/raw/rdisk0.img" \
  >"$BACKUP_DIR/metadata/rdisk0.size"

[ "$(/usr/bin/stat -f '%z' "$BACKUP_DIR/raw/rdisk0.img")" -eq "$EXPECTED_DISK_BYTES" ]
STREAM_SHA=$(awk '{print $1}' "$BACKUP_DIR/metadata/rdisk0.stream.sha256")
FILE_SHA=$(awk '{print $1}' "$BACKUP_DIR/metadata/rdisk0.file.sha256")
[ "$STREAM_SHA" = "$FILE_SHA" ]
chmod 0600 "$BACKUP_DIR/raw/rdisk0.img" "$BACKUP_DIR/metadata/"*
```

`set -o pipefail` is essential: a failed remote `dd` must not be hidden by a
successful `tee` or `shasum`. Require the command block to exit zero, the exact
size above, equal stream/file SHA-256 values, `7744+0` complete MiB records in
the saved `dd` stderr, `0700` directories, and `0600` files. A second complete
read with the same size and hash is stronger evidence when preservation risk
justifies the time.

`/dev/rdisk0` is the complete installed filesystem disk, but it does **not**
capture baseband NOR/seczone. Do not describe it as a baseband/unlock backup and
do not perform radio changes on the strength of this image.

### Read-only configuration and activation backup

Only after the whole-disk backup passes every check, mount both installed
volumes explicitly read-only:

```sh
sshrd_script <<'RAMDISK'
set -e
/bin/mkdir -p /mnt1 /mnt2
/sbin/mount_hfs -o rdonly /dev/disk0s1 /mnt1
/sbin/mount_hfs -o rdonly /dev/disk0s2 /mnt2
/sbin/mount
RAMDISK
```

Read the printed mount table and stop unless both mounts are visibly read-only.
Then archive the stock policy, Lockdown service map, and activation material:

```sh
sshrd '/bin/tar -cpf - -C /mnt1 private/etc/fstab System/Library/Lockdown/Services.plist' \
  >"$BACKUP_DIR/config/prebootstrap-root-config.tar"

sshrd '/bin/tar -cpf - -C /mnt2 root/Library/Lockdown' \
  >"$BACKUP_DIR/config/activation-lockdown.tar"

/usr/bin/tar -tf "$BACKUP_DIR/config/prebootstrap-root-config.tar"
/usr/bin/tar -tf "$BACKUP_DIR/config/activation-lockdown.tar"
chmod 0600 "$BACKUP_DIR/config/"*.tar
```

These are read-only preservation copies; do not edit or restore activation,
Lockdown services, AFC configuration, or `fstab` during this workflow. This
ramdisk has no `umount` binary. Leave `/mnt1` and `/mnt2` mounted read-only;
installation updates those existing mounts temporarily and must return them to
read-only before reboot.

Before installation, enumerate every bootstrap target below while the mounts
are still read-only. If any target exists, stop and make a path-specific
read-only archive of it. Never silently overlay an earlier SSH installation.

## Prepare the minimal key-only SSH bootstrap

Run locally, with no device required:

```sh
bun iphone2g prepare-bootstrap
```

This command verifies the two package hashes, extracts only three historical
files, builds `/usr/libexec/pocketjs-device` against the verified 1.1.4
sysroot, generates/reuses matching 2048-bit RSA host/client keypairs, writes a
key-only policy, and emits a receipt. The default outputs are:

```text
~/.cache/pocket-stack/iphone2g/bootstrap/stage/
~/.cache/pocket-stack/iphone2g/bootstrap/ssh_config
~/.cache/pocket-stack/iphone2g/bootstrap/known_hosts
~/.cache/pocket-stack/iphone2g/bootstrap/keys/ssh_host_rsa_key
~/.ssh/iphone2g_pocketjs
```

The stage contains exactly eight device files, not eight historical package
files:

| Volume | Device path | Source | Mode | Verification |
| --- | --- | --- | --- | --- |
| root | `/usr/sbin/sshd` | OpenSSH package | `0755` | `eeed899b324e3b41bf1d3e344c0d04cd66b80c28d083eeb0a8cb4b46dfc9ee65` |
| root | `/usr/libexec/pocketjs-device` | Built from `hosts/iphone2g/device_tool.c` | `0755` | Recorded in receipt |
| root | `/usr/lib/libcrypto.0.9.8.dylib` | OpenSSL package | `0555` | `931efb9afc2d24f635a76ae82878e3c09eb5aa03860370fc380c3de2b8fdf2ee` |
| root | `/private/etc/ssh/moduli` | OpenSSH package | `0644` | `51faf2d997593725ff18ac57c2ca6ce91400673106f71fce5d995d29b633b180` |
| root | `/private/etc/ssh/sshd_config` | Generated policy | `0644` | Recorded in receipt |
| root | `/private/etc/ssh/ssh_host_rsa_key` | Generated host key | `0600` | Recorded in receipt |
| root | `/Library/LaunchDaemons/com.openssh.sshd.plist` | Generated launch policy | `0644` | Recorded in receipt |
| data | `/private/var/root/.ssh/authorized_keys_pocketjs` | Dedicated client public key | `0600` | Recorded in receipt |

`/private/var/root/.ssh` itself is a directory, mode `0700`, and is not counted
as a ninth file. All installed files and this directory must be owned by
`root:wheel` (`0:0`). The generated `bootstrap-receipt.json` is host-side audit
metadata and is not installed.

The policy has `PasswordAuthentication no`, `ChallengeResponseAuthentication
no`, `PermitEmptyPasswords no`, and a dedicated
`AuthorizedKeysFile .ssh/authorized_keys_pocketjs`. It deliberately leaves the
historical root password untouched. It records `afc2: false`,
`fstabMutation: false`, and `basebandMutation: false` in the receipt. The
generated client config uses a dedicated `known_hosts` file with strict host-key
checking; it does not modify the global SSH configuration.

The LaunchDaemon executes `/usr/sbin/sshd -i` directly and binds its listener to
the phone's `127.0.0.1` only. Normal access therefore requires the local usbmux
forward; port 22 is not exposed on Wi-Fi. The historical package's
`sshd-keygen-wrapper` and `ssh-keygen` are omitted because the RSA host key is
pre-generated. The historical file-transfer subsystem is also deliberately
omitted because its binary imports an API absent from the 1.1.4 runtime.
Deployment uses the small, path-scoped `pocketjs-device` protocol instead of a
general shell utility set, SCP, or AFC2.

## Install the SSH bootstrap manually

No `bun iphone2g install` command exists. The following is an operator-reviewed
ramdisk procedure. Perform it only after the raw and read-only backups above
exist and have been verified.

Keep the existing `/mnt1` and `/mnt2` read-only mounts. First fail closed if any
of the eight target files or either newly owned directory already exists;
archive an existing target before proceeding rather than replacing it. Before
the first read/write update, explicitly update both mounts to read-only again
and machine-check their mount-table lines:

```sh
sshrd_script <<'RAMDISK'
set -e

mount_is_read_only() {
  target="$1"
  while IFS= read -r line; do
    case "$line" in
      *" on $target "*"read-only"*) return 0 ;;
    esac
  done < <(/sbin/mount)
  return 1
}

found=0
for path in \
  /mnt1/private/etc/ssh \
  /mnt1/usr/sbin/sshd \
  /mnt1/usr/libexec/pocketjs-device \
  /mnt1/usr/lib/libcrypto.0.9.8.dylib \
  /mnt1/private/etc/ssh/moduli \
  /mnt1/private/etc/ssh/sshd_config \
  /mnt1/private/etc/ssh/ssh_host_rsa_key \
  /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist \
  /mnt2/root/.ssh \
  /mnt2/root/.ssh/authorized_keys_pocketjs
do
  if [ -e "$path" ]; then
    /bin/ls -ldn "$path"
    found=1
  fi
done
[ "$found" -eq 0 ]
/sbin/mount -ur /mnt1
/sbin/mount -ur /mnt2
mount_is_read_only /mnt1
mount_is_read_only /mnt2
/sbin/mount
RAMDISK
```

Stop unless both printed mount entries remain read-only and the root volume has
at least 8 MiB free. Never invoke `mount_hfs` a second time on an already mounted
volume and never invoke `fsck_hfs`.

Create both local archives before sending either one. Disable macOS copyfile and
extended-attribute records, force the `ustar` format, require exactly seven root
entries plus one data entry, and compare every archived byte with the verified
stage:

```sh
# Use the exact cache path printed by `bun iphone2g doctor`; this also respects
# POCKET_STACK_CACHE_DIR and all supported overrides.
IPHONE2G_CACHE=/absolute/path/printed/by/doctor
BOOTSTRAP_STAGE="$IPHONE2G_CACHE/bootstrap/stage"
set -euo pipefail
umask 077

ROOT_ARCHIVE="$BACKUP_DIR/bootstrap-root.ustar"
DATA_ARCHIVE="$BACKUP_DIR/bootstrap-data.ustar"
ROOT_EXPECTED="$BACKUP_DIR/bootstrap-root.expected"
DATA_EXPECTED="$BACKUP_DIR/bootstrap-data.expected"
ROOT_ACTUAL="$BACKUP_DIR/bootstrap-root.actual"
DATA_ACTUAL="$BACKUP_DIR/bootstrap-data.actual"

for path in \
  "$ROOT_ARCHIVE" "$DATA_ARCHIVE" \
  "$ROOT_EXPECTED" "$DATA_EXPECTED" \
  "$ROOT_ACTUAL" "$DATA_ACTUAL"
do
  if [ -e "$path" ]; then
    printf 'refusing to overwrite %s\n' "$path" >&2
    exit 1
  fi
done

COPYFILE_DISABLE=1 /usr/bin/tar \
  --format ustar --no-xattrs --uid 0 --gid 0 \
  -C "$BOOTSTRAP_STAGE/root" -cpf "$ROOT_ARCHIVE" \
  usr/sbin/sshd \
  usr/libexec/pocketjs-device \
  usr/lib/libcrypto.0.9.8.dylib \
  private/etc/ssh/moduli \
  private/etc/ssh/sshd_config \
  private/etc/ssh/ssh_host_rsa_key \
  Library/LaunchDaemons/com.openssh.sshd.plist

COPYFILE_DISABLE=1 /usr/bin/tar \
  --format ustar --no-xattrs --uid 0 --gid 0 \
  -C "$BOOTSTRAP_STAGE/data" -cpf "$DATA_ARCHIVE" \
  root/.ssh/authorized_keys_pocketjs

printf '%s\n' \
  usr/sbin/sshd \
  usr/libexec/pocketjs-device \
  usr/lib/libcrypto.0.9.8.dylib \
  private/etc/ssh/moduli \
  private/etc/ssh/sshd_config \
  private/etc/ssh/ssh_host_rsa_key \
  Library/LaunchDaemons/com.openssh.sshd.plist \
  >"$ROOT_EXPECTED"
printf '%s\n' root/.ssh/authorized_keys_pocketjs >"$DATA_EXPECTED"

COPYFILE_DISABLE=1 /usr/bin/tar -tf "$ROOT_ARCHIVE" >"$ROOT_ACTUAL"
COPYFILE_DISABLE=1 /usr/bin/tar -tf "$DATA_ARCHIVE" >"$DATA_ACTUAL"
if ! /usr/bin/cmp -s "$ROOT_EXPECTED" "$ROOT_ACTUAL"; then
  printf '%s\n' 'root archive does not contain exactly seven expected entries' >&2
  exit 1
fi
if ! /usr/bin/cmp -s "$DATA_EXPECTED" "$DATA_ACTUAL"; then
  printf '%s\n' 'data archive does not contain exactly one expected entry' >&2
  exit 1
fi

verify_archive_bytes() {
  archive="$1"
  source_root="$2"
  shift 2
  for entry in "$@"; do
    if ! COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -xOf "$archive" "$entry" |
      /usr/bin/cmp -s - "$source_root/$entry"
    then
      printf 'archive byte mismatch: %s\n' "$entry" >&2
      exit 1
    fi
  done
}

verify_archive_bytes "$ROOT_ARCHIVE" "$BOOTSTRAP_STAGE/root" \
  usr/sbin/sshd \
  usr/libexec/pocketjs-device \
  usr/lib/libcrypto.0.9.8.dylib \
  private/etc/ssh/moduli \
  private/etc/ssh/sshd_config \
  private/etc/ssh/ssh_host_rsa_key \
  Library/LaunchDaemons/com.openssh.sshd.plist
verify_archive_bytes "$DATA_ARCHIVE" "$BOOTSTRAP_STAGE/data" \
  root/.ssh/authorized_keys_pocketjs
chmod 0600 \
  "$ROOT_ARCHIVE" "$DATA_ARCHIVE" \
  "$ROOT_EXPECTED" "$DATA_EXPECTED" \
  "$ROOT_ACTUAL" "$DATA_ACTUAL"
```

Install one volume at a time through a volatile ramdisk script. Its cleanup
ignores subsequent signals, returns the target to read-only, and machine-checks
the exact target mount line before it can report success. It uses plain `mkdir`
for the two paths proven absent above; an unexpected pre-existing directory is
therefore a hard failure:

```sh

sshrd '/bin/dd of=/var/root/pocketjs-install-volume.sh' <<'RAMDISK'
#!/bin/bash
set -e

mount_is_read_only() {
  target="$1"
  while IFS= read -r line; do
    case "$line" in
      *" on $target "*"read-only"*) return 0 ;;
    esac
  done < <(/sbin/mount)
  return 1
}

case "$1" in
  root) mountpoint=/mnt1 ;;
  data) mountpoint=/mnt2 ;;
  *) exit 64 ;;
esac

cleanup() {
  result=$?
  trap '' HUP INT PIPE TERM
  trap - EXIT
  if ! /sbin/mount -ur "$mountpoint"; then
    result=90
  fi
  if ! mount_is_read_only "$mountpoint"; then
    result=91
  fi
  if ! /sbin/mount; then
    result=92
  fi
  exit "$result"
}
trap 'exit 93' HUP INT PIPE TERM
trap cleanup EXIT

mount_is_read_only "$mountpoint"
/sbin/mount -uw "$mountpoint"
if [ "$1" = root ]; then
  /bin/mkdir /mnt1/private/etc/ssh
  /bin/chown 0:0 /mnt1/private/etc/ssh
  /bin/chmod 0755 /mnt1/private/etc/ssh
else
  /bin/mkdir /mnt2/root/.ssh
  /bin/chown 0:0 /mnt2/root/.ssh
  /bin/chmod 0700 /mnt2/root/.ssh
fi
/bin/tar -xpf - -C "$mountpoint"

if [ "$1" = root ]; then
  /bin/chown 0:0 \
    /mnt1/usr/sbin/sshd \
    /mnt1/usr/libexec/pocketjs-device \
    /mnt1/usr/lib/libcrypto.0.9.8.dylib \
    /mnt1/private/etc/ssh/moduli \
    /mnt1/private/etc/ssh/sshd_config \
    /mnt1/private/etc/ssh/ssh_host_rsa_key \
    /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist
  /bin/chmod 0755 /mnt1/usr/sbin/sshd /mnt1/usr/libexec/pocketjs-device
  /bin/chmod 0555 /mnt1/usr/lib/libcrypto.0.9.8.dylib
  /bin/chmod 0644 \
    /mnt1/private/etc/ssh/moduli \
    /mnt1/private/etc/ssh/sshd_config \
    /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist
  /bin/chmod 0600 /mnt1/private/etc/ssh/ssh_host_rsa_key
else
  /bin/chown 0:0 /mnt2/root/.ssh /mnt2/root/.ssh/authorized_keys_pocketjs
  /bin/chmod 0700 /mnt2/root/.ssh
  /bin/chmod 0600 /mnt2/root/.ssh/authorized_keys_pocketjs
fi
RAMDISK

sshrd '/bin/chmod 0700 /var/root/pocketjs-install-volume.sh'

if ! sshrd '/var/root/pocketjs-install-volume.sh root' <"$ROOT_ARCHIVE"; then
  printf '%s\n' 'root bootstrap install failed or root was not proven read-only' >&2
  exit 1
fi

# The root installer can return success only after its read-only machine check.
# Do not start the data-volume update before that success.
if ! sshrd '/var/root/pocketjs-install-volume.sh data' <"$DATA_ARCHIVE"; then
  printf '%s\n' 'data bootstrap install failed or data was not proven read-only' >&2
  exit 1
fi
```

Both installer invocations must exit zero, and each printed mount table must
show its target read-only. With both volumes read-only, archive and compare all
eight installed files byte-for-byte against the verified stage. If either
installer fails, do not blindly rerun it over the partial bootstrap; first prove
both mounts read-only and reconcile only the eight listed paths against the
receipt and pre-install inventory.

```sh
set -euo pipefail
umask 077

READBACK="$BACKUP_DIR/bootstrap-readback"
if [ -e "$READBACK" ]; then
  printf 'refusing to reuse readback directory: %s\n' "$READBACK" >&2
  exit 1
fi
mkdir "$READBACK"
mkdir "$READBACK/root"
mkdir "$READBACK/data"
chmod 0700 "$READBACK" "$READBACK/root" "$READBACK/data"

if ! sshrd '/bin/tar -cpf - -C /mnt1 usr/sbin/sshd usr/libexec/pocketjs-device usr/lib/libcrypto.0.9.8.dylib private/etc/ssh/moduli private/etc/ssh/sshd_config private/etc/ssh/ssh_host_rsa_key Library/LaunchDaemons/com.openssh.sshd.plist' |
  COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -xpf - -C "$READBACK/root"
then
  printf '%s\n' 'root readback pipeline failed' >&2
  exit 1
fi
if ! sshrd '/bin/tar -cpf - -C /mnt2 root/.ssh/authorized_keys_pocketjs' |
  COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -xpf - -C "$READBACK/data"
then
  printf '%s\n' 'data readback pipeline failed' >&2
  exit 1
fi

for relative in \
  root/usr/sbin/sshd \
  root/usr/libexec/pocketjs-device \
  root/usr/lib/libcrypto.0.9.8.dylib \
  root/private/etc/ssh/moduli \
  root/private/etc/ssh/sshd_config \
  root/private/etc/ssh/ssh_host_rsa_key \
  root/Library/LaunchDaemons/com.openssh.sshd.plist \
  data/root/.ssh/authorized_keys_pocketjs
do
  if ! /usr/bin/cmp -s "$BOOTSTRAP_STAGE/$relative" "$READBACK/$relative"; then
    printf 'installed byte mismatch: %s\n' "$relative" >&2
    exit 1
  fi
done

sshrd_script <<'RAMDISK'
set -e

mount_is_read_only() {
  target="$1"
  while IFS= read -r line; do
    case "$line" in
      *" on $target "*"read-only"*) return 0 ;;
    esac
  done < <(/sbin/mount)
  return 1
}

/sbin/mount -ur /mnt1
/sbin/mount -ur /mnt2
mount_is_read_only /mnt1
mount_is_read_only /mnt2
/sbin/mount
/bin/ls -ldn \
  /mnt1/private/etc/ssh \
  /mnt1/usr/sbin/sshd \
  /mnt1/usr/libexec/pocketjs-device \
  /mnt1/usr/lib/libcrypto.0.9.8.dylib \
  /mnt1/private/etc/ssh/moduli \
  /mnt1/private/etc/ssh/sshd_config \
  /mnt1/private/etc/ssh/ssh_host_rsa_key \
  /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist \
  /mnt2/root/.ssh \
  /mnt2/root/.ssh/authorized_keys_pocketjs
RAMDISK
```

Require both mounts to be read-only, every `cmp` to pass, and the displayed
modes/owners to match the table and `bootstrap-receipt.json`, including
`0:0/0755` for `/private/etc/ssh` and `0:0/0700` for
`/private/var/root/.ssh`. The ramdisk cannot unmount these volumes; the verified
read-only remount is the safe boundary.

Do not execute `pocketjs-device`, `PocketJSDemo`, the installed historical
`sshd`, or stock 1.1.4 launch tools inside this pinned SSH ramdisk. Its own
`/bin/bash` carries `LC_CODE_SIGNATURE`, while those stock/bootstrap binaries do
not; the ramdisk can therefore terminate the new helper with `SIGKILL`. Ramdisk
acceptance is deliberately limited to byte-for-byte readback, modes, ownership,
and read-only mount state. A ramdisk-side `SIGKILL` is not evidence that the
helper fails on the target OS. Run the helper version check only after the phone
has booted normally into iPhone OS 1.1.4.

Only then choose the Kit's `Reboot Device` action. Do not run ZiPhone or a Kit
install action if normal-boot SSH does not start; return to the pinned ramdisk
and inspect only the eight scoped files.

## USB SSH and deployment

After a normal boot, forward the phone's port 22 over usbmux:

```sh
"$IPHONE2G_KIT/bin/macos/arm64/iproxy" 2222 22 -s 127.0.0.1
```

In another terminal, use only the generated per-device configuration. This is
the first point at which executing the installed helper is a valid test:

```sh
SSH_CONFIG="$IPHONE2G_CACHE/bootstrap/ssh_config"
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /sbin/mount
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /usr/libexec/pocketjs-device version
```

The generated config already pins the prepared RSA host key in its dedicated
`known_hosts`; there is no interactive trust-on-first-use step. The normal-boot
root mount must be read-only and the helper must report version 3. Do
not put these legacy RSA/KEX/MAC relaxations in the global SSH configuration.
Password authentication must remain disabled.

The stock 1.1.4 root filesystem does not provide the usual `cp`, `mv`, `rm`,
`chmod`, `chown`, `mkdir`, `sync`, `tar`, or `scp` utilities. Use the repository
deployment command, which speaks only the fixed helper protocol:

```sh
bun iphone2g deploy
```

`deploy` first rebuilds the complete app and obtains the per-build identifier
from `build-receipt.json`. Before writing, it verifies that the installed helper
is byte-identical to the local bootstrap receipt and reports version 3, stops
the old application, and clears the previous runtime status. It sends exactly
`PocketJSDemo`, `Info.plist`, `PkgInfo`, `Icon.png`, and `build-receipt.json`.
On the phone, `pocketjs-device`:

1. acquires a durable build-identifier lock on the writable data volume before
   any root-volume update, then remounts `/` read/write and creates only
   `/Applications/.PocketJSDemo.app.pocketjs-stage`;
2. refuses to replace an existing app containing anything outside the same
   five-file allowlist;
3. moves a known previous bundle to a scoped backup and atomically renames the
   complete stage into `/Applications/PocketJSDemo.app`;
4. returns `/` to read-only on every exit path.

After install, the host reads every one of the five app files back through the
helper and compares its SHA-256 with the local byte stream. Only after that and
a positive read-only proof does the host commit the same transaction. Any
failure before commit invokes identifier-matched rollback and restores the old
bundle when one existed. The committed backup remains available until the next
deployment, which clears it only while preparing a new transaction. A final
read-only proof precedes the SpringBoard rescan. All of those checks must pass
for `deploy` to exit zero. If read-only state cannot be proven, stop and reboot;
do not issue an ad hoc transfer or mount sequence.

## Rollback

Rollback is path-scoped. A whole-disk rewrite is emergency recovery, not the
normal uninstall path, and the raw disk image does not restore baseband state.

### Remove a deployed demo

Boot normally with the usbmux forward active and use only the scoped helper:

```sh
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /usr/libexec/pocketjs-device remove
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /usr/libexec/pocketjs-device root-state
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /sbin/mount
```

The helper refuses an unfinished transaction or any unknown app entry, removes
only the allowlisted current/stage/backup bundle trees, clears the runtime
record, and returns root to read-only. Require all three commands to pass before
restarting SpringBoard or rebooting.

### Remove the SSH bootstrap

Boot the pinned, byte-verified temporary ramdisk again, confirm the device
identity and backup availability, and mount both installed volumes read-only as
above. Remove only files proven absent before bootstrap. This fail-closed block
updates the existing mounts and always attempts to return both to read-only:

```sh
sshrd_script <<'RAMDISK'
set -e

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if ! /sbin/mount -ur /mnt2; then result=90; fi
  if ! /sbin/mount -ur /mnt1; then result=90; fi
  /sbin/mount
  exit "$result"
}
trap 'exit 91' HUP INT TERM
trap cleanup EXIT

/sbin/mount -uw /mnt1
/sbin/mount -uw /mnt2
/bin/rm -f \
  /mnt1/usr/sbin/sshd \
  /mnt1/usr/libexec/pocketjs-device \
  /mnt1/usr/lib/libcrypto.0.9.8.dylib \
  /mnt1/private/etc/ssh/moduli \
  /mnt1/private/etc/ssh/sshd_config \
  /mnt1/private/etc/ssh/ssh_host_rsa_key \
  /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist \
  /mnt2/root/.ssh/authorized_keys_pocketjs
RAMDISK
```

If any target predated this work, restore its path-specific archive instead of
deleting it. Remove newly created `.ssh` or `private/etc/ssh` directories only
if they are empty, and never remove an existing shared directory recursively.
Require the final mount table to show both volumes read-only, then reboot
normally and confirm that USB port 22 no longer accepts the bootstrap identity
while activation, AFC services, baseband state, and stock filesystem policy
remain unchanged.

## Acceptance layers

Keep evidence for each layer separate. Passing an earlier layer is not evidence
for a later one.

### 1. Build acceptance

- `bun iphone2g doctor` reports all required inputs `[ok]`.
- `bun iphone2g build` exits zero.
- `file` reports `Mach-O executable arm_v6`.
- `otool-classic -L`, `Info.plist`, and `build-receipt.json` match the pinned
  1.1.4 toolchain contract.
- The receipt identifies both embedded guest inputs and the combined native
  runtime executable.

### 2. Backup and deployment acceptance

- The raw `/dev/rdisk0` stream and saved file hashes match, its byte size is
  exactly 8,120,172,544, and its repo-external directories/files are
  `0700`/`0600`.
- The read-only configuration and Lockdown archives can be listed on the host.
- The eight installed SSH files match the receipt, modes, and `0:0` ownership.
- Normal-boot SSH accepts only the dedicated key; password authentication is
  rejected.
- The installed helper matches its receipt and the deployment reads all five
  app files back byte-for-byte before committing the per-build transaction.
- `/` is positively verified read-only again before normal use.

These checks prove bytes and transport, not application execution.

### 3. Live hardware acceptance

- The phone performs a normal, non-ramdisk boot and SpringBoard shows the
  PocketJS icon.
- Launching the icon presents the expected 320-by-480 PocketJS UI rather than
  immediately returning to SpringBoard.
- Each physical tap on `TAP ME` visibly increments `Touch count`.
- After at least one tap, validate the device-local runtime record:

  ```sh
  bun iphone2g device-status
  ```

  The command rejects malformed or stale records and requires `build_id` to
  match the local `build-receipt.json`. Require `state=running`, `guest_frames`
  greater than zero, `touch_sequences` greater than zero, a nonzero
  `last_touch_hit`, and an empty `error`. This complements the visible result;
  it does not replace it.
- The app survives quit/relaunch and a normal reboot.
- After unplug/replug, USB SSH still uses the dedicated key and `/` remains
  read-only.
- Capture a dated photo or video plus the build receipt and exact device
  identity as the acceptance record.

The changing Solid signal is the critical runtime proof: the native host must
have loaded and executed the embedded generated guest bundle, rendered its
PocketJS tree, and returned physical touch through the PocketJS input path.
Build or upload success alone does not meet that criterion.

## Primary references

- [Pinned PocketJS toolchain manifest](../tools/cli/iphone2g-toolchain.json)
- [PocketJS iPhone 2G host notes](../hosts/iphone2g/README.md)
- [Legacy-iOS-Kit](https://github.com/LukeZGD/Legacy-iOS-Kit)
- [Legacy-iOS-Kit SSH ramdisk notes](https://github.com/LukeZGD/Legacy-iOS-Kit/wiki/SSH-Ramdisk)
- [Apple open-source Csu](https://github.com/apple-oss-distributions/Csu)
- [Saurik's historical toolchain notes](https://www.saurik.com/toolchain.html)
- [Saurik's historical Telesphoreo notes](https://www.saurik.com/telesphoreo.html)
