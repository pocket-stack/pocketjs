# Relay

Relay is the L1 session/frame and L2 resource/delivery contract shared by a
PocketJS guest and a paired companion. **It does not replace the existing
`io.offload` record format; a v1 peer is reached through explicit capability
negotiation, never by probing an existing connection.** The single source of
truth is `contracts/spec/relay.ts`. The TS codec is
`framework/src/relay/frame.ts`; the C and Rust frame layers consume the same
byte vectors under `tests/fixtures/relay/`. Every encoding value in this
document is the R5 proposal (`R5-P03` and following in the relay design
draft), not an existing PocketJS ABI.

## Fixed frame

**Every record is a 4-byte little-endian length prefix followed by a 48-byte
fixed header, one strict UTF-8 JSON metadata object, and raw data bytes.** All
integers are little-endian. `session` is a u64 and is held as a JS bigint; it
never crosses `Number`.

`frameBytes` does not count the 4-byte prefix. The length identity checked by
every receiver is:

```
frameBytes + 4 == 48 + metaBytes + dataBytes
```

| Offset | Field | Width | Rule |
| --- | --- | --- | --- |
| 0 | `frameBytes` | u32 | `44 + metaBytes + dataBytes`; validated before payload is trusted |
| 4 | `magic` | 4B | ASCII `PRLY` |
| 8 | `major` | u8 | `1` |
| 9 | `minor` | u8 | `0` in v1; one value, selected by the HELLO response and confirmed by READY |
| 10 | `type` | u8 | `1..5`, see below |
| 11 | `flags` | u8 | must be `0`; a nonzero reserved bit rejects the frame |
| 12 | `headerBytes` | u16 | must be `48` including the prefix |
| 14 | `codec` | u16 | `0` = no data; otherwise the negotiated data codec |
| 16 | `session` | u64 | nonzero after HELLO; `0` only on the bootstrap exchange |
| 24 | `seq` | u32 | starts at 1 per `(session, stream, direction)`; never wraps |
| 28 | `stream` | u32 | `0` is the control stream |
| 32 | `correlation` | u32 | request id; `>0` for REQUEST/RESPONSE/CANCEL, `0` for PUSH/INVALIDATE |
| 36 | `metaBytes` | u32 | byte length of the metadata object; no BOM or trailing LF |
| 40 | `dataBytes` | u32 | raw bytes following metadata; no padding |
| 44 | `reserved` | u32 | must be `0` |
| 48 | `metadata` | `metaBytes` | strict UTF-8 JSON object |
| 48+metaBytes | `data` | `dataBytes` | encoding selected by `codec` |

TCP input may arrive split or coalesced. `RelayRecordDecoder` keeps one fixed
assembly buffer of `maxWireBytes + 4` and validates the declared length
against that cap before more bytes accumulate, so a forged prefix cannot
drive an allocation. A missing, duplicate, or reordered `seq` stops that
stream and triggers resync; an error on stream 0 ends the session.

## Metadata

**Metadata is JSON encoded once per frame. Binary stays in the data region;
it is never base64-wrapped into metadata.** v1 metadata rules: root is an
object; duplicate keys reject; no NaN or Infinity; ordinary numbers are safe
integers (`-(2^53-1)..2^53-1`); fractional and exponent notation reject; JSON
depth is capped at 16. Parsed objects carry a null prototype, so `__proto__`
is an ordinary own key (it does not invoke the prototype setter); the strict
schemas then reject it as an unknown property, along with any other key the
schema does not declare, including names on `Object.prototype`
(`constructor`, `toString`). u64 counters and the session are 16 lowercase
hex characters; `opId` is 32 lowercase hex characters. String offsets that
refer to product source text are explicit UTF-16 units and must not split a
surrogate pair.

Common fields: `op` (required, `^[a-z][a-z0-9_.-]{0,63}$`), `resource`
(`ResourceRef`), `args`, `value`, `status`, `final`, `error`, `effect`,
`baseRevision`, `opId`, `opEpoch`, `budgetMs`, `subscription`, `transfer`,
`digest`, `depends` (at most 8). Method inputs live under `args`, results
under `value`; `resource`, `status`, `final` and `digest` stay at the top
level. Resource identity never depends on JSON key order.

`ResourceRef` is `{kind, ns, key, revision?, rendition}`. **A wire reference
is a `ResourceRef`, never a local texture or surface handle.** Bounds: `ns`
128 bytes, `key` 256 bytes, `revision` and `rendition` 128 bytes. `kind` is
one of `1 tile, 2 texture, 3 glyph-run, 4 text-layout, 5 media-chunk,
6 terminal-cells, 7 file, 8 event`; kind selects semantics, codec selects the
wire encoding.

## Five message types

| Type | Name | Correlation | Behavior |
| --- | --- | --- | --- |
| 1 | REQUEST | `>0` | one `op`; ids do not repeat within a session |
| 2 | RESPONSE | echoes request | carries `status` (`ok`/`accepted`/`error`) and boolean `final`; exactly one terminal response has `final:true` |
| 3 | PUSH | `0` | subscription or control delivery; carries `subscription` or a stream-0 control op |
| 4 | CANCEL | original request id | sent on stream 0 with `op:"request.cancel"` and `targetStream`; the provider emits one terminal response on the original stream |
| 5 | INVALIDATE | `0` | authority content invalidation or consumer cache eviction |

