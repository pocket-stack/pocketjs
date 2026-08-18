# Formal ESP network hardware-smoke artifact

This test-only component embeds one PocketJS network factory for ESP32-S3 and
ESP32-P4 hardware checks. **Both boards link the same NUL-terminated factory,
32-byte Build Plan hash, sorted feature list, endpoint tuple, and factory
SHA-256.** The component does not advertise a public capability and does not
change the stock target registry.

`app.ts` imports `fetch` from `@pocketjs/framework/net/http`. The generator
resolves a format-3 manifest and invokes the normal private network-factory
pipeline with a narrow test-only compiler permit. The permit requires the
exact plan hash, app entry, target, host ABI, feature set, HTTP backend, and ESP
transport. Normal builds, changed plans, `Headers`, `serve`, and namespace
imports remain staged.

The Guest runs 20 rounds against `http://172.16.10.126:8088`. Each round checks
`GET /health` and a binary, unknown-length streamed `POST /echo`. The requests
use the SDK's default `redirect: "follow"`, which verifies that an ordinary
`fetch(url)` reaches the native runtime without a smoke-only option override.
The factory installs the legacy `frame` slot required by the Guest host, but
**the headless runner never calls it and requires `frameCalls === 0`.**

ESP-IDF generates the artifact into the component's build directory during
configuration. To inspect the deterministic outputs without changing the
source tree, generate them into a temporary directory:

```sh
bun hosts/esp-idf/components/pocketjs_net_formal_smoke_artifact/generate.ts \
  --output-dir=/tmp/pocketjs-formal-http-artifact
bun test tests/esp-network-artifacts.test.ts
```

**Generated plans, metadata C, and factory bundles are build outputs and are
not committed.** The consolidated artifact test regenerates all HTTP and TLS
profiles in an isolated directory and locks their hashes and admission rules.

`pocketjs_net_formal_smoke_run()` is called from a dedicated non-lwIP owner
task. It creates a PSRAM-only QuickJS Guest, performs the exact formal ABI 1.1
handshake, services native work and Promise jobs with fixed budgets, snapshots
the report without accessors or eval, and completes the runtime's three-stage
shutdown. **The minimum Guest heap is 2 MiB, the recommended board setting is
4 MiB, and the minimum QuickJS stack limit is 24 KiB.** The runner exclusively
uses FreeRTOS task notification index zero while active.

Once native runtime creation succeeds, the runner does not return until the
runtime and Guest can be destroyed safely. `shutdown_warning_ms` emits a
fail-stop diagnostic but does not abandon callback-owned memory. A broken
native subsystem therefore keeps the dedicated owner task in cleanup instead
of returning with a dangling wake or permission context.

This artifact validates the formal plaintext request path, default redirect
mode admission, one-entry-per-slot connection reuse, and board scheduler
integration. Its generated metadata carries the exact backend and network
driver selection from the verified Build Plan, and the runner passes those
values into fail-closed runtime admission. It does not satisfy public HTTP
admission: redirect URL differential conformance, executable full descriptor
aggregation, complete resource accounting, DNS candidate completeness, and the
full hardware/conformance matrix remain required before the compiler or stock
target registry can expose `network.http.client`.
