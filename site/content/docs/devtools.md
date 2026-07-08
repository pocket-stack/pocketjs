# DevTools

Pocket DevTools is built into every bundle: a component inspector that
highlights nodes **on the device screen** (real PSP included), pause and
single-step for the whole world, a REPL and `console.log` from hardware, an
always-on input-tape flight recorder, and on-demand screenshots. The design
rests on one property: PocketJS is fixed-dt deterministic and its entire
per-frame input is one button bitmask — so a recorded input tape replays any
session byte-for-byte. Architecture deep-dive:
[the blog post](/blog/time-travel-devtools/) and
[`DEVTOOLS.md`](https://github.com/pocket-stack/pocketjs/blob/main/DEVTOOLS.md).

## One command

```sh
bun run devtools            # panel + hub + USB bridge, one process
bun run devtools cards      # + build, USB-link and launch cards on a real PSP
```

The panel serves at `http://127.0.0.1:8130/devtools`. With an app argument it
builds the EBOOT, serves it to the PSP over usbhostfs and launches it through
PSPLINK; if a `bun psplink` / `bun run hw` session already owns the cable it is
detected and bridged into instead. Shortcuts: `o` open panel, `r` rebuild +
relaunch, `q` quit. Also available from the CLI as `pocket devtools`.

Browser-host debugging needs nothing extra — any demo loaded from the dev
server connects to the panel automatically.

## The component tree

The left panel is the live component tree. Hover a node and the region lights
up on the device screen — the highlight is drawn by the renderer itself (four
rectangles appended to the DrawList), so it works identically on PSP hardware,
in the browser, and headless, and it glides between nodes as you move. Click
pins a node and shows its details: type, classes, text, and the world-space
rect.

Name your components so the tree reads like your source:

```tsx
// a) the debugName prop on any primitive
<View debugName="Header" class="flex-row items-center justify-between">…</View>

// b) the <Named> wrapper around a component subtree (renders no node)
<Named name="MessageCard"><Card {...props} /></Named>
```

Both are mirror-only — provably zero pixel and zero native cost (goldens are
byte-identical with and without them).

## Time travel

Every bundle runs a flight recorder unconditionally: one `u16` button mask per
frame in a 36 000-frame ring (10 minutes ≈ 72 KB). Because the runtime is
deterministic, that tape **is** the session.

In the panel: **⏸ pause** freezes the entire world in the core — every
animation, timeline and sprite clock holds, and stepping advances everything by
exactly 1/60 s. **Load tape** renders the input activity per frame; clicking a
frame seeks there (the browser host reloads and deterministically
fast-forwards). **Export** downloads the tape as JSON; **Replay file…** plays
one back from boot.

Headless, the same tape answers debugging questions from the terminal:

```sh
bun run tape replay <app> session.tape.json --hashes h.json   # per-frame hashes
bun run tape replay <app> session.tape.json --assert h.json   # first divergent frame
bun run tape replay <app> session.tape.json --png 4120        # render any frame
bun run tape tree   <app> session.tape.json --at 4120         # tree JSON at a frame
```

`--assert` turns a recorded session into a regression test: replay it against a
new build and it names the exact frame where behavior changed. The repo ships
one as a *session golden* (`bun run tape:check`).

## REPL, console, errors

The console panel evals JavaScript in the app's global scope between frames —
the world is quiescent there, so what you inspect is real state. `console.log`
/ `warn` / `error` mirror to the panel from every host, including QuickJS on
the PSP (which has no console of its own — the shim installs one). Exceptions
thrown during a frame are reported with their frame index; the frame number
plus the tape is a reproduction.

## Screenshots

The 📷 button captures the device framebuffer on demand and downloads it as a
PNG (plus a thumbnail strip of recent captures). On real hardware the raw VRAM
rides the usbhostfs mount and the desktop bridge encodes the PNG — pixels never
cross the debug channel.

## Real PSP setup

The debug channel to hardware is a file mailbox on the PSPLINK usbhostfs share
(`host0:/pocketjs-dbg/`). The app probes for it **once at boot** — so start
`bun run devtools` first, then (re)launch the app; without PSPLINK the probe is
two failed file-opens and the app never touches IO again. On PSP the shim polls
every 10 frames (~166 ms hover latency); other hosts poll every frame.

The same mailbox works under the PPSSPP emulator: PPSSPP maps the EBOOT's own
directory as `host0:`, which is exactly where `bun run devtools <app>` puts the
mailbox.