Control ops are metadata names, not new types: `relay.hello`, `relay.ready`,
`relay.open`, `relay.close`, `relay.ping`, `relay.credit`, `relay.reset`,
`resource.get`, `resource.subscribe`, `resource.release`,
`resource.unsubscribe`, `request.cancel`, `resource.invalidate`,
`cache.evict`, `operation.status`, `operation.epoch`.

## Error codes

A RESPONSE with `status:"error"` carries a fixed `error.code`. **The peer
selects its action from the code, not from the English `message`** (message
is capped at 160 bytes, diagnostics only):

`UNSUPPORTED`, `INVALID`, `UNAUTHORIZED`, `BUSY`, `TOO_LARGE`, `STALE_BASE`,
`NOT_FOUND`, `CANCELLED`, `DEADLINE`, `OUTCOME_UNKNOWN`, `RESYNC_REQUIRED`.

Frame parsing itself returns the separate codes in `RELAY_FRAME_ERROR`
(`BAD_MAGIC`, `BAD_FLAGS`, `BAD_LENGTH`, `BAD_METADATA`, `TOO_LARGE`-class
`WIRE_TOO_LARGE`/`META_TOO_LARGE`, and so on) before any metadata handler
runs. The codec throws nothing; `encodeFrame`/`decodeFrame` return
`{ok:false, code}`.

## Codecs

`codec` identifies the data encoding: `0` no data (`dataBytes` must be 0),
`1` one strict UTF-8 JSON value, `0x0101` packed `r5g6b5le` u16LE pixels,
`0x0102` PMH1 mesh bytes, `0x0103` `coverage2-lsb` (four 2-bit samples per
byte, low bit first, 4-aligned rows), `0x0104` `indexed8-abgr` (1024-byte
u32LE ABGR palette then indices), `0x0201` FONT v3 blob, `0x0301` opaque
bytes with declared length and digest. `0x8000..0xffff` is the negotiated
extension range; a codec outside the negotiated set rejects the frame.

Chunked data repeats the same `resource`/`codec`/`transfer.id`/`total`, with
contiguous offsets from 0; the final chunk has `final:true` and
`offset + dataBytes == total`. Overlap, gaps, and out-of-range offsets
reject. The SHA-256 `digest` is checked over the assembled bytes before the
object is published.

## Limits negotiation

**A limit is a guarantee by the receiver about what it can hold; a sender
cannot advertise a larger limit to its peer.** HELLO and OPEN exchange
per-direction `rxLimits` (`maxWireBytes`, `maxMetaBytes`, `windowFrames`,
`windowBytes`, `maxPending`, `maxObjectBytes`, `maxAssemblies`,
`maxScratchBytes`); each side adopts `min(local, peer)`. `maxWireBytes` and
`windowBytes` must each hold at least one complete frame.

v1 proposals: control frames are 4096 bytes including the 48-byte header, the
control window is 8 frames / 32768 bytes, and `maxPending` is 8. Each
direction reserves two 256-byte sideband slots for `relay.credit`,
`relay.ping`, `relay.reset`, and CANCEL, so control can advance when the
normal window is full. Bulk attachments negotiate 65536-byte frames, a
2-frame / 131072-byte window, metadata capped at 2048 bytes, and at most two
concurrent assemblers. A session allows one bulk attachment and at most eight
nonzero streams. Heartbeat is 2 seconds with a 15-second no-progress
timeout; these are timing proposals, not measured recovery latency.

Credits are cumulative counters per target stream (`framesReleased`,
`bytesReleased` as u64 hex); a release cannot exceed the frames and bytes the
peer transmitted, and a counter is valid for one session. A CANCEL or local
timeout withdraws interest but does not return request or execution capacity
until the terminal response is consumed or the session ends.

## Session state machine

The guest and provider run one shared state machine,
`framework/src/relay/session.ts` (`RelaySession`); the provider imports it
from `tools/relay-wire.ts`. The machine holds no socket. It runs on a
`RelayTransportAdapter` with three operations: bounded
`trySend(bytes) -> "accepted" | "busy" | "offline"`, ordered record delivery
through `handleRecord`, and an authenticated `peer { id, grants }`. **Peer
identity comes from the adapter; HELLO metadata is never trusted for
identity.**

The machine has six phases: `idle`, `hello-sent`, `hello-received`,
`ready-sent`, `ready`, `closed`.

1. The guest sends REQUEST `relay.hello` on session 0 with `seq:1`,
   `correlation:1`, a 16-byte `bootNonce` (32 hex chars), its supported
   versions, profiles, codecs, kinds and `rxLimits`. The frame is at most
   4096 wire bytes.
2. The provider answers on session 0 with a random nonzero u64 `session`,
   its `peerNonce`, the echoed `bootNonce`, one exact selected `[major,
   minor]` version, the profile, codec and kind intersections, its grants,
   and `rxLimits` computed field by field as `min(local, peer)`. With no
   version/profile/kind intersection, or an app outside the adapter grants,
   it returns a final RESPONSE with `status:"error"` and an `error.code`
   (`UNSUPPORTED` or `UNAUTHORIZED`) and closes. The response carries the
   kind intersection in a required `kinds` field and the codec intersection
   in an optional `codecs` field (the field table lists the intersection
   rule; the step-3 response list omits both fields). **A guest that
   receives no `kinds` closes the session as `UNSUPPORTED`**; a guest that
   receives no `codecs` records the codec set `[0]`; a set naming a codec or
   kind the guest did not offer tears the session down.
