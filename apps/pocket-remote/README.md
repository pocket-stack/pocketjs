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
┌────┬───────────────────────────────────────────────────┬────┐
│ ☀  │ 1 2 3 +            dwindle        ⏮ ▷ ⏭          │ ♪  │  strip   32 px
│    ├───────────────────────────────────────────────────┤    │
│    │                                                   │    │
│ b  │        live miniature of the focused monitor      │ v  │  stage  228 px
│ r  │        tiles = windows, accent border = focus     │ o  │
│ i  │                                                   │ l  │
│    ├───────────────────────────────────────────────────┤    │
│    │ Ω  >_  ◍  ▤  ✎  ⛶  ◱  ▣  ⌨  ⋯                     │    │  dock    60 px
└────┴───────────────────────────────────────────────────┴────┘
 40px                       400 px                        40px
```

The layout does not move. Every element has one place, every place one job,
so the remote can be used with a glance and, after a day, without one.

- **Rails** (left brightness, right volume). A drag anywhere on a rail moves
  the level **relatively** — touching a rail never jumps the level to the
  finger, the failure of every absolute slider on a thin track. A full-track
  drag spans 0–100 %. A tap on the track nudges 5 %, the keyboard's own step.
  The cap toggles: mute on the right, nightlight on the left. Thumbs rest at
  the edges when the device is held in two hands, and the rails stay live
  under every sheet.
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
- **Dock**. Menu, Terminal, Browser, Files, Editor, Full screen, Float,
  Screenshot, Type, More. Nine things a remote is reached for; each runs the
  command Omarchy binds to the equivalent key.
- **Pad** (More). Everything else, grouped the way Omarchy's own menu groups
  it — Window, Desk, Toggle, Capture, Theme, System — as labelled keys on one
  sheet. **Destructive keys take a hold** (close, suspend, close all) and say
  so when tapped. The Theme page lists the installed themes; the active one is
  filled.
- **Type**. A landscape keyboard sends each key to the focused window
  (`wtype`). Nothing is buffered on the device: the desktop shows the truth.

Every touch target answers a press with a tint overlay that lingers a few
frames after release — a capacitive panel has no hover and the remote's own
feedback is the only local one; the action itself is confirmed on the
desktop. A toast over the dock names the last action.

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
