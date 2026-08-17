# Desktop markdown editor: gpui backend vs Tauri vs Electron (2026-08-18)

The same editing workload on three stacks: the pocket note (an unmodified
PocketJS app) on the gpui `macos-app` host with native text layout, and one
byte-identical plain-text markdown editor page shelled by Tauri v2
(WKWebView) and Electron. **Apple M3 Max, macOS 26.5.2.** Protocol: cold start =
spawn to each app's own first-painted-frame READY report, median of
3; idle = 60 s hands-off, `ps` process-tree samples every
5 s, medians; storm = 120 chars/s typed for 30 s through each
app's real edit path (svc lines / `execCommand`), sampled every 1 s.
Reproduce: `bun tools/bench-desktop.ts`.

| app | procs | cold start (ms) | idle RSS (MB) | idle CPU (%) | storm CPU (%) | storm RSS (MB) | disk (MB) |
|---|---|---|---|---|---|---|---|
| pocket | 1 | 145 | 84 | 4.25 | 48.2 | 89 | 10 |
| tauri | 4 | 391 | 192 | 3 | 15.6 | 207 | 9 |
| electron | 5 | 328 | 382 | 0.55 | 38.3 | 485 | 242 |

Both web shells confirmed the full storm landed (STORM-DONE 3597/3598 of
3600 due characters); the pocket storm is tick-driven and exact by
construction.

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
  `footprint` physical memory was collected too (see the json) but is
  omitted from the table: Electron's hardened helper processes refuse task
  inspection without elevated privileges, so tree totals are not comparable
  across stacks — RSS is the uniform metric.
- The pocket storm CPU RAMPS with document length (samples in the json):
  the note re-parses and re-wraps the whole growing document through the
  QuickJS interpreter on every keystroke — an app-level O(n) the web
  editors' native contenteditable machinery does not pay (profiled:
  `JS_CallInternal` + regex backtracking dominate, not rendering or text
  measurement). Idle-in-edit-mode CPU is the app's caret blink repainting
  through the full pipeline; Electron's caret belongs to the compositor.
