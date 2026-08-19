# Networking

PocketJS networking is a set of explicitly imported modules: an HTTP client
and server in `@pocketjs/framework/net/http`, a WebSocket client in
`@pocketjs/framework/net/websocket`, and the shared support types in
`@pocketjs/framework/net`. Each module sits on its own spec-pinned guest
boundary (`globalThis.net`, `globalThis.httpd`, `globalThis.ws`) that a host
mounts only when it ships the capability.

```ts
import { fetch, serve, Response } from "@pocketjs/framework/net/http";
import { connect } from "@pocketjs/framework/net/websocket";
import { AbortController, NetworkError, URL } from "@pocketjs/framework/net";

const controller = new AbortController();
const response = await fetch("http://api.example.test/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Pocket" }),
  timeouts: { headersMs: 5_000 },
  signal: controller.signal,
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const items = await response.json();

const server = await serve({
  hostname: "0.0.0.0",
  port: 8080,
  fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
});

const socket = await connect("ws://broker.example.test/telemetry", {
  protocols: ["telemetry.v1"],
  socket: {
    message(socket, data) { socket.send(data); },
    close(_socket, code) { console.log("closed", code); },
  },
});
```

The objects follow the WHATWG Fetch shapes (`Headers`, `Request`,
`Response`, `RequestInit` with `method/headers/body/signal/redirect` plus the
PocketJS `timeouts/maxRedirects/tls/limits`) with two deliberate deviations:
body locking, repeat consumption and detached input fail with a
`NetworkError`, and every network, permission, timeout and resource failure
is a `NetworkError` too. HTTP status codes do not reject: a 404 resolves with
`ok === false`.

## Streaming bodies

`fetch()` resolves when the response head is visible; the body streams
through `response.body`, a `BodyStream` that supports `for await`,
`readInto(destination)` and `cancel()`. `text()`, `json()` and
`arrayBuffer()` aggregate the same stream and reject with
`response_too_large` past their cap. Bytes wait in a bounded native queue
until the application reads them; **when the queue is full the host stops
reading the socket and TCP flow control holds the peer**, so a slow reader
never grows memory past `queueBytes`. `clone()` creates a bounded tee whose
backlog never exceeds the aggregate limit — cancel the branch you do not
read.

## When results arrive

Network completions reach the guest only at frame boundaries. The host
freezes the visible set before each `frame()`, the framework's service pump
polls each module once inside `frame()`, and Promise reactions run in the
same tick's job drain. **A network round trip therefore reaches application
code within one frame period** (16.7 ms at 60 Hz), and the order of events
is the same on every host and in a replay.

## Capabilities and permissions

Importing a module grants nothing. Capabilities are split by protocol, role
and TLS — `network.http.client`, `network.http.client.tls`,
`network.http.server`, `network.websocket.client`, … — and the application
declares its endpoints in the manifest (format 3, `permissions.network`:
`connect` rules with protocol, host and port or range; `listen` rules with
address and port; `insecureTransport`; `localNetwork`). The Build Plan
resolver normalizes them into the plan's network policy, the host hands that
policy to its core verbatim, and **every command is checked against it**:
the connect rule before DNS, each resolved address after DNS, the listen rule
before bind, the endpoint rule again on every redirect. A format-2 manifest
resolves to a deny-all policy. No stock target advertises a network
capability yet; a target advertises one only when its native host ships and
tests the module.

## Errors

`NetworkError` carries a stable `code` and a derived `category`:

| Category | Codes |
| --- | --- |
| runtime | `cancelled` `timeout` `closed` `invalid_request` `invalid_state` `busy` `resource_limit` `unsupported` `permission_denied` `unavailable` |
| resolver | `dns` |
| transport | `connect` `address_in_use` |
| tls | `tls_certificate_invalid` `tls_hostname_mismatch` `tls_handshake_failed` `tls_clock_untrusted` |
| protocol | `redirect` `response_too_large` `protocol` `websocket_handshake_failed` `websocket_protocol_error` `message_too_large` |

## Limits

`getNetworkLimits()` returns a frozen snapshot of the mounted modules'
effective limits (spec ceilings tightened by the host): concurrent handles,
request-body cap, receive-queue defaults and maxima, aggregate caps,
per-tick event/byte budgets, header limits, timeouts, redirects and TLS
features. Applications choose chunk and queue sizes from it; they cannot
raise a limit.

## Where the pieces live

| Layer | Artifact |
| --- | --- |
| SDK | `framework/src/net/*` |
| Specs | `contracts/spec/net.ts`, `contracts/spec/ws.ts`, `contracts/spec/httpd.ts` |
| Reference cores | `engine/net` (portable C: HTTP client/server, WebSocket client, BSD/lwIP driver), `engine/crates/pocket-net` (Rust HTTP client core over `HttpClientBackend`) |
| Deterministic hosts | `hosts/sim/net.ts`, `hosts/sim/httpd.ts`, `hosts/sim/ws.ts` |
| Browser host | `hosts/web/net.js` |
| ESP-IDF host | `hosts/esp-idf` (AtomS3R, Tab5) |

The pinned boundaries are `contracts/spec/net.ts`, `contracts/spec/ws.ts`
and `contracts/spec/httpd.ts`; the engineering summary is `docs/NET.md`.
