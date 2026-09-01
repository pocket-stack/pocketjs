# TI-Nspire CX II / Ndless host

This development host runs one PocketJS guest on a **TI-Nspire CX II only**.
It embeds the compiled JavaScript and pak into one Ndless `.tns` program,
executes the guest with QuickJS, rasterizes the ordinary PocketJS DrawList in
software, converts its top-left BGRA output to RGB565, and presents it through
Ndless `lcd_blit`.

The development target is `nspire-cx2-dev`, with a fixed 320x240 logical and
physical viewport at raster density 1. It advertises only:

- `input.buttons`
- `input.analog.left` (the CX II touchpad sampled as two axes)
- `input.cursor` (the framework's synthesized cursor)
- `text.glyphs.baked`

There is deliberately no audio, touchscreen, network, filesystem, or runtime
font capability. A manifest requiring one of those is rejected before its
guest bundle is produced. The touchpad is controller input, not
`input.touch`.

## Toolchain

Install the current Ndless SDK and put `nspire-gcc`, `nspire-ld`, `genzehn`,
and `make-prg` on `PATH`. The host targets the SDK's ARM926EJ-S ABI:
ARMv5TE, ARM mode, EABI, soft float. Rust uses the pinned nightly already used
by PocketJS's standalone `no_std` core and builds `core`, `alloc`, and
`compiler_builtins` for `targets/armv5te-nspire-eabi.json`.

Check the local setup and fetch PocketJS's pinned QuickJS revision:

```sh
bun install --frozen-lockfile
bun nspire doctor
bun nspire bootstrap
```

`bootstrap` writes its checkout under ignored `dist/nspire/` and applies the
small `tools/nspire/quickjs-cx2.patch` portability patch (Newlib's `int32_t`
typedef differs from the PSP SDK's). It does not use an arbitrary system QuickJS. To use an existing checkout instead, set
`POCKETJS_QUICKJS_DIR` to its `libquickjs-sys/embed/quickjs` directory.

## Build

The included demo reuses the Hero application at the CX II viewport:

```sh
bun nspire bundle
bun nspire build
# dist/nspire/pocketjs-cx2.tns
```

Build another app with a CX II-compatible manifest:

```sh
bun nspire build --manifest=path/to/pocket.json
```

### Input acceptance guest

The input guest shows the **currently held CX II matrix keys**, the PocketJS
button mask, the **raw 0-255 analog axes**, and a touchpad-position marker:

```sh
bun nspire build --manifest=hosts/nspire/input-test/pocket.json
# dist/nspire/pocketjs-cx2.tns
```

The left panel updates from a host-only diagnostic string and does not add
calculator keys to the PocketJS button ABI. It recognizes the numeric,
alphabetic, operator, navigation, modifier, document, menu, and touchpad-click
matrix entries exposed by Ndless. Moving across the touchpad moves the amber
marker across the outlined range; lifting the finger reports `X 128 Y 128`
because the host centers an absent analog sample.

Copy `pocketjs-cx2.tns` to the calculator and open it with Ndless. Hold
**Ctrl+Esc** to leave the runtime. Default controls are:

| CX II key | Pocket button |
| --- | --- |
| arrows | D-pad |
| Ctrl / Enter / touchpad click | confirm (Circle) |
| Esc | back (Cross) |
| Shift | Square |
| Tab | Triangle |
| Menu | Start |
| Var | Select |
| touchpad position | analog axis / synthesized cursor |

## Acceptance boundary

The host remains outside PocketJS's production `POCKET_TARGETS` registry until
a CX II run proves all of the following:

- Ndless loads the generated `.tns` and QuickJS evaluates the embedded guest.
- The first Hero frame has correct RGB565 channel order and orientation.
- D-pad focus, confirm/back edges, touchpad cursor, and Ctrl+Esc work.
- A sustained animation does not exhaust memory and input remains responsive.
- Exiting restores the OS framebuffer mode.

Host-side tests cover the target contract and BGRA-to-RGB565 conversion, but
they are not substitutes for these calculator checks.
