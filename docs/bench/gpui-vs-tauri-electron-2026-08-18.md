# Desktop markdown editor: gpui backend vs Tauri vs Electron (2026-08-18)

The same editing workload on three stacks: the pocket note (an unmodified
PocketJS app) on the gpui `macos-app` host with native text layout, and one
byte-identical plain-text markdown editor page shelled by Tauri v2
(WKWebView) and Electron. **Apple M3 Max, macOS 26.5.2.** Protocol: cold start =
spawn to each app's own first-painted-frame READY report, median of
3; idle = 60 s hands-off, `ps` process-tree samples every
5 s, medians; storm = 120 chars/s typed for 30 s through each
app's real edit path (svc lines / `execCommand`), sampled every 1 s. Reproduce:
`bun tools/bench-desktop.ts`.

| app | procs | cold start (ms) | idle RSS (MB) | idle CPU (%) | storm CPU (%) | storm RSS (MB) | disk (MB) |
|---|---|---|---|---|---|---|---|
| pocket | 1 | 128 | 84 | 2.7 | 47.6 | 87 | 10 |
| tauri | 4 | 398 | 193 | 2.25 | 16.7 | 207 | 9 |
| electron | 5 | 319 | 382 | 0.5 | 38.6 | 486 | 242 |

Both web shells confirmed the full storm landed (STORM-DONE ~3600
characters); the pocket storm is tick-driven and exact by construction.

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
  editors' native contenteditable machinery does not pay. The caret is a
  square wave demand rendering skips between edges (apps/note/
  pocket.config.ts), so idle repaints are ~2/s, not 60.
