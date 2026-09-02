# Pocket Remote

An Omarchy companion on the iPod touch 4: a landscape touch surface that
mirrors the desktop and drives it. **The iPod runs the PocketJS guest; a
small daemon on the Omarchy machine mirrors Hyprland into snapshots and runs
the same commands the keyboard bindings run.** Nothing on the wire is a
command string — the device sends action ids from `actions.ts`, the daemon
looks them up.

```
 iPod touch 4 (480x320 landscape)        WiFi         Omarchy machine
 ┌────────────────────────────────┐   PKNT/TCP    ┌─────────────────────────┐
 │ apps/pocket-remote (Solid)     │◀────────────▶│ host/serve.ts (Node)    │
 │ hosts/iphone2g/svcwire.c       │  beacon UDP   │  .socket.sock  requests │
 └────────────────────────────────┘               │  .socket2.sock events   │
                                                  │  omarchy-* / wtype      │
                                                  └─────────────────────────┘
```

## The screen

```
┌─────────────────────────────────────────────────────────────┐
│ 1 2 3 +                          dwindle       ⏮ ▷ ⏭        │  strip   28 px
├─────────────────────────────────────────────────────────────┤
│                                                             │
│           live miniature of the focused monitor             │  stage  240 px
│           tiles = windows, accent border = focus            │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Ω  >_  ◍  ▤  ✎  ⛶  ◱  ▣  ≡  ⌨  ⋯                            │  dock    52 px
└─────────────────────────────────────────────────────────────┘
```

The layout does not move. Every element has one place, every place one job,
so the remote can be used with a glance and, after a day, without one. It
has two verbs: **tap**, and **hold-and-slide** — hold a key and a set of
choices opens under the finger; slide onto one and release. Novices see the
choices, experts stroke through them without looking (the marking-menu
result).

