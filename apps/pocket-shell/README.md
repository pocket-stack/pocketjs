# Pocket Shell

A tiling window shell for the Nintendo 3DS, running entirely on the console.
The top screen is the **stage**: Omarchy's tokyo-night wallpaper under windows
tiled by a **dwindle** or **scrolling** layout, five workspaces, a 14 px bar.
The touch screen is the **deck**: the workspace strip, a live minimap of the
stage, the dock, and — whenever a shoulder is held — the chord map for that
shoulder. Every window holds a local applet (a command line, a clock, notes,
the key sheet, stats, about); nothing needs a companion.

```sh
bun tools/3ds.ts pocket-shell            # dist/3ds/pocketshell-main.3dsx
bun tools/3ds.ts pocket-shell --cia      # plus the installable CIA
bun test tests/pocket-shell-wm.test.ts   # layout rules, chords, pocketsh
bun tools/test.ts --stage=pocket-shell   # the headless sim replay of the tape
E2E_AZAHAR_APP=pocket-shell bun run e2e:3ds   # the ten Azahar goldens
```

## The interaction model

Omarchy binds every window action to `SUPER` plus one key, and `SUPER + K`
shows the table. Pocket Shell keeps the grammar and changes the hardware:

| held | layer | what the other buttons do |
|---|---|---|
| nothing | plain | belong to the focused window's applet |
| **L** | super | act on the focused window |
| **R** | shift | the same verbs, moved: swap, maximize, spawn |
| **L + R** | ws | the d-pad steps workspaces and carries windows |

**The chord map is on the deck, not behind a key.** Pressing a shoulder
replaces the minimap with the table for that layer, labelled per button, and
puts the layer's name in the bar. Releasing brings the minimap back. The
table and the dispatcher read the same array (`chords.ts`), so a label cannot
describe something the button does not do.

**Every chord is also reachable by touch.** Rows of the chord map are tap
targets, and the L and R pills on the strip latch a layer for one action, so a
stylus alone can close a window or switch layouts.

### L — window

| button | action | Omarchy |
|---|---|---|
| d-pad | focus the window in that direction | `SUPER + arrows` |
| circle pad | push the nearest split boundary (dwindle) · column width (scrolling) | `SUPER + -/=` |
| A | launcher (grid on the deck; d-pad picks, A opens, B closes) | `SUPER + SPACE` |
| B | close the focused window | `SUPER + W` |
| X | fullscreen (covers the bar) | `SUPER + F` |
| Y | toggle the split's orientation (dwindle) · cycle column width ⅓ ½ ⅔ 1 (scrolling) | `SUPER + J` |
| START | toggle this workspace between dwindle and scrolling | `SUPER + L` |
| SELECT | the key sheet on the stage | `SUPER + K` |

### R — move

| button | action | Omarchy |
|---|---|---|
| d-pad | swap with the window in that direction | `SUPER + SHIFT + arrows` |
| circle pad | pan the strip (scrolling) | |
| A | another window of the focused app | `SUPER + RETURN` |
| B | reopen the last closed app | |
| X | maximize (keeps the bar and the outer gap) | `fullscreen, 1` |
| Y | swap the split's halves (dwindle) · stack into the left column, or unstack (scrolling) | `swapsplit` |
| START | next wallpaper | `SUPER + CTRL + SPACE` |
| SELECT | toggle the bar | `SUPER + SHIFT + SPACE` |

### L + R — workspace

| button | action |
|---|---|
| d-pad ← → | previous / next workspace |
| d-pad ↑ ↓ | carry the focused window to the previous / next workspace and follow it |

Plain **SELECT** opens the deck keyboard when a term or notes window has
focus. Nothing is bound to **ZL / ZR**: they are New-3DS-only, reach libctru
through `ir:rst` rather than the HID pad, and have no `BTN` constant in
`contracts/spec/spec.ts` yet.

### Touch

- **Workspace strip**: tap a tab to switch; the layout badge toggles the
  layout; L / R pills latch a layer.
- **Minimap** (the stage at 0.6): tap a window to focus it. **Hold a window
  to arm the close bar**, then release on the bar to close — a resistive
  panel has one contact and an 18 px × is a coin flip, so closing is a hold,
  a slide and a release (the Pocket Term convention). Drag a window onto
  another to swap them, or onto a workspace tab to move it there. Drag the
  gap between two windows to move that split. In the scrolling layout, drag
  the background to pan the strip, or a column's edge to resize it.
- **Gutter buttons**: `kbd` (keyboard), `wall` (next wallpaper), `keys` (key
  sheet), `bar` (toggle the bar).
- **Dock**: tap an app to open it on the current workspace; a green dot marks
  apps with a window.

### Feedback

Anything that cannot happen says why on the deck's hint line for about 1.6 s
("nothing left", "workspace 1 is the first", "a split needs two windows").
A focus change is also visible on the stage: the focused window carries
Omarchy's 2 px active border (cyan to green), unfocused windows a grey one.

## Layouts

Both layouts share the geometry constants in `wm.ts`: **`BAR_H` 14,
`GAP_OUT` 4, `GAP_IN` 3, `BORDER` 2** — neighbours sit 6 px apart, the edge
gap is 7 px. Omarchy's `gaps_in 5 / gaps_out 10 / border 2` at a 3.5" panel.

