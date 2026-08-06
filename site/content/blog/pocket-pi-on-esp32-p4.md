<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-pi-esp32-hero.png" alt="Four screens of Pocket Pi's embedded device UI: a chat where the agent introduces itself as Pocket Pi, a chat where a five-minute schedule wake is created and shown in a NEXT WAKE panel, the workspace file browser listing memory.md and notes.txt on LittleFS, and the file viewer showing the contents of memory.md. The status bar of every screen shows live PSRAM, UI FPS, and LCD refresh telemetry." />

<p class="text-sm text-slate-500 -mt-4">Four screens of the same <code>pocket-pi-device-ui</code> crate the ESP32-P4 firmware compiles — identity, a self-created schedule, the LittleFS workspace, the file viewer — captured in the macOS simulator host, which shares the draw list, font atlases and touch hit map with the board.</p>

The [Pi coding agent](https://github.com/badlogic/pi-mono) now runs on an ESP32-P4 — not as a screen for an agent living on a server, but complete: the loop, the tools, the workspace, the schedules, and every byte of state on the board ([PR #9](https://github.com/pocket-stack/pocket-pi/pull/9)). The interesting part is not that a microcontroller can chat. It is that Pi is a TypeScript harness that assumes Node ≥ 22, and nothing like Node existed on this chip. Embedded JavaScript has always meant an *engine* — an interpreter and a language — never a *runtime* a real server-side program can boot on. [Pocket Pi](https://github.com/pocket-stack/pocket-pi) is that runtime, built in Rust around QuickJS and measured out by exactly what Pi touches.

If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real web-framework components on 2004 handhelds inside an 8 MB budget. This post is about what its engine carries when the tenant is not a UI but an agent.

## Why Pi, and why all of it

Two decisions shaped this project, and both are worth defending because the obvious alternatives are genuinely tempting.

**The whole agent runs on the device.** The default architecture for "AI hardware" is a thin client: the device renders, a server thinks. That is the easy build, and it quietly makes the device an accessory — its brain has a hosting bill, its schedules fire only while a backend exists, its files live in someone else's region. We wanted the opposite: the agent loop, the tool executor, the workspace, and the scheduler resident on the board, so that "wake up in a minute and check the file you wrote" involves no machine other than the one on the desk. Inference still comes from a model API over the network — the same dependency a laptop has — but every decision *about* the model reply, every tool call, and every persisted byte happens locally.

**The harness stays TypeScript.** The natural instinct on a microcontroller is to write the agent harness in Rust — it is already the firmware language, and an agent loop is just a loop. We had that option and declined it, for a reason that compounds over time: in a Rust harness, the agent's behavior is compiled, so a new tool composition or a revised policy is a firmware release. In Pi, behavior is data. Tools are schema'd values, extensions are factory functions, memory is a directory of Markdown. Pocket Pi's desktop profile already exploits this — extensions are TypeScript transpiled at runtime with oxc and injected through Pi's `extensionFactories` seam, so the agent can extend itself without anyone recompiling anything. QuickJS does not care whether the bundle it loads was baked at build time or written five minutes ago by the loop it hosts. An agent that can edit files can, in principle, edit itself — and that property is why porting Pi's runtime was worth more than reimplementing Pi's loop.

Pi itself earns the port: it is a deliberately minimal harness with a real extension ecosystem, and its three parts — loop, tool registry, provider transport — are cleanly separated. Nothing in that trio inherently needs Node. It just assumes Node, everywhere, casually, the way server-side JavaScript does.

## The runtime nobody had built

Microcontrollers have JavaScript engines: QuickJS, JerryScript, Espruino, Moddable XS. Each gives you ECMAScript; some give you a module system of their own. None gives you the floor a real TypeScript program stands on — Node-compatible builtins, `fetch` and streams, buffers, an event loop wired into the host's I/O, an ESM graph with dynamic loading. That gap between *an interpreter on a chip* and *a runtime that boots server-side software* is exactly the part nobody had shipped for this class of hardware.

So Pocket Pi is a runtime family, in Rust, around QuickJS — with two compositions, because we measured before choosing:

<svg viewBox="0 0 760 210" width="100%" role="img" aria-label="Bar chart of QuickJS heap requirements. Booting the full pi-coding-agent takes 46.6 megabytes, of which 27.4 megabytes is compiled JS functions. The ESP32-P4's total PSRAM is 32 megabytes, which must also hold framebuffers and Wi-Fi. One pi-agent-core conversation turn holds about 1.3 megabytes." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="210" rx="12" fill="#0b0f1a"/>
  <text x="24" y="34" fill="#94a3b8" font-size="12">QuickJS heap, measured</text>
  <text x="24" y="66" fill="#f1f5f9" font-size="12">full pi-coding-agent, boot</text>
  <rect x="24" y="74" width="640" height="18" rx="4" fill="#f87171"/>
  <rect x="24" y="74" width="376" height="18" rx="4" fill="#b91c1c"/>
  <text x="672" y="88" fill="#f87171" font-size="12">46.6 MB</text>
  <text x="30" y="87" fill="#fee2e2" font-size="10">27.4 MB compiled JS functions</text>
  <text x="24" y="122" fill="#f1f5f9" font-size="12">ESP32-P4 PSRAM, total — incl. framebuffers &amp; Wi-Fi</text>
  <rect x="24" y="130" width="439" height="18" rx="4" fill="#38bdf8"/>
  <text x="471" y="144" fill="#38bdf8" font-size="12">32 MB</text>
  <text x="24" y="178" fill="#f1f5f9" font-size="12">pi-agent-core, one turn held</text>
  <rect x="24" y="186" width="18" height="18" rx="4" fill="#34d399"/>
  <text x="50" y="200" fill="#34d399" font-size="12">~1.3 MB</text>
</svg>

The **desktop composition** runs the full, unmodified `pi-coding-agent` — sessions, extensions, the works — with no Node or Bun on the machine. Its Rust host implements the Node surface Pi's 9 MB bundle actually exercises: filesystem, `path`, `Buffer`, events, streams, `process`, synchronous subprocesses, and a global streaming `fetch`. It even rewrites indirect ESM re-exports at build time, because Pi's dependency graph contains re-export cycles that QuickJS's module loader refuses. That composition is a real Node-shaped runtime; it is also, as the chart says, a 46.6 MB tenant. The board has 32 MB.

The **embedded composition** is the same idea taken to its floor. Upstream `pi-agent-core` — the loop, the turn state, the tool-call protocol — bundles to **304 KB** and holds a conversation turn in about **1.3 MB** of heap. The Rust host under it provides only what that core touches: `TextEncoder`, a microtask pump, `URL`, a streaming model transport, and native tool dispatch. Nothing speculative. We know the list is honest because every missing item announced itself: the first on-device tool call died with `URL is not defined`.

One runtime family, two profiles, three hosts:

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="Architecture diagram. Two profile boxes at the top: crates/pocket-pi, the full desktop profile running the unmodified 9 megabyte pi-coding-agent bundle, feeding hosts/macos; and crates/pocket-pi-embedded, the embedded profile running pi-agent-core as a 304 kilobyte bundle, feeding crates/pocket-pi-device-ui, which fans out to firmware/esp32-p4 for the physical board and hosts/esp32-p4-sim for the macOS simulator." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="330" rx="12" fill="#0b0f1a"/>
  <rect x="36" y="28" width="300" height="66" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="186" y="55" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">crates/pocket-pi</text>
  <text x="186" y="76" fill="#94a3b8" font-size="11" text-anchor="middle">full pi-coding-agent · 9 MB bundle</text>
  <rect x="424" y="28" width="300" height="66" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="574" y="55" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">crates/pocket-pi-embedded</text>
  <text x="574" y="76" fill="#94a3b8" font-size="11" text-anchor="middle">pi-agent-core · 304 KB bundle</text>
  <line x1="186" y1="94" x2="186" y2="142" stroke="#475569" stroke-width="1.5"/>
  <line x1="574" y1="94" x2="574" y2="142" stroke="#475569" stroke-width="1.5"/>
  <rect x="66" y="142" width="240" height="52" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="186" y="173" fill="#f1f5f9" font-size="13" text-anchor="middle">hosts/macos</text>
  <rect x="424" y="142" width="300" height="52" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="574" y="166" fill="#f1f5f9" font-size="13" text-anchor="middle">crates/pocket-pi-device-ui</text>
  <text x="574" y="184" fill="#94a3b8" font-size="11" text-anchor="middle">one draw list · one hit map · one font set</text>
  <line x1="574" y1="194" x2="484" y2="242" stroke="#475569" stroke-width="1.5"/>
  <line x1="574" y1="194" x2="664" y2="242" stroke="#475569" stroke-width="1.5"/>
  <rect x="374" y="242" width="220" height="62" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="484" y="268" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">firmware/esp32-p4</text>
  <text x="484" y="288" fill="#94a3b8" font-size="11" text-anchor="middle">the board</text>
  <rect x="614" y="242" width="130" height="62" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="679" y="268" fill="#f1f5f9" font-size="12" text-anchor="middle">esp32-p4-sim</text>
  <text x="679" y="288" fill="#94a3b8" font-size="11" text-anchor="middle">same product, Mac</text>
  <text x="36" y="312" fill="#64748b" font-size="11">two profiles of one agent — not three forks</text>
</svg>

Pi itself is never patched in either profile, and the Pi Harness contract — the model decides when to call a tool, tools return structured results, the loop knows nothing about transports — survives intact. This is a smaller composition of the same agent, not a lookalike. The whole firmware image is 3.4 MB, 21% of the app partition.

## What the board actually runs

The target is a Waveshare ESP32-P4 dev kit: dual-core RISC-V at 400 MHz, 32 MB PSRAM, 32 MB flash, a 5-inch 720×1280 touch panel. The P4 has no radio of its own; Wi-Fi lives on an onboard ESP32-C6 across SDIO.

<svg viewBox="0 0 760 430" width="100%" role="img" aria-label="Board architecture. Inside the ESP32-P4: QuickJS runs the pi-agent-core bundle; native Rust tools provide read, write, edit, find, grep, ls, an allowlisted bash, device.status, time.now, workspace.context, and schedule operations; the PocketJS UI renders chat, files, settings, keyboard, and telemetry; an 8 megabyte LittleFS workspace persists schedules, files, and chat history. Below the streaming model boundary sit two backends: UartBackend bridging to a Mac's Codex or Claude CLI, and WirelessBackend speaking HTTPS to OpenAI, OpenRouter, or Anthropic." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="430" rx="12" fill="#0b0f1a"/>
  <rect x="24" y="22" width="712" height="252" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="44" y="48" fill="#f59e0b" font-size="12" font-weight="700">ESP32-P4</text>
  <rect x="44" y="62" width="330" height="52" rx="8" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="209" y="84" fill="#f1f5f9" font-size="12" text-anchor="middle">QuickJS — pi-agent-core</text>
  <text x="209" y="102" fill="#94a3b8" font-size="11" text-anchor="middle">304 KB bundle · ~1.3 MB heap per turn</text>
  <rect x="394" y="62" width="322" height="52" rx="8" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="555" y="84" fill="#f1f5f9" font-size="12" text-anchor="middle">PocketJS UI · 720×1280 RGB565</text>
  <text x="555" y="102" fill="#94a3b8" font-size="11" text-anchor="middle">chat · files · settings · keyboard · telemetry</text>
  <rect x="44" y="130" width="330" height="88" rx="8" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="209" y="152" fill="#f1f5f9" font-size="12" text-anchor="middle">native Rust tools</text>
  <text x="209" y="172" fill="#94a3b8" font-size="11" text-anchor="middle">read · write · edit · find · grep · ls · bash*</text>
  <text x="209" y="190" fill="#94a3b8" font-size="11" text-anchor="middle">device.status · time.now · workspace.context</text>
  <text x="209" y="208" fill="#94a3b8" font-size="11" text-anchor="middle">schedule.set / list / cancel / clear</text>
  <rect x="394" y="130" width="322" height="88" rx="8" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="555" y="152" fill="#f1f5f9" font-size="12" text-anchor="middle">LittleFS workspace — 8 MB</text>
  <text x="555" y="172" fill="#94a3b8" font-size="11" text-anchor="middle">agent files · schedule.json · chat JSONL</text>
  <text x="555" y="190" fill="#94a3b8" font-size="11" text-anchor="middle">survives reboot and power cuts</text>
  <text x="44" y="248" fill="#64748b" font-size="11">*bash is an allowlisted dispatcher — no processes, no pipes, no /bin</text>
  <line x1="380" y1="274" x2="380" y2="308" stroke="#475569" stroke-width="1.5"/>
  <text x="396" y="296" fill="#64748b" font-size="11">streaming model boundary</text>
  <line x1="380" y1="308" x2="200" y2="336" stroke="#475569" stroke-width="1.5"/>
  <line x1="380" y1="308" x2="560" y2="336" stroke="#475569" stroke-width="1.5"/>
  <rect x="60" y="336" width="280" height="66" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="200" y="362" fill="#f1f5f9" font-size="12" text-anchor="middle">UartBackend</text>
  <text x="200" y="382" fill="#94a3b8" font-size="11" text-anchor="middle">Mac bridge → Codex / Claude Code CLI</text>
  <rect x="420" y="336" width="280" height="66" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="560" y="362" fill="#f1f5f9" font-size="12" text-anchor="middle">WirelessBackend</text>
  <text x="560" y="382" fill="#94a3b8" font-size="11" text-anchor="middle">HTTPS → OpenAI / OpenRouter / Anthropic</text>
</svg>

The tools are the agent's operating system, and they are all native Rust behind Pi's schemas: six file tools on an 8 MB LittleFS partition, `device.status`, `time.now`, a `workspace.context` memory aggregator, and four `schedule.*` operations for one-off and recurring wake prompts. Schedules persist to `/workspace/.pi-agent/schedule.json`; missed wakes collapse into one catch-up run. Chat history is append-only JSONL, restored into both the UI and the model context on boot. The Pi runtime reads tool definitions from the executable registry itself, so advertised and executable tools cannot drift. And one confession: `bash` is an allowlisted dispatcher, not a shell — an ESP32 has no processes, no pipes, no `/bin`, and pretending otherwise would just teach the model to fail.

The glass is PocketJS's other contribution. The same engine that hosts the agent has a sibling crate emitting draw lists straight to the panel:

<svg viewBox="0 0 760 150" width="100%" role="img" aria-label="Render pipeline. A PocketJS draw list flows into damage regions, then the P4's PPA hardware blitter, then three RGB565 framebuffers totaling 5.5 megabytes, then two-lane MIPI-DSI scanout to the 720 by 1280 panel." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="150" rx="12" fill="#0b0f1a"/>
  <rect x="24" y="46" width="110" height="52" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="79" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">PocketJS</text>
  <text x="79" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">draw list</text>
  <line x1="134" y1="72" x2="158" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="158" y="46" width="110" height="52" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="213" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">damage</text>
  <text x="213" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">regions</text>
  <line x1="268" y1="72" x2="292" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="292" y="46" width="110" height="52" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="347" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">PPA</text>
  <text x="347" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">hardware blit</text>
  <line x1="402" y1="72" x2="426" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="426" y="46" width="130" height="52" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="491" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">3× RGB565</text>
  <text x="491" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">5.5 MB PSRAM</text>
  <line x1="556" y1="72" x2="580" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="580" y="46" width="156" height="52" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="658" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">MIPI-DSI</text>
  <text x="658" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">720×1280 panel</text>
  <text x="24" y="128" fill="#64748b" font-size="11">quiet frames are nearly free; a full redraw is 921,600 pixels</text>
</svg>

Linking the renderer cost about **24 KB of code**, and — the number we care most about — **zero PocketJS engine changes**: the port pins an unmodified upstream revision. The same UI crate also compiles into a macOS simulator (that is what the hero image shows): one draw list, one set of font atlases, one touch hit map, with mouse clicks dispatched through the same `handle_tap` as the hardware touch controller. Product flows iterate in seconds on the Mac; the board stays the acceptance target.

The model is the one thing not on the board, by design: `WirelessBackend` speaks Chat Completions and Anthropic Messages over the C6's Wi-Fi, and `UartBackend` streams through a Mac's logged-in Codex or Claude Code CLI during development. Inference is a remote dependency — same as your laptop. Everything that decides, executes, and remembers is local.

## Things that break at this size

**esbuild fought QuickJS.** Full minification produces deeply nested expressions; QuickJS parses them recursively and blew an 8 KB task stack before the agent ever ran. A later regression made QuickJS parse a 198 KB bundle for four minutes, tripping the 5-second watchdog. Fix: `minifyWhitespace` only, plus a 64 KB stack for the agent task.

**The screen kept flashing blue.** Once per second: chat → black → blue → chat. We fixed it three times. Triple buffering helped but didn't cure it; the real cause was the MIPI-DSI controller underrunning while fetching frames from PSRAM — the ESP-IDF driver source literally documents that the panel "may turn blue." Damage-region rendering cut the write traffic; dropping the pixel clock from 58 MHz to 34 MHz and enabling the PPA finished it.

**Logs and the model shared a wire.** Model transport and ESP-IDF logging both use UART0, so a five-second heartbeat log spliced itself into JSON frames — and one provisioning frame exceeded the console's ~1 KB RX buffer, truncating at byte 1026. The firmware now silences all logging after the agent's ready handshake.

**Out of memory with 30 MB free.** The first Wi-Fi transmit asserted deep in the SDIO transport — not because PSRAM was full, but because internal DMA-capable SRAM was. On this chip, allocation order is architecture: Wi-Fi before QuickJS, the JS heap steered into PSRAM, 128 KB of internal RAM reserved for DMA.

**The apostrophe incident.** With everything working, the model streamed `I'm Pocket Pi` — and the panel rendered `I?m`. The font atlases were ASCII-only, and the model uses U+2019 like any well-raised language model. The last fix of the bring-up baked curly quotes, dashes, and the ellipsis into all four atlases with the PocketJS font baker. If you want proof that a real model is talking to your firmware, typography is it.

## Proof beats vibes

The acceptance run is a 45-second recording of the board doing, in order:

1. answering `Who are you?` as a Pi agent on an ESP32-P4;
2. calling `device.status` and reporting live heap numbers — values that change between runs, so they can't be canned;
3. reading three workspace files and writing a summary it composed itself, then showing the new file in the Files browser;
4. setting a one-minute schedule and waking up on its own, untouched, to reply;
5. coming back from a hard power cut with files and schedules intact — they live in LittleFS, not RAM.

Each step closes a specific skeptic's loophole: real tool calls instead of scripted text, a filesystem that visibly changed, a wake with no hands on the device, and persistence proven by cutting power rather than by claiming it.

## The gaps, named, because that is house policy

- The board runs the embedded `pi-agent-core` profile, not the desktop `pi-coding-agent` unchanged. That distinction is load-bearing and 46.6 MB wide.
- The embedded runtime is not general Node: it implements what `pi-agent-core` exercises, and a dependency that wants more will say so at parse or boot.
- File tools and the on-device viewer handle UTF-8 text — Markdown, JSON, CSV, code. No PDFs, no images.
- `bash` is an allowlisted dispatcher, not POSIX.
- Inference is remote; the model is a provisioned network service.
- Model transport errors still render as chat text rather than a proper faulted state.

## Try it

The repo is [pocket-stack/pocket-pi](https://github.com/pocket-stack/pocket-pi). The simulator runs the same embedded agent, tool registry, and UI crate as the firmware:

```sh
cargo xtask run esp32-p4-sim --backend codex --workspace target/esp32-workspace
```

And if you have the board:

```sh
cargo xtask build esp32-p4
espflash flash --baud 921600 --port "$DEVICE_PORT" \
  firmware/esp32-p4/target/riscv32imafc-esp-espidf/release/pocket-pi-p4
python3 tools/uart-model-bridge.py "$DEVICE_PORT" --backend uart --provider codex
```

Where this goes next follows from the same property that justified the port: behavior as files. Apps as tools-plus-a-view in the agent's own workspace, revisable by the agent itself, are the obvious continuation — a post for when it is real.

The missing piece was never the agent, and it was never the chip. It was the runtime between them — and it turned out to be 304 KB of JavaScript standing on a Rust floor measured to fit. Ask the board who it is. It knows.