3. The guest sends REQUEST `relay.ready` on the new session confirming the
   selected version; the provider acks and both sides enter `ready`. Each
   direction's seq restarts at 1 on the new session.
4. REQUEST `relay.open` on stream 0 makes the provider allocate a nonzero
   stream id (1..8) for an app/namespace/profile binding. Stream ids are
   never reused inside the session; each stream's two directions keep
   independent seq counters starting at 1.
5. Business frames are admitted in `ready` on opened streams only. Frames
   that arrive before `ready`, on an unknown stream, or with a session that
   is not the pinned session are dropped; frames with an unknown op on
   stream 0 end the session. Installing an OPEN binding resets that stream's
   two seq counters, so an early frame on an id that OPEN later allocates
   cannot desync the new stream. `relay.reset` applies to a business stream;
   `targetStream: 0` is refused (the schema minimum is 1 and the handler
   drops it) so a forged reset cannot wipe the control-stream seq space.
6. REQUEST/RESPONSE `relay.ping` carries a u32 token echoed without clock
   interpretation. A ping is sent every 2 seconds with at most one
   outstanding; 15 seconds without an inbound frame ends the session; a
   `busy` send retries after 1.5 seconds. **The outstanding token is
   recorded before the ping frame enters `trySend`**, so a pong that a
   synchronous adapter delivers inside the send matches it; a refused send
   clears the slot again.

**A reconnect or a guest realm reset is a new session: the machine discards
the session id, negotiation, every stream binding, every seq counter and
correlation counter, and restarts at `idle`.** Frames that name a prior
session fail the frame codec's session pin and are dropped as stale without
reaching the business callback; they do not tear down the current session.

seq allocation follows the header rule: a number is consumed when the frame
enters the ordered send stream, so a `busy` or failed send leaves the counter
where it was. On receive, seq must be exactly previous+1 per
`(session, stream)`; a gap or duplicate on stream 0 ends the session, and on
a business stream invokes the `onStreamError` resync hook.

Resource delivery is not in this layer. The composed endpoint
(`RelayEndpoint`, below) takes every post-bootstrap control frame through
the `admitControl` hook, business frames with their wire length through
`onBusinessFrame`, consumed stream-0 records through `onControlFrame`,
`relay.credit`, `relay.reset` and CANCEL through `onCredit`/`onReset`/
`onCancel`, stream bindings through `onStreamOpened`, and OPEN
authorization through `authorizeOpen`. `sendBusiness` is the bare P2 path;
a machine with `admitControl` set refuses it with `COMPOSED`.

`tools/relay-wire.ts` binds a composed endpoint to a byte channel:
`attachRelayProvider` (one connection; constructs the provider endpoint and
exposes it as `connection.endpoint`), `attachRelayChannel` (guest side;
takes an endpoint or a bare session), `relaySocketChannel` (node `net`,
with `onDrain` so a busy channel resumes the outbox), and `serveRelayTcp`,
which takes an `authenticate(socket)` callback returning the peer grants
and per-connection hooks. Records are reassembled by `RelayRecordDecoder`
before they reach the endpoint, a record over the advertised bound
destroys the connection without allocating, and a protocol teardown
destroys the socket.

**`RelayByteChannel.send` is an admission decision: it returns `false` only
when the frame was not taken.** A node `socket.write()` that returns `false`
has queued the bytes and flushes them later, so
`relaySocketChannel` checks `writableLength + frameSize` against
`writableHighWaterMark` before writing (`socketCanAdmit`) and returns
`busy` without writing; a frame on an empty queue that alone reaches the
mark is written, after which sends are busy until the queue drains.
Reporting a queued frame as busy would make the session roll its seq back
and reuse it on the retry, putting a duplicate seq on the wire.

## Queues, credit, priority and CANCEL

The send side (`framework/src/relay/credit.ts`) keeps two capacities separate:
the wire window (`windowFrames`/`windowBytes`, frames sent but not released)
and admitted work (`maxPending`, originated requests). The implementation is
`RelayCreditLedger`, `RelaySender`, `RelaySideband`, `RelayCreditTable`,
`RelayReceiver`, and `RelayRequestTable`.

**`seq` exists only after a frame is selected and its wire credit is
charged.** Work admitted before that point has no seq. Frames of one stream
leave the sender FIFO; a frame never reorders inside its stream.

- **Admission is bounded before any work starts.** A frame enters a stream
  queue only when `in-flight + queued + new ≤ slice` for both frames and
  bytes; otherwise admission returns `BUSY` and the caller keeps the demand.
  Per-stream slices sum with the stream-0 control slice to at most the
  attachment window. The transport stops reading when the receiver cannot
  hold the next frame; no frame is discarded. A frame past the granted
  window is a protocol error (`WINDOW_OVERFLOW`).
