# bench-desktop

The desktop markdown-editor benchmark behind `bun tools/bench-desktop.ts`:
the pocket note (an unmodified PocketJS app) on the gpui `macos-app` host
(docs/BACKENDS.md) against one plain-text markdown editor page —
`shared/editor.html` — loaded **byte-identically** by a Tauri v2 shell
(`tauri/src-tauri`, WKWebView) and an Electron shell (`electron/`). Results
land in `docs/bench/gpui-vs-tauri-electron-<date>.{json,md}` with the
fairness caveats inline.

Setup (each once):

```
bun run macos note                                        # host + dist assets
cd tools/bench-desktop/electron && bun install && node node_modules/electron/install.js
cd tools/bench-desktop/tauri/src-tauri && cargo build --release
```

Then `bun tools/bench-desktop.ts` (a `--quick` mode exists for pipeline
checks; quote only full runs). The session must be unlocked — a locked
session suspends WKWebView and the runner refuses to measure one.

Protocol notes that shaped this harness:

- **READY** is each app's own first-painted-frame report: the pocket host
  prints it from its first canvas paint; the web page reports after a
  double `requestAnimationFrame` — through a POST to the runner's local
  listener, the same channel for both shells (console forwarding under
  Electron exists for manual runs).
- **WebKit XPC attribution**: WKWebView's WebContent/GPU/Networking
  processes are children of launchd, not of the Tauri binary. The runner
  snapshots `com.apple.WebKit.*` pids before each spawn and attributes the
  new ones to the app under test — without this, Tauri's CPU and memory
  read near zero.
- **The storm types through each stack's real edit path**: svc `ch` lines
  into the note's editor (markdown re-wrap through `measureText` per
  keystroke), `document.execCommand("insertText")` into the
  contenteditable. Storm CPU is dominated by guest work in both cases —
  QuickJS interpreting the note's markdown layout on one side, Blink/WebKit
  editing machinery on the other.
