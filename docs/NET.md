# Network modules

PocketJS networking is a set of explicitly imported modules over three
spec-pinned guest boundaries. Applications import from
`@pocketjs/framework/net/*`; hosts mount `globalThis.net`, `globalThis.ws`
and `globalThis.httpd`; the cores in between own the wire, the limits and
the tick-boundary delivery. The pinned boundaries live in
`contracts/spec/net.ts`, `contracts/spec/ws.ts` and `contracts/spec/httpd.ts`.

```ts
import { fetch, serve, Response } from "@pocketjs/framework/net/http";
import { connect } from "@pocketjs/framework/net/websocket";
import { AbortController, NetworkError, URL, getNetworkLimits } from "@pocketjs/framework/net";

const response = await fetch("http://api.example.test/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Pocket" }),
  timeouts: { headersMs: 5_000 },
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
for await (const chunk of response.body!) consume(chunk); // or response.json()

const server = await serve({
  hostname: "0.0.0.0",
  port: 8080,
  fetch: (request) => new Response(`hello ${new URL(request.url).pathname}`),
});

const socket = await connect("ws://broker.example.test/telemetry", {
  protocols: ["telemetry.v1"],
  socket: { message: (socket, data) => socket.send(data) },
});
```

## Modules and capabilities

| Import | Boundary | Capability | Status |
| --- | --- | --- | --- |
| `@pocketjs/framework/net` | none (support module: types, `AbortController`, `AbortSignal`, `URL`, `NetworkError`, `getNetworkLimits`) | — | delivered |
| `@pocketjs/framework/net/http` `fetch`, `Headers`, `Request`, `Response` | `globalThis.net` — `contracts/spec/net.ts` | `network.http.client` (+ `.tls`) | plaintext + TLS; C/Rust cores, sim/web/ESP-IDF hosts |
| `@pocketjs/framework/net/http` `serve` | `globalThis.httpd` — `contracts/spec/httpd.ts` | `network.http.server` (+ `.tls`) | staged contract, implemented in the C core and sim host |
| `@pocketjs/framework/net/websocket` `connect` | `globalThis.ws` — `contracts/spec/ws.ts` | `network.websocket.client` (+ `.tls`) | implemented in the C core and the sim and ESP-IDF hosts |

The capability ids are registered in `contracts/spec/platforms.ts`. **No stock
target advertises them yet**: a target appends an id only when its native host
ships and tests the module. Importing a module never grants access: every
command is checked against the application's network policy, which the
Build Plan owns (next section).

## Network policy: manifest → plan → host

The policy has one author, the application manifest, and one carrier, the
Build Plan. A **format 3** `pocket.json` (`"pocket": 3`,
`https://pocketjs.dev/schema/pocket-3.json`) declares it under
`permissions.network`:

```json
"permissions": {
  "network": {
    "connect": [
      { "protocol": "https", "host": "api.example.com", "port": 443 },
      { "protocol": "https", "host": "*.devices.example.com", "port": { "min": 8443, "max": 8443 } },
      { "protocol": "http", "host": "192.168.1.20", "port": 8080 }
    ],
    "listen": [{ "protocol": "http", "address": "0.0.0.0", "port": 8080 }],
    "credentials": ["device-cert"],
    "localNetwork": false,
    "insecureTransport": false,
    "allowInvalidTlsForDevelopment": false
  }
}
```