- **Selection order is priority band then round-robin.** Band 0 is
  management/input, band 1 is currently visible resources, band 2 is
  prefetch. Streams at equal priority alternate. A head blocked on byte
  credit is skipped in favor of a smaller head on another stream; it keeps
  its FIFO position. A pump moves at most `framesPerPump`/`bytesPerPump`
  normal frames (a guest submits at most two per host frame).
- **The sideband is a separate two-slot, 256-byte-per-slot lane in each
  direction** for `relay.credit`, `relay.ping`/pong, `relay.reset`, and
  CANCEL only. The send side admits and drains them through `RelaySideband`;
  the receive side classifies a decoded record with `isSidebandFrame()`,
  gates reads on `canIngestSideband()`, stages it in its own two-slot lane,
  and delivers it through `pumpSideband()`. `sidebandAdmission()` answers
  `stage`, `wait` (both slots held: stop reading) or `fatal` (over the
  256-byte slot, or stream 0 dead); the boolean gate is false for `wait`
  and for a dead session only, so an over-slot record is read and
  `ingestSideband()` ends the session with it. Sideband frames take stream-0
  seq from the same per-stream counter as ordinary stream-0 management
  frames, so dropping or filtering one opens a fatal seq hole; they consume
  no normal window and earn no credit, so taking one from the sideband pump
  frees its reserved slot without a `release()` call. The lane stays
  readable while both normal control slots are held. A whitelisted record
  routed through the normal receive path returns `SIDEBAND_FORBIDDEN`; a
  record the receiver cannot fit in the two reserved slots, or one over
  256 bytes, is a stream-0 protocol error, since the adapter must hold
  every granted sideband record, and after a stream-0 fatal neither lane
  delivers and nothing ingests. The two lanes deliver independently: a
  staged control leaves the sideband pump while an older normal stream-0
  frame is staged (the lane exists to pass a stalled normal lane); the
  composed endpoint dispatches stream 0 in arrival order without the
  receiver's lanes. Sideband frames are selected before normal work on
  send. Outbound releases merge into at most nine credit rows (stream 0
  plus eight nonzero streams).
- **Credit returns at one point:** after the receiver consumes a staged
  frame or moves it into a reserved assembler/result mailbox. Reading a
  frame or parsing its header returns no credit. `relay.credit` carries
  cumulative counters; values that move backwards or exceed what the
  receiver sent are a protocol error; repeating the same values is a
  no-op.
- **Receive seq is contiguous per stream starting at 1.** A hole or repeat
  stops that stream (`SEQ_GAP`) until resync; a seq error on stream 0 ends
  the session. A receiver reset discards staging and delivered-unreleased
  frames and returns their credit; the stream id can never be reopened, and
  the stream's window slice returns to the attachment for a later OPEN.
- **CANCEL rides stream 0** with `op:"request.cancel"`, the original
  request correlation, and `targetStream`. The provider emits exactly one
  terminal response on the original stream: if the result was in flight
  before the cancel arrived the success terminal stands; if the cancel
  finished first the
  terminal is `error.code=CANCELLED` with `effect:"none"`. A repeated
  terminal is rejected (`ALREADY_TERMINAL`), a repeated CANCEL produces no
  second terminal. Cancelling, timing out, or unmounting a view does not
  free a pending slot or wire credit: the request slot frees when the one
  terminal is consumed, and the wire slot frees through the returned
  credit. The canceler keeps consuming late chunks — they pass seq and
  credit accounting, return credit, and are dropped without delivery.
- **`relay.reset`** fails every request and subscription on the target
  stream, queues and seq state clear, and later work requires a new stream
  id. In-flight frames settle through credit accounting.

## Composed endpoint

`framework/src/relay/endpoint.ts` (`RelayEndpoint`) runs the three layers as
one object over one transport, for both roles. `tools/relay-wire.ts`
constructs a provider endpoint per connection; a device host constructs a
guest endpoint over its byte channel. **The session, the P3 sender and
receiver, the request table and the L2 client or authority are built when
the session is pinned and dropped when it ends; a reconnect starts a fresh
set with seq, credit and correlation at their initial values.**

Send path: the L2 client's request, advisory and cancel calls, the
authority's terminals, chunks, pushes and invalidations, and the session's
own control frames after the bootstrap (READY, OPEN, PING and pong) enter
`RelaySender.admit` (READY and OPEN as ordinary stream-0 work in the control
band, ping and pong on the sideband). `flush()` pumps the sender until the
window or the queues are empty; frames stamped with a seq that a busy
transport did not take wait in one ordered outbox, whose size is one pump
batch plus the bootstrap frame, and leave in order when the channel drains.
HELLO and its response ride session 0 from the session to the outbox
without a sender queue and consume no window.

Receive path: `RelaySession.handleRecord` decodes, pins the session and
checks the per-stream seq; a business frame on an opened stream goes to
`RelayReceiver.ingest` (window occupancy, the association for late drops),
`pumpReceive()` delivers staged frames one receiver pump at a time to the
client or authority, and the delivered frame is released, which is where
its wire credit returns; the sender's next pump carries the cumulative
`relay.credit` on the sideband. A stream-0 record the session consumed
itself (READY, OPEN and their responses) returns its control-slice credit
the same way; sideband records earn none. A frame past the granted window
(`WINDOW_OVERFLOW`), a `relay.credit` out of range or a dead send pump
closes the session; a seq hole on a business stream resets that stream on
both ends.

