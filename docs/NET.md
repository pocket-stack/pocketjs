# Networking status

**NET v1 is not a public PocketJS API.** Stock web and sim runtimes do not
install `globalThis.net`, the capability registry does not contain `net.http`,
and `@pocketjs/framework/net` no longer exports the v1 `fetch`, `NetError`, or
`PocketResponse` values.

The replacement API uses one `net` package namespace:

| Module | Current contents |
| --- | --- |
| `@pocketjs/framework/net` | Shared `NetworkError`, `URL`, abort values, limits, and types |
| `@pocketjs/framework/net/http` | HTTP client and server declarations |
| `@pocketjs/framework/net/websocket` | WebSocket client, server, and upgrade declarations |
| `@pocketjs/framework/net/mqtt` | MQTT client declarations |
| `@pocketjs/framework/net/tcp` | TCP client and listener declarations |
| `@pocketjs/framework/net/udp` | UDP socket declarations |

**Protocol I/O is staged and cannot be linked into an application yet.** Type
imports and the shared support values are available. Calls such as
`net/http.fetch()` fail with `NetworkError(code="unsupported")` outside a
PocketJS build, and the compiler rejects staged protocol values even when a
synthetic build feature is supplied. No stock target advertises a replacement
network capability yet.

## Retained NET v1 implementation

The following files remain as internal migration inputs:

| Artifact | Retained material |
| --- | --- |
| `framework/src/net-api.ts` | Bounded request validation and Promise delivery |
| `contracts/spec/net.ts` | Old operation numbers, event records, limits, and error mapping |
| `engine/crates/pocket-net` | Handle ownership, body limits, and transport completion batching |
| `hosts/web/net.js` | Browser transport fixture with bounded response reads |
| `hosts/sim/net.ts` | Deterministic fixture routes and virtual-tick completions |

These files are not package exports and stock hosts do not install them. A
migration test may import a fixture and assign its namespace explicitly; that
assignment is test setup, not runtime behavior. The retained files can be
removed after the replacement binding has equivalent tests for validation,
bounded allocation, cancellation, error normalization, and ordered delivery.

## Replacement contract

[pocketjs-network-architecture.md](./pocketjs-network-architecture.md) defines
the endpoint API, role-specific capabilities, policy resolution, private
native binding, delivery order, and hardware admission gates.

**Network threads never call QuickJS.** Native transports enqueue bounded
events. The runtime drains those events during a scheduled network service
turn on the QuickJS owner thread. The native binding remains private to the
framework; applications receive only imports from `@pocketjs/framework/net`
and its protocol subpaths.

Capability ids are added to the public registry only after a stock host
implements and tests the complete role. A client implementation does not
admit a server capability, and a board connectivity test does not by itself
admit either role.