`contracts/spec/network-policy.ts` is the typed contract: the rule shapes, the
normalization the resolver applies (lowercase A-label hostnames, canonical IP
literals, single-port ranges collapsed, rules sorted, exact duplicates and
reversed ranges refused, `allowInvalidTlsForDevelopment` refused outside a
development build), the reference matcher, and the canonical JSON. The
resolver writes the normalized policy into `ResolvedBuildPlan.network`, so
`planHash` covers it; a format-2 manifest resolves to the deny-all policy.
`extractHostBuildInputs()` hands custom hosts `network.policyJson` (also
`POCKETJS_NETWORK_POLICY` in the host build environment) — **the exact string
a host passes to its core** (`pnet_runtime_create` in C, `NetPolicy::parse`
in Rust, the sim hosts' `policy` option). A host never authors or widens a
policy; the ESP-IDF smoke firmware embeds the projection its plan produced
(`tools/esp-idf.ts`).

Enforcement is the same in every core, and the shared vectors
(`contracts/spec/vectors/network-policy.json`, run by the TypeScript
reference, `pnet_unit_test` and the Rust tests) pin it: the connect rule and
`insecureTransport` before DNS; every resolved candidate address after DNS
(loopback, link-local, RFC 1918, CGNAT, ULA only with `localNetwork`,
multicast never); the listen rule before bind; the endpoint rule again on
every redirect hop. In the Rust core these wire-side decisions go through
the `PolicyGate` the backend receives with each request, and the core
refuses a response whose URL the gate did not authorize.

## Ownership

| Layer | Artifact | Owns |
| --- | --- | --- |
| SDK | `framework/src/net/*.ts` | Fetch-shaped objects, body locking, `BodyStream` over `readInto`, the per-module guest binding (one `poll` per tick from the service pump), Promise settlement, `NetworkError` |
| Spec | `contracts/spec/{net,ws,httpd}.ts` | op codes (append-only), event shapes, metadata JSON, portable ceilings, the shared error vocabulary; generated mirrors `engine/core/src/spec.rs` and `engine/net/include/pocketjs/net/spec.h` (drift-guarded by `tests/contract.ts`) |
| Spec vectors | `contracts/spec/vectors/*.json` | the policy and HTTP-semantics decisions (methods, core-owned headers, bodyless / null-body statuses, redirect rewrites) every implementation reproduces |
| C core | `engine/net` | HTTP/1.1 client and server, RFC 6455 client, strict framing, bounded queues, policy, tick queues (transactional `poll`), and the TLS handshake state machine; a `pnet_driver_ops` socket driver (`drivers/posix`, with its own resolver worker so `getaddrinfo` never blocks the network task) and an optional `pnet_tls_ops` TLS provider (`drivers/openssl`, ESP-TLS) are the only host interfaces |
| Rust core | `engine/crates/pocket-net` | The HTTP Client core for Rust hosts over an `HttpClientBackend` that receives a `PolicyGate` (address / redirect / TLS authority); `mount` installs the six v2 ops through rquickjs |
| Deterministic hosts | `hosts/sim/{net,ws,httpd}.ts` | fixture routes/peers/injected requests with virtual-tick visibility for the SDK tests |
| Browser host | `hosts/web/net.js` | browser `fetch` behind the v2 ops (Browser profile: no redirect following, TLS by the browser) |
| ESP-IDF host | `hosts/esp-idf` | QuickJS-ng owner task, network task, bindings, AtomS3R/Tab5 bring-up, the hardware smoke |

## TLS

TLS is an add-on capability per protocol role (`network.http.client.tls`,
`network.websocket.client.tls`, …). A host advertises the `"tls"` feature —
and `https:`/`wss:` become usable — only when it supplies a **TlsProvider**
(`pnet_tls_ops`) to `pnet_runtime_create_tls`; there is never a plaintext
fallback. The core owns the connect deadline, cancellation and the policy;
the provider owns host trust, entropy and the wire. `serverName` equals the
authorized hostname and is both the SNI sent and the DNS-ID/IP-ID the
certificate must match (TLS 1.2 minimum, renegotiation and 0-RTT off).
Before any I/O, a verifying connection fails closed with
`tls_clock_untrusted` when the platform reports the wall clock untrusted.
"Trusted" is a state the platform maintains, not a date check: the ESP-IDF
board layer latches it when an SNTP sync completes (and on every re-sync) or
when the product asserts it from a validated RTC; until then TLS fails
closed. Handshake failures map to the
four stable codes `tls_certificate_invalid`, `tls_hostname_mismatch`,
`tls_handshake_failed` and `tls_clock_untrusted`.

Providers in the tree: `engine/net/drivers/openssl` (the reference
`NativeTlsProvider` for POSIX, and the peer for the conformance suite) and
`hosts/esp-idf/components/pocketjs_net_esptls` (ESP-TLS + the IDF certificate
bundle). The desktop conformance harness (`engine/net/test/tls_test.c`)
covers a valid chain, unknown CA, expired cert, hostname mismatch, an
untrusted clock, the development-insecure refusal and a WSS echo against an
in-process OpenSSL PKI.

## Delivery

Network facts enter the guest only at frame boundaries. The host runs the
tick boundary (`pnet_runtime_begin_tick()` in C, `NetCore::begin_tick()` in
Rust, `beginFrame()` in the browser host) **before** each `frame()`; that
freezes the visible set: completed events plus one `readable` watermark per
handle with new bytes, inserted ahead of that handle's `end`. Inside
`frame()` the framework service pump calls each mounted module's `poll()`
once, and the SDK copies body bytes with `readInto` in the same call graph.
Promise reactions run in the same tick's job drain. **The upper bound for a
network round trip to reach application code is one frame period**; the
per-tick budget (`maxEventsPerTick`, `maxTickBytes`) leaves excess events
queued natively in sequence order for the next tick. `poll()` is
transactional: the core sizes and reserves the batch before it dequeues a
single event, so memory pressure can delay a batch (the next poll retries)
but never drops one — a handle's terminal `end`/`error` is never lost to an
allocation failure. Hosts that marshal the batch into a guest value use the
two-phase `*_poll_render` / `*_poll_consume` and consume only once the guest
holds its copy.

Body bytes never live in JS until read: the native receive queue
(`queueBytes`, default 32 KiB, host-tightened on MCUs) is the backpressure
window and a **hard bound** — the core reads at most the free space, and
when the queue is full it stops reading the socket so TCP flow control
holds the peer. `clone()` is a bounded tee: a branch's backlog never exceeds
the aggregate limit (each pull is sized to the remaining room). `text()`,
`json()` and `arrayBuffer()` are SDK helpers over the same path with an
aggregate cap (`response_too_large`). The browser dev host holds the same
bound through a BYOB reader where the body is a byte stream; its default
reader fallback can overshoot by one browser chunk.

## Errors

Every failure is a `NetworkError` with a stable `code` from
`contracts/spec/net.ts` and a derived `category`:

| Category | Codes |
| --- | --- |
| runtime | `cancelled` `timeout` `closed` `invalid_request` `invalid_state` `busy` `resource_limit` `unsupported` `permission_denied` `unavailable` |
| resolver | `dns` |
| transport | `connect` `address_in_use` |
| tls | `tls_certificate_invalid` `tls_hostname_mismatch` `tls_handshake_failed` `tls_clock_untrusted` |
| protocol | `redirect` `response_too_large` `protocol` `websocket_handshake_failed` `websocket_protocol_error` `message_too_large` |

Platform codes travel in `causeCode`; HTTP status of a failed WebSocket
handshake in `reasonCode`. HTTP 4xx/5xx are successful exchanges.

## Limits

Spec constants are portable ceilings; each host reports its tightened values
through `limits()` (`getNetworkLimits()` in the SDK). The ESP-IDF host
defaults to 4 HTTP handles, 16 KiB receive queues (64 KiB max), 256 KiB
aggregate default, 64 KiB per-tick bytes, 4 WebSocket sockets with 64 KiB
messages, 8 server connections / 4 inflight requests, and a 1 MiB core heap
cap; the measured smoke steady state is documented in
[hosts/esp-idf/README.md](../hosts/esp-idf/README.md).

## Headless hosts

A host without a UI still ticks `frame()`. `mountHeadless()` from
`@pocketjs/framework/headless` installs the frame transaction prefix
(virtual clock → service pumps → effect delivery → optional app hook)
without a renderer, so a display-less device runs the same network delivery
model. The ESP-IDF smoke firmware uses it.

## Testing

- `bun test tests/net.test.ts tests/net-httpd.test.ts tests/net-websocket.test.ts tests/net-web.test.js` — SDK against the deterministic hosts.
- `cmake -S engine/net -B engine/net/build && cmake --build engine/net/build && ctest --test-dir engine/net/build` — C core unit tests, the socket harness, and (when OpenSSL is present) the TLS conformance suite, all under ASan/UBSan.
- `cargo test -p pocket-net --manifest-path engine/Cargo.toml` — Rust core.
- `bun tools/net-peer.ts` + `hosts/esp-idf/examples/net-smoke` — the hardware gate against an independent peer and board-to-board.