**Window slices are computed by the same rule on both ends.** Stream 0
takes a quarter of the negotiated attachment window, capped by the §3.9
control proposal. A newly opened stream takes the OPEN response's
`windowFrames`/`windowBytes`, capped by what the attachment has left after
stream 0 and the live streams opened before it; both ends see the same
OPEN responses and resets in the same order. A reset stream returns its
slice: its id never reopens, the receiver holds none of its frames, and a
later OPEN takes the capacity.

**Demand is bounded by admitted work.** A guest request the window cannot
admit is refused `BUSY` before any frame leaves and the request slot
returns; the caller keeps the demand. The provider's prepared envelopes
wait in a per-stream FIFO until credit admits them; every entry belongs to
one accepted request or one active subscription. The request table is the
negotiated `maxPending` on both ends: the guest holds a slot until the one
terminal is consumed, the provider until the terminal enters the send
queue. The guest draws request ids from the session's one correlation
space, so OPEN, PING and resource requests never share an id.

The guest surface is `hello()`, `open()`, `get()`, `subscribe()`,
`unsubscribe()`, `release()`, `reportEvict()` and `cancel()`; the current
session's `RelayResourceClient` is `endpoint.client`. The provider answers
`resource.get` through the `onGet` hook with `replyObject()` (admission
against `accept`/`maxObjectBytes`, chunking under the negotiated limits),
`replyNotModified()` or `replyError()`; subscribe, unsubscribe and release
are answered by the authority; `pushObject()` and `invalidate()` publish;
`onCancel` reports an inbound CANCEL with the request's `cancelRequested`
flag, and `onEvict` an advisory. A `cache.evict` advisory rides the stream
bound to the resource's namespace, as an authority INVALIDATE does; stream
0 carries control ops only.

`tests/relay-endpoint.test.ts` drives two endpoints over an in-memory
transport (microtask-queued and synchronous delivery): get, conditional
get, subscribe, push, invalidate, unsubscribe, evict, ping, a two-frame
window with a six-chunk object, `maxPending` admission, a malformed
terminal, CANCEL, a busy transport, a seq-hole reset and a credit fault,
with the ledgers, request tables, assembler and cache asserted on both
ends. `tests/relay-wire.test.ts` runs a guest endpoint against
`serveRelayTcp` over a loopback socket.

## Resource identity

`ResourceRef` is `{kind, ns, key, revision?, rendition}`. The wire identity
tuple named in draft §3.5 is `(authenticatedAuthority, ns, kind, key,
revision, rendition)`; the authority is the pinned session/namespace grant, so
it is not repeated in a local key. `revision` is opaque: a get may omit it to
request the current revision, and every response or push carries the concrete
value. **`rendition` binds codec, dimensions, density, style and font bytes;
a source hash alone is not a rendition identity.** A wire reference never
carries a local texture or surface handle.

**The local fence/entry key omits `revision`: it is `(kind, ns, key,
rendition)`, and the concrete revision is compared separately.** A get that
omits revision and its response naming a concrete revision must hit one
generation counter, or a key-scope invalidate could not fence the in-flight
get (draft §3.8 makes a key/namespace invalidate move the generation of
*every* revision, which a per-revision counter cannot express). Key and
namespace scope advance that one revision-free generation and mark the
resident value stale; revision scope compares the concrete revision, removes
only the matching resident entry, and records the invalidated revision on an
in-flight get so a late response naming that revision is dropped with
`RESYNC_REQUIRED` while a response for a newer revision is delivered.
**One invalidate advances the generation of a matching identity once,
whatever the number of resident entries and in-flight gets it matches, and
the counter never decreases**: the map of generations is the single counter,
a get captures it at request time, and a resident entry mirrors it. The
resident cache holds the current concrete revision under the revision-less
key; publishing a newer revision replaces it at a frame boundary.

**Draft errata (§3.5 cache key).** The draft lists `revision` inside the
cache-key tuple, permits a revisionless get, and requires a key-scope
invalidate to move every revision. The three statements do not
share one key: a literal per-revision key gives the revisionless get and its
concrete response two unrelated counters. The implementation keeps
`revision` in the *wire* identity tuple and on every entry/response, but
excludes it from the *local generation-fence* key, comparing it separately.
This is a reconciliation of the three clauses, not a second identity scheme.

The L2 state machines live in `framework/src/relay/resource.ts`
(`RelayResourceClient` on the consumer, `RelayResourceAuthority` on the
provider) above a transport-neutral `RelayResourceWire` seam. L2 never
assigns a session or a wire seq; it works on metadata plus an optional data
region. Strict op metadata is checked by `framework/src/relay/metadata.ts`
against the schemas in `contracts/spec/relay.ts`.

## get, subscribe, release

