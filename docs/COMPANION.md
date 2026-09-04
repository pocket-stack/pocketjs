# COMPANION module

A companion is a process on the same network that does the work a Pocket
guest must not do itself: read a file tree, query a database, fetch over
HTTP, break text into lines, build an index. The guest keeps **one thread
and one tick**. Every call to a companion is a JSON line out through the svc
mailbox and, on a later tick, a JSON line back. **There is no synchronous IO
in the guest and no call that waits on a peripheral**, so a slow disk, a lost
packet or a 100 MB corpus cannot stall a frame — the only thing the guest can
run out of is the time it chose to spend on the bytes already in memory.

```ts
import { createCompanion, createQuery, createChannel } from "@pocketjs/framework/companion";

const mac = createCompanion({ app: "vault" });
const page = createQuery<Rows>(mac, () => ["doc.rows", { id: doc(), from: first(), count: 48 }]);
const files = createChannel<FileList>(mac, "vault.files", []);
await mac.call("doc.edit", { id, line, col, insert: "x" });
```

The same model carries upward: a phone with a fast CPU can be the companion
for a watch, a laptop for a console, and later the device itself for its own
UI shell — the shell stays a thin, stall-free guest either way.

## Module ownership

| Layer | Artifact | Owns |
| --- | --- | --- |
| Spec | `contracts/spec/companion.ts` | record shapes, the limits, reply chunking, `parseLines` |
| Wire codec | `contracts/spec/svc-wire.ts` | PKNT frame encode/decode, device hello + ack, discovery beacon |
| Guest core | `framework/src/companion-core.ts` | one link: request table, chunk reassembly, subscriptions, reconnect, the per-frame pump |
| Guest SDK | `framework/src/companion.ts`, `companion.vue-vapor.ts` | Solid signals / Vue shallow refs over the core: `createCompanion`, `createQuery`, `createChannel` — the same accessor-style API under both |
| Companion library | `tools/companion-host.ts` | methods, sessions, topics, cancellation — no sockets |
| Companion transport | `tools/companion-serve.ts` | the TCP listener and UDP beacon a console's svc transport expects |
| Deterministic pair | `hosts/sim/companion.ts` | guest ops and a host session in one process, one-tick latency, for tests and sim-hosted apps |
| Capability | `svc.companion` in `contracts/spec/platforms.ts` | a host whose svc mailbox and transport are tested: `psp` (usbhostfs), `vita` (PKNT), `3ds-dev` (PKNT) |

The protocol rides **spec ops 30–32** (`svcOpen`, `svcPoll`, `svcSend`) and
so inherits every transport the mailbox already has: PKNT over TCP with UDP
beacon discovery on the 3DS and Vita (`hosts/3ds/src/svcwire.c`,
docs/SVC-VITA.md), the legacy Apple hosts' `svcwire.c`, usbhostfs on the
PSP. Nothing native changed for this module.

## Records

Guest to companion, one JSON object per line:

| Line | Meaning |
| --- | --- |
| `{"t":"hello","proto":1,"session":N,"device":"3ds-dev"}` | once per connection; `session` is fresh per guest boot |
| `{"q":ID,"m":"doc.rows","p":{…}}` | a request |
| `{"c":ID}` | the guest no longer wants the reply; the companion may stop the work |
| `{"s":"vault.files","on":1}` | subscribe (`"on":0` unsubscribes) |

Companion to guest:

| Line | Meaning |
| --- | --- |
| `{"t":"hello","proto":1,"name":"evan's Mac"}` | answers the guest hello |
| `{"r":ID,"ok":RESULT}` / `{"r":ID,"err":"…"}` | a reply that fits one line |
| `{"r":ID,"i":K,"n":N,"s":"…"}` | chunk K of N; the `s` strings concatenate to the JSON of a one-line reply body |
| `{"e":"vault.files","d":DATA}` | an event on a subscribed topic |

On the 3DS every ctrl frame is exactly one line with no newline in it; the
device rejects a payload containing one. `svcPoll` returns the queued lines
newline-terminated, whole lines only, at most `SVC_POLL_BUF` bytes.

## The limits are the architecture

