---
name: pocketjs-devtools
description: Debug PocketJS apps with Pocket DevTools — deterministic input-tape time travel, component-tree inspection with on-device highlight, pause/step, REPL eval and console on real PSP hardware over PSPLINK, on-demand screenshots, and headless tape replay for regression evidence. Use when asked to debug UI behavior, reproduce or bisect a visual regression, inspect the component tree, capture device screenshots, or verify a fix against a recorded session.
---

# Pocket DevTools

## Overview

PocketJS is fixed-dt deterministic and its entire per-frame input is one
button bitmask, so a recorded input tape replays any session byte-exactly.
DevTools (design: repo `DEVTOOLS.md`) is built into every bundle: a flight
recorder is ALWAYS on (36 000-frame ring), and a JSON-line debug channel
connects the runtime to a desktop panel over WebSocket (browser host) or the
PSPLINK USB mailbox (real PSP).

Prefer the headless tape workflow for agent debugging — every question is
answerable from the terminal. Use the panel when a human is co-driving.

## Headless workflow (no screen needed)

```bash
bun run tape record hero-main --frames 180 --input "5:64,40:8192" --out t.json
bun run tape replay hero-main t.json --hashes h.json     # per-frame FNV hashes
bun run tape replay hero-main t.json --assert h.json     # exit 1 + FIRST DIVERGENT FRAME
bun run tape replay hero-main t.json --png 60,120        # render frames to PNG (read them!)
bun run tape tree   hero-main t.json --at 60             # component tree JSON at frame 60
bun run tape:check                                       # committed session golden
```

- Input masks are spec/spec.ts `BTN` values (`CIRCLE=0x2000=8192`, `DOWN=0x40=64`).
- A regression workflow: record/obtain a tape on the OLD build → `--hashes` →
  switch builds → `--assert` names the exact first frame that changed →
  `--png <that frame>` on both builds to see the difference.
- Tapes exported from ANY host (panel "Export", or `__pocketDevtools.dumpTape()`
  in the REPL) replay headlessly. `startFrame > 0` means the ring wrapped —
  replay is then an approximation (warned automatically).
- Committed session goldens live in `test/tapes/`; regenerate hashes only when
  a visual change is intended.

## Panel workflow (one command)

```bash
bun run devtools            # panel + WS hub + mailbox bridge, one process
bun run devtools cards      # + build, USB-link and launch cards on a real PSP
```

Panel at `http://127.0.0.1:8130/devtools`. `bun run devtools` auto-detects an
already-running `bun psplink` / `bun run hw` usbhostfs session and bridges
into it instead of fighting for the cable (relaunch the app there so it
probes the mailbox at boot). Shortcuts: `o` open panel, `r` rebuild+relaunch
(managed sessions), `q` quit.

Panel capabilities: hover tree → highlight ON THE DEVICE SCREEN (core-drawn
overlay, works on real PSP); click pins; pause/step/resume freeze the whole
world; tape strip with click-to-seek (browser host reloads and deterministically
fast-forwards); REPL evals in the app global scope between frames; 📷
screenshot button downloads a PNG (browser: canvas; PSP: raw VRAM dump over
usbhostfs, converted by the bridge — pixels never cross the JSON channel).

## Real-PSP specifics

- Transport = `pocketjs-dbg/{enable,in,out}.jsonl` on the usbhostfs share
  (`host0:`). The app probes `enable` ONCE at boot — start the bridge before
  launching the app, or relaunch after. No PSPLINK → zero cost.
- Shim polls every 10 frames on PSP (~166 ms hover latency); every frame on
  other hosts.
- `console.log` works on PSP only while a transport is attached (prelude
  stubs it otherwise).
- PPSSPP GUI works via the `ms0:` fallback: point `--dir` at the memstick
  root.

## Protocol quick reference (JSON lines)

Panel→device: `inspect{id}` (0 clears) · `pause` · `resume` · `step` ·
`getTree` · `eval{id,code}` · `dumpTape` · `screenshot` · `seek{frame}` /
`replay{tape}` (browser host-level).
Device→panel: `hello{app,host,frame}` · `tree{root:{i,t,n,c,x,k}}` ·
`inspect{id,rect|null}` · `stats{frame,nodes,tapeLen,paused}` ·
`log` · `error{frame,message}` · `evalResult{id,ok,value}` · `tape{tape}` ·
`screenshot{frame,data}`.

## Gotchas

- `rect: null` / `debugRectXY() === -1` = the node is never painted
  (display:none, detached, or inside a `paint_3d` perspective subtree — 3D
  interiors aren't captured; the perspective ROOT is).
- Adding spec ops: edit `spec/spec.ts` → `bun spec/gen-rust.ts` → implement
  on `Ui` + BOTH hosts (`native/src/ffi.rs`, `wasm/src/lib.rs`) + `host-web/
  wasm-ops.js` + `HostOps` (optional members) — `test/contract.ts` locks the
  spec halves together.
- `debugName` / `<Named>` are JS-mirror-only: provably zero pixel impact
  (goldens + tape hashes unchanged). Name every function component's root
  element; the tree panel and `tape tree` output read like the source.
- Shim tests live in `test/devtools.test.ts` (mock ops + in-process
  transport; `--conditions=browser` required). Core pause/inspect tests in
  `core/src/tests.rs`.
- Missing QuickJS symbols (vendored libquickjs-sys is minimal): declare a
  local `extern "C"` block — precedent in `native/src/main.rs` and `ffi.rs`.
