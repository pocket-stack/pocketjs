# PocketRock v0.1

PocketRock is the iPod Classic 6/7 generation production host for PocketJS. It
uses Rockbox for hardware, codecs, playback, Tagcache, playlists, USB, power,
and the native `.rock` loader. A QuickJS realm running the embedded PocketRock
Shell owns the normal 320 x 240 user interface.

## Fixed compatibility contract

- Rockbox baseline: `420537c8643cc6ffc844115d2fca9e6129f7ce71`
- PocketJS target: `rockbox-ip6g`
- Host ABI: `10`
- QuickJS: `ba5bdd0dc013518768e76cd9e05cd30ed53dd35b`
- CPU/display/input: ARM926EJ-S, RGB565 320 x 240, Click Wheel
- Guest allocation: one releasable Rockbox `core_alloc` arena, capped at 12 MiB
- Native guest thread stack: 512 KiB
- QuickJS stack limit: 384 KiB

The embedded Shell and each installed application run as bytecode produced by
the fixed QuickJS revision. One realm exists at a time. Starting a native
Rockbox plugin destroys the realm and releases the complete guest arena before
calling `plugin_load()`; returning from the plugin allocates a new arena and
recreates the Shell.

## Package and application layout

`pocket build --target rockbox-ip6g` emits one `.pocket` variant. Section 6
contains QuickJS bytecode. The firmware validates the package footer, variant
hash, target, Host ABI, section bounds, and build plan before reading bytecode
or resources. Packages live at:

```text
/.rockbox/pocketrock/apps/*.pocket
```

Installed packages are trusted. PocketRock v0.1 has no signatures, permission
prompts, or security sandbox. Do not install packages whose source you do not
trust.

The release installs two first-party packages in that directory:

- `hero.pocket` — the official PocketJS Hero adapted to 320 x 240.
- `pocketjs-tests.pocket` — the Click Wheel input matrix and 10,000-row
  contacts/scrolling acceptance pages. Hold Select and press Left or Right to
  switch pages.

## Native compatibility surface

The normal firmware path never enters Rockbox's root menu. Native boot progress,
voice notices, and user-selected skin loading are disabled by the production
build. Recovery is a small direct-framebuffer screen rather than a Rockbox menu.

Rockbox list, menu, keyboard, browser, and skin implementations remain linked
only as a `.rock` compatibility layer. Their function pointers are fields of
the stable `plugin_api`; deleting the implementations would make existing
plugins crash when they call those entries. PocketRock releases the complete
JavaScript arena around every `plugin_load()` call.

PocketRock also ignores the Rockbox theme selected in `config.cfg`. At boot,
before a native plugin, and after it returns, the firmware reapplies the fixed
PocketRock native palette. The release supplies `PocketRock.cfg`,
`pocketrock.sbs`, and `pocketrock.wps`; third-party theme files may remain on
disk but are never selected by the PocketRock system path.

## Build

```sh
export ROCKBOX_SOURCE=/path/to/gfhdhytghd-rockbox
export ROCKBOX_BUILD=/path/to/build-ipod6g
bun tools/rockbox.ts bootstrap
make -C dist/rockbox/quickjs-rs/libquickjs-sys/embed/quickjs qjsc
bun tools/rockbox.ts firmware
```

For a release ZIP, provide a standard Rockbox iPod 6G ZIP containing the native
plugins and codecs. The command replaces only the firmware and adds PocketRock
directories and notices:

```sh
export POCKETROCK_BASE_ZIP=/path/to/rockbox-ipod6g.zip
bun tools/rockbox.ts release
```

The output directory contains `pocketrock-ipod6g-rockbox.zip`, `rockbox.ipod`,
`SHA256SUMS`, and source archives for both repositories.

## Recovery

Hold Menu during boot to bypass QuickJS. The minimal native recovery screen can
disable third-party applications, clear the active application, enter USB mode,
reboot, or power off. It cannot enter the Rockbox root menu or file browser.
Three consecutive Shell startup failures
also enter recovery. Runtime logs rotate between two files capped at 64 KiB:

```text
/.rockbox/pocketrock/logs/runtime.log
/.rockbox/pocketrock/logs/runtime.log.1
```

Every guest teardown also logs the 12 MiB arena size and TLSF peak allocation,
so real-device runs can confirm the production budget rather than relying only
on compile-time constants.
