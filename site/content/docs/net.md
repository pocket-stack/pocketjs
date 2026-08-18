# Networking

**PocketJS does not currently expose working network I/O to applications.**
The previous NET v1 API has been removed from the public package and from the
stock web and simulation runtimes. There is no `globalThis.net`, and no stock
target advertises a network capability.

The replacement modules share the `net` namespace:

| Import | Purpose |
| --- | --- |
| `@pocketjs/framework/net` | Shared errors, URL and abort values, limits, and types |
| `@pocketjs/framework/net/http` | HTTP client and server API |
| `@pocketjs/framework/net/websocket` | WebSocket client, server, and upgrade API |
| `@pocketjs/framework/net/mqtt` | MQTT client API |
| `@pocketjs/framework/net/tcp` | TCP client and listener API |
| `@pocketjs/framework/net/udp` | UDP socket API |

Shared support values and protocol types can be imported now:

```ts
import { NetworkError, URL } from "@pocketjs/framework/net";
import type { RequestInit } from "@pocketjs/framework/net/http";

const endpoint = new URL("https://api.example.com/items");
```

**Protocol functions are staged.** A PocketJS build rejects `fetch`, `serve`,
`connect`, `listen`, and `udpSocket` until the selected target supplies the
corresponding implementation and admitted capability. Calling a protocol
function outside such a binding rejects with a structured `NetworkError`.

The old root import is not supported:

```ts
// Removed NET v1 API:
// import { fetch } from "@pocketjs/framework/net";

// Replacement HTTP path once HTTP client support is admitted:
// import { fetch } from "@pocketjs/framework/net/http";
```

Native transports perform DNS, TLS, and socket work away from the QuickJS
thread. They enqueue bounded events, and the runtime delivers those events on
the QuickJS owner thread in a scheduled network service turn. Applications do
not receive a native network global.