- **Strip**. One tab per workspace Hyprland has, the active one filled, plus
  one empty tab so there is always somewhere new to go (the Omarchy bar's
  rule). Tap switches. Hold a tab to bring the focused window there and
  follow it. The badge names the active workspace's layout and toggles it
  (Omarchy's SUPER+L). Media transport sits at the right end.
- **Stage**. The focused monitor scaled to fit, every window a tile labelled
  by class and title, the focused one bordered in the accent. **Tap focuses.
  Hold closes** — a bar fills across the tile over 0.6 s; lift early and
  nothing happens. Drag a tile onto another to swap them (Hyprland's
  `swapwindow` in the direction between their centres), onto a strip tab to
  move it there. Swipe empty stage to step workspaces. The stage is direct
  manipulation of the real desktop: the snapshot comes from `hyprctl clients`
  geometry, so a tile is exactly where the window is.
- **Dock**. Menu, Term, Web, Files, Edit, Full, Float, Shot, Levels, Type,
  more — eleven 43 px slots across the full width. Each action runs the
  command Omarchy binds to the equivalent key.
- **Menu** (tap) toggles Omarchy's menu on the desktop. **Menu (hold)** opens
  the cascade: six routes rise above the dock over a veil — Apps, Capture,
  Toggle, Style, System, Learn, nearest first — and sliding onto a route fans
  its leaves out beside it. Release on a leaf to run it, on a route to open
  that route's menu on the desktop, elsewhere to cancel.
- **Levels** is the control-centre control: brightness and volume as two
  horizontal sliders with their toggles (nightlight, mute) in one card.
  Tap Levels to open it sticky and drag a slider; tap outside to close.
  Hold Levels and slide: the row under the finger follows it **relatively**
  (a slider never jumps to the finger), release and the card lingers a second
  then puts itself away. Brightness and volume are low-frequency, so they
  earn one slot, not two rails.
- **Type** opens the keyboard over the whole screen — when typing is the job,
  nothing else on the remote matters. Five rows of 48 px keys: esc and the
  digits on top, letters, arrows, tab, ctrl and alt, a chevron in the caption
  bar to put it away. Chords two ways: **sticky modifiers** (tap ctrl, then
  the key; ctrl arms, paints itself, drops after one key) and
  **hold-and-slide variants** (hold `x` → `^X` `⌥X`, hold `1` → `F1` `^1`,
  as light chips above the key; release on the key itself types it plain).
  Keys go straight to the desktop (`wtype`); nothing is buffered on the
  device, so what the desktop shows is the truth.
- **more** opens the pad: everything else, grouped the way Omarchy's own
  menu groups it — Window, Desk, Toggle, Capture, Theme, System — as
  labelled keys. **Destructive keys take a hold** (close, suspend, close all)
  and say so when tapped.

Every touch target answers a press with a tint overlay that lingers a few
frames after release — a capacitive panel has no hover and the remote's own
feedback is the only local one; the action itself is confirmed on the
desktop. A toast over the stage names the last action.

## Why these choices

**A tiling desktop is addressable.** Workspaces have numbers, windows have
addresses, actions have names. That is why the remote has no cursor and no
dial: the Siri Remote needs a trackpad because tvOS is spatial; Omarchy is a
namespace, and a namespace wants direct targets. The stage is the one
spatial element and it is a picture of the real arrangement, not a proxy.

**The remote wears the theme.** The daemon reads Omarchy's `colors.toml`
for the current theme and every themed node repaints through `jump()` on its
mirror when the palette changes (theme.ts). Class literals carry Tokyo Night,
Omarchy's default, so the first frame looks right before the daemon speaks.
Because a class string is a baked literal, a runtime colour can only reach a
node as a prop write; pressed states therefore live on separate overlay nodes
rather than as class flips on themed ones.

**Motion is a pool, not a tree.** Tiles live in a fixed pool of 24 slots
(protocol `WINDOWS_MAX`) keyed by window address. A snapshot re-targets the
pool; the frame loop eases each slot toward its target and writes geometry
straight to the node mirror. Reordering never happens, so the `<For>`
adjacent-swap reconcile path is never exercised, and an idle frame writes
nothing.

**Optimistic where the desktop will agree.** Tapping a tab commits the new
active workspace locally and re-targets the stage before the daemon confirms;
a snapshot carries every workspace's windows, so the new stage is already
known. Level drags update locally and send at most every three frames; host
echoes are ignored for half a second after a release so the rail never
snaps back on the way.

## Hyprland's request socket speaks Lua

Hyprland 0.5x (the Lua-config generation Omarchy 4 runs) evaluates
`dispatch <text>` on `.socket.sock` as `hl.dispatch(<text>)`, so the old
`dispatch workspace 1` grammar fails with a Lua parse error — from `hyprctl`
too. **Every dispatcher in `actions.ts` is therefore a Lua constructor call**
(`hl.dsp.focus({ workspace = "1" })`, `hl.dsp.window.close({ window =
"address:0x…" })`), the same ones Omarchy's own bindings and scripts use. The
daemon builds window and workspace targets only from validated pieces
(`luaWindow`, `luaWorkspace`), so nothing off the wire can reach the Lua
evaluator as code.

## The wire

Spec ops 30–32 (`svcOpen`/`svcPoll`/`svcSend`) over the SVC WIRE (PKNT) TCP
transport, exactly the mailbox the PSP, Vita and 3DS companions speak.
`hosts/iphone2g/svcwire.c` is the legacy Apple hosts' transport — a port of
the 3DS one (non-blocking BSD sockets pumped once per guest frame, no
threads) — compiled in only when `POCKET_SVC_WIRE` is defined, so every
other legacy Apple build keeps its op table byte-identical.

Lines are JSON (`protocol.ts`). Host → device: `hello`, `auth`, `state`,
`levels`, `theme`, `toast`. Device → host: `hello`, `act`, `ws`, `win`,
`vol`, `bri`, `mute`, `media`, `type`, `key`, `theme`. **A snapshot has to
fit one 8 KiB poll batch**, so titles are clipped to 28 code points, windows
to the 24 most recently focused, and coordinates are integers.

Discovery: the daemon (or the relay) broadcasts the PKNT beacon once a
second; the device connects to the datagram's source. A host override file
at `/private/var/tmp/pocketjs-svc-host.txt` on the device (one line,
`a.b.c.d[:port]`) skips discovery for broadcast-hostile networks.

**The cable.** The device also listens on port 8624. When the iPod is plugged
into the Omarchy machine, usbmuxd lists it and `iproxy` forwards a host port
to that listener; the daemon polls `idevice_id -l` every three seconds,
forwards a port per device and dials it. Same wire, roles of `connect()`
reversed — the device still speaks the hello first — no WiFi, no beacon, no
firewall rule, and **a device on the cable is trusted without a dialog:
physical possession is the pairing.** The device's acceptance record reports
the transport as `svc=up-usb`. This needs the `usbmuxd` package on the
machine (libimobiledevice alone ships `iproxy` but not the daemon that talks
to the device).

## Trust

The LAN is not a trust boundary. The daemon accepts commands only from
addresses in `~/.local/state/pocket-remote/allowed.json`; a new device is put
on hold and `hyprland-dialog` asks on the desktop whether to allow it. An
unanswered dialog is not a refusal — the device is asked again next time.
Until allowed, a device sees the mirror but every command is dropped. The
action vocabulary is closed (`actions.ts`); typed text goes through `wtype`
capped at 256 characters per line; keysyms are a short allow-list.

## Running it

On the Omarchy machine (`ssh` alias `x1nano`; Node comes from mise):

```
bun tools/pocket-remote.ts deploy-host x1nano     # copy the daemon, install + start the user unit
bun tools/pocket-remote.ts logs x1nano            # journal tail
```

Omarchy ships ufw with incoming DROP, so the iPod cannot reach tcp 8622 on
the laptop directly. Until `sudo ufw allow from 172.20.8.0/21 to any port 8622
proto tcp` has been run there (and the unit started with `--beacon`), run the
relay on the Mac — an ssh tunnel over the port that is open, plus the beacon:

```
bun tools/pocket-remote.ts relay x1nano           # local 8623 -> x1nano:8622, beacon on 8621
```

On the iPod:

```
POCKETJS_IPODTOUCH4_APP=pocket-remote bun ipodtouch4 deploy
POCKETJS_IPODTOUCH4_APP=pocket-remote bun ipodtouch4 launch
```

When the iPod is plugged into the Omarchy machine rather than this Mac, add
`POCKETJS_IPODTOUCH4_VIA=x1nano`: device discovery and the `iproxy` tunnel
run there over ssh, and every ssh/scp to the device jumps through it
(`ProxyJump`), so the deployment key and the pinned host key stay here.

The app coexists with Pocket Clear: its own bundle, executable, URL scheme
and receipt files (`tools/ipodtouch4.ts` `IPODTOUCH4_APPS`).

## Landscape on a portrait panel

The plan asks for 480x320 native. The host keeps the window at the panel's
own 320x480, rotates the content view a quarter turn about its centre
(home button on the right) and lets the CAEAGLLayer's drawable follow the
view's bounds, so GL renders 960x640 and UIKit's `locationInView:` already
reports touches in the view's rotated space. The resolver admits a native
viewport that fills the panel in either orientation and reports the
transposed physical size, which `status` and `capture` check against.

## Testing

- `tests/pocket-remote.test.ts` — wire constants pinned to spec.ts, framing,
  protocol clipping, the action table's invariants, layout arithmetic, the
  Hyprland → snapshot reduction, Omarchy output parsers.
- `tests/pocket-remote-sim.test.ts` — the built bundle in the headless sim:
  hello, theme, snapshot, tiles settle, a tap on the strip switches
  workspace, the pending-approval screen.
- `bun tools/pocket-remote.ts client 127.0.0.1:8623 --for 4` — a scripted
  device against a live daemon.