- **resource.get** sends `args.accept` (negotiated codec ids) and
  `args.maxObjectBytes`. A conditional get adds `ifRevision`; a match comes
  back `status:"ok", final:true, value:{notModified:true}` with the concrete
  revision named on the resource. An object larger than
  `maxObjectBytes` is `TOO_LARGE`; a request that cannot enter the bounded
  window or the local assembly budget is `BUSY` and the caller retries on a
  later frame. **A response that fails its op schema, names another op
  than the request, or is an error without a valid body ends the request
  as `INVALID` on the consumer and releases its pending entry and assembler
  reservation, whatever its `final` flag**; a later well-formed frame for
  that correlation is consumed and dropped as late, so two malformed
  terminals cannot hold the bounded assembly budget. Error responses have
  their own schemas (`resource.get.error` and the subscribe, unsubscribe
  and release twins): `op`, `status:"error"`, `final:true`, the error body,
  an optional `resource` (a get error names the requested resource when the
  request was valid) and `effect` on a CANCELLED terminal. A chunked
  object's `value` is published with its bytes from the final chunk.
- **resource.subscribe** selects `delivery:"reliable-delta"` or
  `"latest-snapshot"`. The terminal response carries
  `value.subscription`, a session-scoped u32 that is never reused after
  unsubscribe, and the revision named on its `resource` is the base the
  subscription holds; the request's revision is a starting hint (§3.6). A
  reliable delta carries a top-level `baseRevision` and
  applies only when the base equals the held revision; a mismatch sets
  `resyncRequired` and does not guess the base, and a delta alone never
  advances the held revision or clears the flag. **Recovery is a full
  snapshot — a push with no `baseRevision`: it re-establishes the held
  revision on any revision and clears `resyncRequired`, so the next matching
  delta applies; the object at the resync boundary is delivered marked
  `resyncRequired`.** A latest-snapshot re-delivery of the held revision is
  idempotent. resource.unsubscribe terminates the subscription; pushes on
  the wire before the unsubscribe are consumed and dropped. **The push channel is
  admitted reserve-then-accept: a subscribe is refused `BUSY` before it is
  sent when the assembly budget cannot hold `maxObjectBytes`, and a
  reservation that fails when the terminal response arrives sends
  `resource.unsubscribe` for the id the provider allocated**, completes the
  subscribe with that error and calls `onEnd` once, so the provider does not
  keep an active subscription that no local channel can assemble. A
  withdrawal the request window refuses is retried on the next incoming
  frame and dropped by a stream reset, which ends the provider side as well.
- **resource.release** ends an explicit provider `lease:u32` on remote
  residence. Local cache disposal is a different operation.

## Chunked transfer and atomic publication

Chunking uses bounded assembly (`framework/src/relay/assembler.ts`).
**Admission is reserve-then-accept: the consumer reserves one assembly slot
and up to `maxObjectBytes` before the request is admitted; the first chunk
commits the real total, which must not exceed the reservation.** Chunks
repeat `resource`/`codec`/`transfer.id`/`total`/`digest`; offsets run
contiguously from 0, and the final chunk carries `final:true` with
`offset + dataBytes == total`. A gap, overlap, identity change, transfer-id
reuse or over-range offset rejects the assembly as `INVALID` and drops its
scratch. **Transfer ids increase along a channel: the authority allocates
them from one monotonic session counter and a channel's frames arrive in
send order, so an id at or below the previous completed object's id is a
reuse and rejects as `INVALID`** with O(1) state. Identity comparisons and
the local cache key are JSON encodings of the field tuple, so a `|` or any
other character inside `ns`/`key`/`rendition` cannot alias two identities.
**The authority's chunker sizes every chunk against both negotiated
receiver limits: metadata within `maxMetaBytes`, header plus metadata plus
data within `maxWireBytes`.** Metadata does not depend on the chunk
(fixed-width hex offsets; `final` differs by one byte), so an object whose
metadata exceeds either ceiling is refused as `TOO_LARGE` before any frame
is built and the request is answered with that error. **An assembly key is
`(stream, id-space, id)`: RESPONSE deliveries
use the get correlation space and PUSH deliveries the subscription id space.
The two allocators start at 1 independently, so a get correlation 1 and
subscription id 1 coexist on one stream and never collide.** The SHA-256
`digest` is verified over the assembled bytes
(`framework/src/relay/sha256.ts`, a pure-TS hash because the QuickJS guest
has no node:crypto or WebCrypto). The assembled object is returned once,
after the digest passes; **a half object never reaches the cache or a
subscriber.**

## Residence budget, invalidation and eviction

Residence integrates with the existing `framework/src/resource-cache.ts`
scheduler through `createRelayResourceLoad`: the collection reserves cost
before `load()` starts, a `BUSY` admission declines the start for a later
frame, and a terminal error fails the entry like any loader. In-flight
assembly scratch (`maxAssemblies`, `maxScratchBytes`) is separate from the
resident reservation; both are receiver guarantees negotiated in
`rxLimits`.

**A conditional get that comes back `notModified` does not replace the
resident value.** The loader completes with a `revalidated` result: the
cache keeps the existing `ready` bytes, runs neither `materialize` nor
`dispose`, and refreshes the entry age, so a §3.8 TTL revalidate cannot turn
a resident tile into an empty value. A `revalidated` result delivered while
no value is resident fails the entry.

Two distinct operations use the INVALIDATE frame type:

