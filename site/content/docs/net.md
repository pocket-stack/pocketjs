# Networking

PocketJS provides a small, bounded HTTP client through the NET module. It is
fetch-shaped without importing the browser's complete networking stack.

```ts
import { fetch } from "@pocketjs/framework/net";

const response = await fetch("https://api.example.com/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Pocket" }),
  timeoutMs: 5_000,
  maxBytes: 64 * 1024,
});

if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();
```

The public surface includes common application methods, string and byte
request bodies, headers, a timeout, a response-size budget, and buffered
`text()`, `json()`, `bytes()` and `arrayBuffer()` reads. It deliberately omits
streams, cookies, cache, `Request`, `Headers`, `AbortSignal`, WebSocket,
servers, and raw sockets.

## Why responses are buffered

The first version resolves `fetch` only after the body is complete. The
native transport still reads chunks and stops as soon as `maxBytes` is
exceeded; the transport-neutral core checks the final size again. This keeps
the JS API and every embedded adapter small without allowing an unbounded
response into memory.

The default body budget is 128 KiB and the absolute maximum is 256 KiB. A
request body is limited to 64 KiB. Media downloads and other payloads that
fundamentally require streaming are not NET v1 use cases.

## Tick delivery and polling

Network work may happen on native threads, but those threads never call the
guest. The host drains completions at a tick boundary, then the framework
settles fetch Promises in the guest's normal turn.

There is no idle native poll. The first pending fetch registers a small
framework-neutral service pump and the final completion removes it. While
requests are pending the SDK calls `net.poll()` once per guest tick; that one
call returns the entire visible completion batch.

## What belongs where

| Layer | Artifact | Responsibility |
| --- | --- | --- |
| SDK | `framework/src/net-api.ts` | fetch-shaped guest API and Promise delivery |
| Spec | `contracts/spec/net.ts` | ops, events, limits, errors, ownership and tick contract |
| Core | `engine/crates/pocket-net` | handles, validation, bodies and a transport interface |
| Sim | `hosts/sim/net.ts` | deterministic fixture routes |
| Browser host | `hosts/web/net.js` | bounded adapter over browser fetch |
| Host adapter | the owning runtime | DNS, TLS, HTTP client library, workers and credentials |

PocketJS does not force one HTTP library on every platform. A desktop host can
adapt `ureq`, an ESP host can adapt `esp_http_client`, and an Apple host can
adapt `URLSession`. A product-specific runtime keeps that adapter in its own
repository. Only adapters for hosts owned and tested by PocketJS belong under
this repository's `hosts/` directory.

The Rust boundary is deliberately only `start`, `cancel`, and non-blocking
`drain`. The reference core supplies every portable rule around it, so
changing an HTTP library cannot change what guest code observes.

## Limits

| Resource | V1 limit |
| --- | ---: |
| Concurrent requests | 2 |
| Request body | 64 KiB |
| Response body | 128 KiB default, 256 KiB maximum |
| Headers | 32 fields / 8 KiB |
| Timeout | 30 s default, 120 s maximum |
| Redirects | 3 |

Supported methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and
`OPTIONS`. `CONNECT` and `TRACE` have tunnel, proxy, and security semantics
that do not belong in an application fetch primitive. A closed method set also
means every host can make the same guarantee.

Transport failures reject with `NetError` and a portable `code` such as
`dns`, `connect`, `tls`, `timeout`, or `response_too_large`. HTTP status codes
do not reject: a 404 response resolves with `ok === false`, like browser
fetch.
