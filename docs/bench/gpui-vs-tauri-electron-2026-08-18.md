# Desktop markdown editor: gpui backend vs Tauri vs Electron (2026-08-18)

The same editing workload on three stacks: the pocket note (an unmodified
PocketJS app) on the gpui `macos-app` host with native text layout, and one
byte-identical plain-text markdown editor page shelled by Tauri v2
(WKWebView) and Electron. **Apple M3 Max, macOS 26.5.2.** Protocol: cold start =
spawn to each app's own first-painted-frame READY report, median of
3; idle = 60 s hands-off after a 20 s
settle (pcpu is a decaying average — the settle flushes launch work), `ps`
process-tree samples every 5 s, medians; storm = 120 chars/s typed for 30 s through each
app's real edit path (svc lines / `execCommand`), sampled every 1 s. Reproduce:
`bun tools/bench-desktop.ts`.

| app | procs | cold start (ms) | idle RSS (MB) | idle CPU (%) | storm CPU (%) | storm RSS (MB) | disk (MB) |
|---|---|---|---|---|---|---|---|
| pocket | 1 | 149 | 83 | 3.65 | 47.9 | 87 | 10 |
| tauri | 4 | 380 | 193 | 3.45 | 16.4 | 208 | 9 |
| electron | 5 | 301 | 382 | 0.55 | 39.6 | 487 | 242 |

Fairness notes:

- The pocket note is a **richer** editor than the web page (markdown block
  styling, selection model, undo/redo, autosave debounce) — the web side
  edits a flat `contenteditable` with no markdown rendering. The gap
  measured here is stack floor, not app complexity.
- The web editors' storm inserts through `document.execCommand` on a
  contenteditable; the pocket storm crosses the svc channel and re-wraps the
  document through `measureText`. Both are the path real typing takes in
  that stack.
- Electron disk counts the whole framework under `node_modules/electron/
  dist`; Tauri reuses the system WKWebView, so its disk is just the binary —
  same convention for pocket (host binary + bundle + pak).
- CPU is `ps pcpu` (percent of one core, decaying average) summed over the
  process tree, WebKit XPC helpers attributed to Tauri by spawn-delta.
  `footprint` physical memory is collected into the json but omitted here:
  Electron's hardened helper processes refuse task inspection without
  elevated privileges, so tree totals are not comparable — RSS is the
  uniform metric.
- The pocket storm CPU RAMPS with document length (samples in the json):
  the note re-parses and re-wraps the whole growing document through the
  QuickJS interpreter on every keystroke — an app-level O(n) the web
  editors' native contenteditable machinery does not pay.
- Idle CPU at these magnitudes is protocol-sensitive: pcpu medians for the
  pocket and Tauri editors drift ±1.5 points across runs (footprint scans,
  caffeinate assertions, thermal state), so read the STRUCTURAL number
  instead — the pocket governor receipt shows 84 repaints over 2400 idle
  ticks (~2/s, exactly the caret square wave's edges; before the square
  wave it was 88% of ticks). Electron idles lower because its caret blinks
  in the compositor, not through an app repaint.