- **resource.invalidate** is authority-to-consumer and reliable, with
  `scope:"revision" | "key" | "namespace"`. Key/namespace scope advance the
  revision-free local generation and retain the value marked stale; revision
  scope removes only the resident entry whose concrete revision matches and
  records that revision on an in-flight get. A late get response stamped
  with an older generation, or naming a revision invalidated in flight, is
  dropped with `RESYNC_REQUIRED`; a response for a newer revision is
  delivered. **The marker store is bounded: one in-flight get keeps at most 8
  distinct invalidated revisions, and the ninth distinct revision replaces
  them with a fence over the whole get**, so a marker is never dropped for
  lack of room (draft §3.8) and a burst of invalidates costs one re-fetch,
  never a stale publication; a repeated revision is one marker, and the
  escalation touches neither the resident entry nor other in-flight gets. A
  subscription in scope is marked for resync. **A generation marker exists
  while a resident entry mirrors it or an in-flight get captured it and is
  dropped with the last of them**, so the marker map is bounded by entries
  plus pending gets; the fence compares a captured value with the current
  one, and with neither an entry nor a pending get the absolute value
  carries no information.
- **cache.evict** is consumer-to-provider advisory only
  (`reason:"budget" | "view-close"`). It states that the consumer no longer
  holds a copy; **the provider may ignore it and there is no ACK.** Remote
  lease teardown uses resource.release.

## C frame layer

`hosts/shared/relay_frame.h` and `relay_frame.c` decode the fixed header on a
C host. **The C layer checks the header fields, the §3.6 CANCEL stream rule
(header stream 0), the length identity, the negotiated
`maxWireBytes`/`maxMetaBytes`/codec set, and UTF-8 over the metadata region;
it does not parse JSON.** Metadata reaches the caller as a
pointer into the caller's record, so JSON structure and semantics (root
object, duplicate keys, number grammar, surrogate escapes) and the envelope
rules (`BAD_ENVELOPE`) are decided by the layer above. Of the 48 shared
vectors the C layer decides 43 with the same code as the TypeScript codec and
hands the other 5 through as well formed frames.

Declared lengths widen to `uint64_t` before they are summed or compared, so a
`frameBytes` near the top of u32 cannot wrap past a check, and the limit test
runs before the declared payload size is trusted. Wire integers are read byte
by byte, which holds on a big-endian host and needs no aligned access. The
code is C11 plus the C standard library: **no POSIX function is called**, in
the library or in the test harness.

`RelayFrameQueue` has the shape of `OffloadQueue` in
`hosts/shared/offload_queue.h` — single producer, single consumer, fixed
slots, no waiting — with the admission rules of R5 §3.9. A full queue answers
busy; it never drops or overwrites a frame it holds. Slot occupancy and
window bytes are two counters: `relay_frame_queue_pop` frees the slot, while
the bytes stay charged until `relay_frame_queue_release` moves the frame into
reserved storage. Admission counts the incoming frame (`queued + length <=
window`), so a backlog that fills the window cannot be extended.
`relay_frame_admit` validates a record before it enqueues it.

## Frame tape (record and replay)

**The frame tape records one session's complete wire records for debugging
and conformance replay. Recording is off by default (R5 Q7) and is turned on
per transport.** The implementation is `framework/src/relay/tape.ts`; the sim
host hook is `hosts/sim/relay-tape.ts`.

The tape is a JSON document:

```json
{"kind":"relay-frame","v":1,"session":"0102030405060708","frames":[["out",3,"…hex…","…64 hex chars…"]]}
```

**Each entry is a four-element tuple `[direction, seq, frameHex, sha256Hex]`
in capture order.** `direction` is `"out"` (sent) or `"in"` (received);
`seq` is read from the 48-byte header so a divergence report names the seq
when the header bytes themselves are wrong; `frameHex` is the complete wire
record including the 4-byte length prefix; `sha256Hex` is the SHA-256 of
those bytes, computed by a dependency-free implementation in `tape.ts` (the
module runs inside QuickJS guests and does not use `node:crypto`). The tape
stores no timestamps, labels, session/stream columns, or parsed metadata;
the wire record carries those fields. `session` is the u64 header
value as 16 hex chars and every entry must carry it; `"0000…0"` is accepted
only for a bootstrap HELLO exchange. This format is not the input tape
(`framework/src/devtools.ts`, versions 1..3, `{v, app, masks, …}`); a frame
tape carries `kind: "relay-frame"` and the parser rejects an input tape.

`wrapRelayTransport(inner, { enabled: true, session })` wraps a
complete-record transport and copies every `send`/`recv` record through a
`RelayFrameRecorder`. **With recording off, `wrapRelayTransport` returns the
inner transport object itself**, so the disabled path has no wrapper frame
and no hash work; the recorder's counters stay at 0. `toTape()` serializes
the entries, and `parseFrameTape` shape-validates the JSON back.

**Recording sits off the live path.** `send(frame)` calls the inner
transport first and hands the frame to the recorder after that call
returns. `recv()` calls the inner transport, hands a non-null result to
the recorder, and returns that result; an inner `null` or `undefined`
result is returned as `null` and records nothing. The recorder's
`observe()` entry point does not throw, so a recorder rejection cannot
withhold a frame the transport has produced. A frame the recorder
rejects (a session other than the pinned one, a zero seq, or the
`maxFrames` cap) is sent or returned, and an error thrown by the inner
transport propagates without recording the frame. The first rejected frame
latches an `incomplete: {index, reason}` field onto the tape, and
no later frame is appended: the stored tuples stay a clean single-session
prefix ending at `index`. R5 §3.11 record mode requires partial record
loss to mark the trace incomplete rather than break the live session.
`verifyFrameTape` returns a `tape-incomplete` divergence for such a
document, and `createRelayFrameReplay` refuses to build a replay from it;
R5 §3.11 bars deterministic replay of a trace with gaps. The recorder
exposes the strict `note()`/`noteOut()`/`noteIn()` entry points that throw
on the same rules, and the non-throwing `observe()` entry point the
transport wrapper uses.