**Dwindle** is a binary split tree. A new window splits the focused leaf
along its longer side and takes the right or bottom half (Hyprland's
`force_split = 2`); a split keeps its orientation when a child closes
(`preserve_split = true`). Resizing walks up from the focused leaf to the
nearest split on that axis whose boundary lies on the pushed side, and moves
that ratio; ratios clamp to 0.15..0.85.

**Scrolling** is a strip of columns wider than the screen. A new window
opens as a column after the focused one at **0.49 of the workspace width**,
so two columns fit (Omarchy's `column_width`). The strip scrolls so the
focused column is fully visible, preferring its right edge. A column holds a
vertical stack of equal-height windows.

**Toggling layouts keeps window order and focus**: dwindle → scrolling makes
one column per leaf in tree order; scrolling → dwindle re-inserts the windows
in strip order, each splitting the one before it.

Each workspace keeps its own layout, fullscreen state and scroll position.
Five workspaces exist from boot; nothing is persisted across launches (the
3DS host has no `fs` module).

## Applets

- **term** — pocketsh, the shell's own `hyprctl`: `ls`, `open <app>`,
  `close [id]`, `focus <id>`, `ws [1-5]`, `layout [dwindle|scrolling]`,
  `wall [next]`, `tz [+8]`, `keys`, `fetch`, `date`, `uptime`, `echo`,
  `clear`. Plain
  buttons: A enter, B backspace, X tab-complete, Y space, ↑↓ history, START
  clear; the circle pad scrolls. 12 px JetBrains Mono on a 7 px cell.
- **clock** — the RTC at 36 px, the date, a seconds bar; A toggles 12 h.
- **notes** — a scratch pad on the same keyboard; A newline, B backspace.
- **keys** — the chord table as a window; ↑↓ scroll.
- **stats** — fps, frame, uptime, windows, host, wallpaper, layer.
- **about** — what this is.

## Files

```
wm.ts         the window manager: pure state and geometry (tested)
chords.ts     the modifier grammar as one table, plus its labels (tested)
shell.ts      pocketsh, the command interpreter (tested)
store.ts      signals, per-frame input dispatch, geometry animation, applet state
stage.tsx     top screen: wallpaper, windows, bar, key sheet
deck.tsx      touch screen: strip, minimap and its gestures, chord map, launcher, dock
keyboard.tsx  the deck's hand-laid touch keyboard
applets.tsx   term · clock · notes · keys · stats · about
wall/         tokyo-night backgrounds in 512x256 envelopes (prepare.ts cooks them)
images.json   bakes the wallpapers as PSM_5650
```

**Wallpapers are 400x240 crops padded into 512x256**: `framework/compiler/pak.ts`
accepts power-of-two images only, and the stage clips the padding under an
overflow-hidden root. Three fit in 768 KB at 16 bits per pixel; `R + START`
cycles them.

## The depth budget

**The 3DS spends its JS stack on JSX nesting depth, not node count**
(`hosts/3ds/src/qjs.c`, `POCKETJS_JS_STACK_SIZE`). A QuickJS call frame is
expensive and mounting descends the tree, so an applet sits at the bottom of
a chain that already runs stage → windows → window chrome → content. Opening
one `keys` window whose rows each carried a wrapper view with a `Show` inside
overflowed the old 192 KiB budget mid-frame, and the runtime rolled the whole
guest back to last-good — which, on a card that also holds Pocket Term, looks
like the shell "turning into" another app.

Two things came out of that. The host budget is now 384 KiB, which is what
the sibling Pocket Term work already found it needed. And **a row here is an
offset, not a node**: `Keys` and `Stats` render each column as its own flat
pass of absolutely-positioned `Text` under the applet root, three levels
deep, instead of a wrapper view per row. Prefer that shape for any new
applet, and remember an emulator with a generous stack will not warn you —
`tests/golden-specs.ts` has a `pocket-shell-applets` tape that opens every
applet from the dock precisely because the first tape never did.

## The clock

**The RTC's epoch is sound; the console's breakdown of it is not.** On
hardware `Date.now()` is monotonic and correct, but `getHours()`
intermittently disagreed with that epoch by whole hours — applying the
timezone on some reads and not others. Two adjacent frames rendered two
different times, which is what "the clock flickers" turned out to be: not a
rendering fault but two wrong readings alternating. Measured on the device,
the big time text changed by ~1600 px between consecutive frames; after the
fix it changes by zero.

So nothing here calls a `Date` breakdown method. `civilFromEpoch` in
`shell.ts` derives the whole civil date and time from the epoch by
arithmetic, and the shell reads only that. The zone is sampled once at boot
and accepted only if it looks like a real one (a whole quarter-hour within
±14 h); a console that reports nothing usable shows UTC, and **`tz +8` in
pocketsh states the offset the console could not**.

## Determinism

The bar shows the RTC as `HH:MM`. `tests/e2e/azahar.ts` pins the emulator's
clock (`init_clock = 1`, `init_time` = 2000-01-01 00:00:00), so a golden run
reads `00:00` for its first minute. The golden tape avoids the clock and
stats applets, whose seconds would differ run to run. Uptime counts frames,
not wall time.