- **One `svcPoll` per frame**, so the guest parses at most **8 KiB** of fresh
  text per tick. The pump does nothing else per frame: no retries, no
  timers, no second poll.
- **A line is at most `COMPANION_LINE_BYTES` (6144)**, so two fit one poll.
- **A reply is at most `COMPANION_REPLY_BYTES` (32 KiB)** after its chunks
  are joined. `encodeReplyLines` throws past it *on the companion*, where
  there is a stack trace and a log, and the guest receives an error reply
  telling it to page. A method that has more to say returns less and lets
  the guest ask for the next window.
- **Events are never chunked.** An event announces that something changed;
  the guest queries for what.
- **`COMPANION_MAX_PENDING` (64) requests may be open per link**; a live
  query holds at most one, so the cap only catches a loop.

## Queries are resources, not streams

`createQuery(companion, key)` tracks its key — a `[method, params]` tuple.
When the key changes the in-flight request is cancelled and a new one issued;
when the reply arrives it is applied only if its id is still the current one.
**A reply for a key the app has moved past never reaches the signal.** With
the default `keep: true` the previous result stays up while the next loads
(stale-while-revalidate); `loading()` and `error()` report the rest.

Because requests are idempotent by contract, **reconnection is the module's
problem, not the app's**: when the link comes back up the core re-sends the
hello, then every pending request, then every subscription. The generation
and sequence fences the earlier companions (Pocket Term, Pocket Shell) had to
hand-roll are not needed — a query that was waiting simply gets its answer
from the new connection.

Text layout is the case that motivated this. A markdown note of 100 KB is
2 000–4 000 visual rows once wrapped; the guest cannot measure that on
device inside a frame, and it does not have to. The companion has the same
Inter and JetBrains Mono files the atlas was baked from and the same
integer-advance formula (`framework/compiler/bake-font.ts`), so it breaks
lines exactly as the device would paint them and sends **rows**: a kind, a
source position, and runs of `[x, text, style]`. The guest's cost is
O(rows on screen) — never O(document).

## Writing a companion

```ts
import { createCompanionHost } from "pocketjs/tools/companion-host.ts";
import { serveCompanion } from "pocketjs/tools/companion-serve.ts";

const host = createCompanionHost({
  app: "vault",                        // the id the guest passes to svcOpen
  methods: {
    "vault.list": ({ offset, limit }) => index.list(offset, limit),
    "doc.rows": ({ id, from, count }, { signal }) => layout.rows(id, from, count),
  },
  onHello: (session, hello) => console.log(hello.device, hello.session),
});
await serveCompanion(host, { unicast: ["172.20.11.51"] });
host.publish("vault.files", { version: 7 });
```

A method may return a value or a Promise; a thrown error becomes an `err`
reply. `signal` aborts when the guest cancels. The library runs under Bun and
Node alike, so a daemon picks its runtime by its own dependencies (bun:sqlite
here, node-pty there).

`serveCompanion` binds `WIRE_PORT` (8622) or, when another companion holds
it, an ephemeral port, and beacons the bound port once a second to
broadcast, loopback and any `unicast` addresses. A device on a network that
drops broadcasts reads `sdmc:/pocketjs/host.txt` (`a.b.c.d:port`) instead.

## Declaring the dependency

```json
"engine": { "capabilities": { "requires": ["svc.companion", …] } },
"app": { "companions": ["vault"] }
```

`app.companions` is the allowlist the host matches `svcOpen` against;
`svc.companion` makes admission fail on a target with no mailbox, instead of
`svcOpen` answering false forever. `createCompanion` on such a host reports
`status() === "absent"` and never pumps.

## Testing without a device

`hosts/sim/companion.ts` joins the guest's ops to a host object in one
process and keeps the transport's one observable property: a line the
companion sends during frame N is visible to `svcPoll` only after `tick()`.
`tests/companion.test.ts` steps frames by hand and asserts the bounds: one
poll per pump under `SVC_POLL_BUF`, the reply ceiling refused where the reply
is built, a cancelled request's reply dropped, a reconnect re-sending the
hello, the pending requests and the subscriptions in that order.