The §3.2 bootstrap reaches the session-pin rule in ordinary use: HELLO
carries session 0 and the first frame on the assigned session carries a
different session value. A recorder created without `{ session }` pins
the tape to the session of its first recorded frame, here the bootstrap
session 0, and rejects every later frame from another session; the
assigned-session frames reach the peer and mark the trace incomplete at
the first of them. A recorder pinned to the assigned session that wraps
the transport from HELLO rejects the HELLO frame at index 0 and has no
serializable tape (`toTape()` throws). To capture a full post-bootstrap
session, wrap the transport after READY; a `{ session }` pin on that
recorder marks the trace incomplete at the first frame from any other
session.

Replay uses a fake transport from `createRelayFrameReplay`: `recv()` returns
the next recorded inbound record in capture order and `send(frame)` hashes
the produced outbound record against the stored digest. **The first frame
whose sha256 disagrees, whose direction disagrees, or that does not parse as
one complete PRLY record latches a divergence carrying tuple index and seq;
later frames do not clear it** — the `--assert` semantics of
`tools/tape.ts`, which names the first divergent frame. A run is OK only
when every tuple is consumed. Missing and extra frames report
`incomplete` and `unexpected`. `verifyFrameTape(tape)` checks a stored tape
without a session stack. **Verification and replay apply one rule set per
tuple: the header session is the document session, the tuple seq is the
header seq, and within one (direction, stream) seq increases in capture
order** (`order` divergence; contiguity is not required, since a tape
wrapped after READY starts above 1). A tape with no frames verifies as
`empty` and cannot be replayed.

The sim hook mounts through `bootWorld`'s `extraGlobals` at the
`relayTape` slot, alongside `db`/`fs`/`audio`:

```ts
const hook = createSimRelayTapeHook({ enabled: true, session });
const transport = hook.wrap(inner);
hook.save((text) => writeFileSync(path, text));
const { replay } = loadSimRelayReplay(readFileSync(path, "utf8"));
```

## Tests and vectors

The cross-language vectors are generated, not hand-edited:

```sh
bun tests/fixtures/relay/generate.ts   # rewrites vectors/*.bin + constants.json
bun test tests/relay-frame.test.ts     # byte vectors, codec, reassembly
bun test tests/relay-session.test.ts   # handshake/negotiation/session/ping
bun test tests/relay-wire.test.ts      # provider over a TCP loopback
bun test tests/relay-credit.test.ts    # queues/credit/priority/CANCEL
bun test tests/relay-resource.test.ts  # L2 get/subscribe/chunks/budget/invalidate
bun test tests/relay-endpoint.test.ts  # composed endpoint, guest <-> provider
bun test tests/relay-frame-c.test.ts  # compiles the C layer, feeds it the vectors
bun test tests/relay-tape.test.ts tests/relay-sim-tape.test.ts
bun tests/contract.ts
```

`tests/fixtures/relay/vectors/*.bin` are complete wire records with a paired
`.json` giving the expected decode result or the exact frame error code. The
nine `example-*` vectors reproduce the R5 draft's Map/Term/Vault worked
frames byte-for-byte (48-byte header hex and total length pinned).
`constants.json` is the snapshot the C and Rust layers compare against;
`engine/core/src/spec.rs` and `engine/crates/pocket-relay/src/generated.rs`
regenerate from the same spec through `bun contracts/spec/gen-rust.ts`.

## The Rust frame layer

`engine/crates/pocket-relay` is the Rust half of the frame layer. It is
`#![no_std]` and allocates nothing: `decode` borrows the caller's record and
returns the metadata and data regions as slices, `encode_into` writes a
caller-owned buffer, and `RecordReader` reassembles split transport input
inside a buffer the caller supplies, whose length is the wire ceiling. The
default `std` feature adds one thing, the `std::error::Error` impls; `hosts/psp`
builds `--no-default-features`, and the crate compiles for
`thumbv7em-none-eabi` and `wasm32-unknown-unknown` as well as the desktop
target.

**The crate reads no JSON.** `decode` and `encode_into` check that the metadata
region is valid UTF-8 and return `BAD_METADATA` when it is not, the same byte
rule the C layer applies. The JSON half of that rule and every `BAD_ENVELOPE`
rule are decided by the layer that parses metadata. The five vectors that pass
the frame layer and fail above it (a duplicate key, fractional and NaN numbers,
a lone surrogate escape, a RESPONSE without `final`) are asserted to decode
here, which is where the handoff sits.

```sh
cargo test -p pocket-relay                       # 46 tests, 48 vectors
cargo build -p pocket-relay --no-default-features --target thumbv7em-none-eabi
cargo test -p pocket-relay --release --test throughput -- --ignored --nocapture
```
