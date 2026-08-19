# PocketJS on ESP-IDF

`hosts/esp-idf` is the ESP-IDF product-host half of the network stack: the
QuickJS-ng guest owner, the network modules over the portable core
(`engine/net`) and lwIP, and the board bring-up for the first two profiles.
The renderer side for ESP32-P4 lives in `hosts/esp32p4` (PPA backend).

| Component | Role |
|---|---|
| `components/pocketjs_net_core` | `engine/net` (HTTP client, HTTP server, WebSocket client cores) plus the BSD-socket driver compiled against lwIP |
| `components/pocketjs_esp_host` | QuickJS-ng guest on one owner task, fixed-rate `frame()` ticks with `begin_tick` before each, `globalThis.net` / `ws` / `httpd` bindings, a network task that services sockets under the runtime lock |
| `components/pocketjs_net_esptls` | ESP-TLS TlsProvider (ESP-TLS + the IDF certificate bundle) for `https:`/`wss:` |
| `components/pocketjs_board` | Wi-Fi station + DHCP + SNTP for the AtomS3R (native Wi-Fi) and the Tab5 (ESP32-P4 rev 1.3 + ESP32-C6 over SDIO via esp_hosted 2.12.12 / esp_wifi_remote 1.6.4, WLAN rail on the PI4IOE5V6408 @0x44 bit 0) |
| `examples/net-smoke` | Headless smoke app (`app.ts`) and the firmware template used by the hardware gate |

Toolchain: ESP-IDF v6.0.2 (`7101770dc6db`), QuickJS-ng 0.14.0 from the
component registry, Bun for the guest bundle.

## Execution model

The guest runs only inside `frame()` on the owner task. Before every
frame the owner
task calls `pnet_runtime_begin_tick()`, which freezes the visible event set;
inside `frame()` the framework service pump calls each module's `poll` once
and copies bodies out with `readInto`; Promise reactions run in the job
drain right after `frame()`. The network task never touches QuickJS: it
runs `pnet_runtime_service()` under the same mutex the bindings take, waits
in `select()` with the core's next deadline, and is woken through a
loopback UDP socket whenever the guest issued an op. DNS lookups run on the
driver's own `pnet-dns` task, never on the network task.

Tick k is scheduled at `t0 + k / tick_hz` on the microsecond timer, so a
60 Hz guest runs at **60.00 Hz** (an integer 16 ms FreeRTOS period would be
62.5 Hz and drift the virtual clock from the wall clock by 4 %). A frame that
overruns makes the next ticks late, and each late tick still gets its one
turn (Law 3); only a host more than 0.5 s behind drops ticks, counted in
`stats.frames_skipped`. Shutdown is a single unwind: `stop()` asks both
tasks to exit, bounds a guest turn in progress through the QuickJS interrupt
handler, waits for both exit flags and only then frees; a failed start
releases everything it created.

## Build Plan inputs

The firmware authors no network policy. `examples/net-smoke/pocket.json` is
a **format 3** manifest (`permissions.network`); `tools/esp-idf.ts`, run by
`main/CMakeLists.txt`, merges the rig's endpoints (Kconfig: workstation
peer, peer board, serve port, TLS host), resolves the plan against the
board's private profile (`tools/esp-idf-profile.ts`: `atoms3r-dev` /
`tab5-dev`, advertising the HTTP client (+TLS), HTTP server and WebSocket
client (+TLS) roles) and writes into the build directory:

| File | Use |
|---|---|
| `network-policy.json` | the canonical `ResolvedNetworkPolicy` (plan truth, covered by `planHash`), embedded and passed to `pnet_runtime_create` verbatim |
| `host-inputs.h` | `POCKETJS_PLAN_HASH`, target, resolved features (`POCKETJS_FEATURE_*`) — the roles `main.c` mounts |
| `app.js` | the guest bundle built against the same plan |
| `plan.json`, `pocket.resolved.json` | the plan and the merged manifest, for inspection |

`wall_clock_trusted` is a board state, not a date check: the board layer
latches it when an SNTP sync completes (`pocketjs_board_sync_time`, and every
re-sync through the SNTP notification) or when the product asserts it; until
then every verifying TLS connection fails closed with `tls_clock_untrusted`.

## Hardware smoke (plaintext)

`examples/net-smoke` against `bun tools/net-peer.ts` on the workstation and
board-to-board, both boards serving on :8080:

| Board | Result |
|---|---|
| AtomS3R (ESP32-S3-PICO-1-N8R8) | 20/20 plaintext + 6 TLS = 26/26: GET/POST/JSON/chunked/404, redirect follow+manual, 200 KB body through an 8 KiB queue at ~350 KiB/s, aggregate limit, headers timeout, permission_denied, connect refused, WebSocket echo (text/binary/ping/pong/close), peer board GET/POST/JSON/stream/404, continuous pings |
| Tab5 (ESP32-P4 rev 1.3 + C6) | 26/26, same suite, ~370 KiB/s |

The TLS block (enable `CONFIG_SMOKE_ENABLE_TLS=y`) needs internet and
an SNTP sync: HTTPS/1.1 to a public host with a valid chain from the IDF
certificate bundle, plus badssl.com's expired / wrong-host / self-signed /
untrusted-root endpoints, all failing closed. Hostname mismatch reports
`tls_hostname_mismatch`; the other certificate faults report
`tls_certificate_invalid` or `tls_handshake_failed` (ESP-TLS exposes the
Mbed TLS verify flags inconsistently on the async path) — the precise
per-fault codes are proven in the desktop OpenSSL conformance suite.

Steady state after 60 s: guest heap ≈363 KB (high water ≈686 KB during
bundle evaluation), core heap ≈4 KB, one socket per live connection, no
growth. An earlier 12-minute board-to-board soak (43,200 frames, 330 HTTP
round trips each way, both boards serving the other) ended with zero
failures and the same heap figures — it ran on the 16 ms (62.5 Hz) host, so
its "12 minutes" was the frame count ÷ 60 and about 11.5 min of wall clock;
the exact-cadence host reports 1800 frames per 30.0 s of uptime in its
periodic stats. Bundle evaluation of the 116 KB smoke IIFE: ≈780 ms on the
S3, ≈350 ms on the P4. ESP-TLS handshake steps run under the runtime lock, so
a handshake stalls the guest's `begin_tick` for up to a couple of seconds;
the overload guard shows this as `frames_skipped` during the TLS block.

## Tab5 pitfalls

- Rev 1.3 silicon needs `CONFIG_ESP32P4_SELECTS_REV_LESS_V3=y` and
  `CONFIG_ESP32P4_REV_MIN_100=y`; the default v3-only image does not boot.
- The C6 sits behind the SDIO1 preset (`CONFIG_ESP32P4_TAB5_C6_BOARD=y`:
  CLK 12, CMD 13, D0–D3 11/10/9/8, reset GPIO 15) and needs
  `CONFIG_ESP_HOSTED_SDIO_RESET_ACTIVE_HIGH=y` — GPIO15 drives EN through
  1 kΩ; the active-low default leaves the C6 held in reset (SDIO CMD5
  timeout).
- Power the WLAN rail before `esp_wifi_init()` (`pocketjs_board_prepare_wifi`).
- `CONFIG_FREERTOS_HZ=1000` keeps the hosted transport free of bus jitter warnings.
