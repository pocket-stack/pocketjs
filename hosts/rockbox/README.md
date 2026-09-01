# PocketJS for Rockbox iPod classic

This host embeds a PocketJS application in a Rockbox plugin for the 6th/7th
generation iPod classic (`ipod6g`). It targets the native 320x240 RGB565 LCD
and ARM926EJ-S/ARMv5TE CPU. The current profile is development-only and uses
the software rasterizer, QuickJS, and Rockbox's remaining plugin buffer as a
TLSF heap.

## Controls

| iPod control | PocketJS input |
| --- | --- |
| Select | Circle / confirm |
| Menu | Triangle / back |
| Left, Right | Left, Right |
| Play/Pause | Start |
| Wheel clockwise, counter-clockwise | Down, Up |
| Hold Menu | Exit plugin |

## Build

Rockbox recommends building its ARM cross compiler with `tools/rockboxdev.sh`.
For an existing Rockbox source checkout and toolchain:

```sh
bun install --frozen-lockfile
bun rockbox bootstrap
ROCKBOX_SOURCE=/path/to/rockbox bun rockbox test
ROCKBOX_SOURCE=/path/to/rockbox bun rockbox build
```

The hardware artifact is written to:

```text
dist/rockbox/pocketjs-ipod6g.rock
```

To package a different app, pass its manifest:

```sh
ROCKBOX_SOURCE=/path/to/rockbox \
  bun rockbox build --manifest=/path/to/app.pocket.json
```

Copy the resulting file to `.rockbox/rocks/apps/pocketjs.rock` on the mounted
iPod, eject it cleanly, then launch it from **Plugins > Applications**.

## Current boundary

This first host exposes baked text, software rendering, and click-wheel/button
input. Audio, networking, filesystem APIs, and arbitrary logical viewport
scaling are not advertised by the target profile. A successful cross-build or
USB copy does not replace an on-device launch/input test.
