# PocketJS ESP-IDF HTTP Client Core candidate

This component is an experimental, private plaintext HTTP/1.1 protocol Core.
It combines `pocketjs_net_http1` with the public operation/completion API of
`pocketjs_net_esp_transport`; it does not use `esp_http_client` and does not
register or advertise a PocketJS capability.

## Implemented boundary

One statically supplied 36 KiB instance storage admits one request at a time.
The Core snapshots the method, URL, fields, and an optional fixed request body
before native I/O. A request selects exactly one body mode: none, a fixed
snapshot, or a credit-driven stream. The fixed snapshot is at most 4096 bytes.
A streaming producer may send more than that total, but each submitted chunk
is at most 2048 bytes and is copied into fixed Core storage before the owner API
returns. Request and response field storage are each 8192 bytes, and each
downstream response-body lease is at most 2048 bytes. The Core and wire parser
do not allocate.

Only canonical ASCII DNS names and canonical dotted-decimal IPv4 literals are
accepted. User information, fragments, IPv6, non-canonical numeric hosts,
invalid percent escapes, and non-canonical ports are rejected before I/O.
Requests use origin-form, add `Accept-Encoding: identity`, and reject
caller-controlled connection, framing, proxy, upgrade, and content-coding
fields. GET and HEAD request bodies are rejected. With
`enable_connection_reuse=false`, every request also adds `Connection: close`
and closes after the response. With reuse enabled, one Core retains at most one
HTTP/1.1 connection after a completely parsed, self-delimited response that did
not carry a `Connection: close` token. There is no pipelining. A later request
reuses that connection only for the same canonical scheme, DNS name, port, and
selected numeric address, after repeating both permission checks. HTTP/1.0,
EOF-delimited responses, an explicit close token, a changed origin, redirect,
error, cancellation, timeout, or shutdown closes the connection first. The
same configured idle timeout also bounds how long an unused cached connection
is retained.

Unknown-length request streams use strict HTTP/1.1 chunked coding: one
lowercase hexadecimal size, CRLF, the credited non-empty payload, and CRLF per
chunk, followed by exactly `0\r\n\r\n`. Known-length request streams emit
`Content-Length` and must submit exactly that many raw bytes. Their final byte
ends the upload without another producer pull; an early producer end selects a
request-body error. The fixed and known-length paths never use chunk markers.

For each streaming chunk, the Core publishes one `REQUEST_BODY_PULL` carrying
the operation token, a non-reusable body generation, a non-reusable pull
generation, and `maximum_bytes`. The native adapter takes and immediately
retires that event. Retirement frees the event slot but leaves exactly one
credit active, so an asynchronous Guest producer can submit a later
`BODY_CHUNK`, `BODY_END`, or `BODY_ERROR` command that echoes the token and both
generations. A command before retirement, without credit, with stale identity,
with an empty chunk, or above the advertised bound is rejected without
consuming credit. Abort, timeout, producer failure, and shutdown revoke the
credit before connection cleanup. Event, body, and pull generations never
wrap or reuse during a live Core instance.

The permission callback runs on the owner task. For a DNS name it receives the
canonical `(scheme, hostname, port)` tuple before resolve starts. After resolve,
the callback is invoked for every returned numeric candidate before any connect
starts. Allowed candidates are retained in resolver order. A transport-class
connect refusal or unreachable result advances to the next retained candidate
under the original connect deadline; no HTTP bytes have been emitted and no
request is replayed. TLS, timeout, I/O, resource, abort, and local admission
failures are terminal and never advance the address list. A literal IPv4
address receives the numeric permission check directly. **The callback is
non-reentrant:** every Core entry point rejects a
call made from the callback, and the Core verifies its lifecycle generation,
operation token, state, and transport-idle state after each callback returns.

Response headers are copied into the fixed response store and emitted before
body bytes. **`response_header_bytes_limit` bounds the final response fields as
`name + value + ": " + CRLF`; zero selects the 8192-byte compile-time maximum,
and initialization rejects a larger value.** Crossing the selected limit is a
`resource_limit` terminal selected by the parser callback before any response
headers event is published. The Host must retire that event, grant one bounded
body-credit window, view and release the resulting body lease, and retire the
body event before more input is consumed. The HTTP/1.1 substrate validates
framing, chunking, chunk extensions, trailer declarations, and trailer fields.
Statuses from 200 through 599, including 4xx and 5xx, are protocol success.
Content coding other than `identity` is rejected because this Core does no
decoding. When one read completion contains bytes and EOF, **EOF is applied
only after every byte in that transport lease has been consumed under body
credit**. Because a non-empty body lease is not itself an EOF marker, the Core
accepts one final downstream credit after the parser has completed and while
the successful terminal is closing or queued. That pull receives no bytes and
is completed by the terminal event; a duplicate final credit is rejected.

Connect, response-header, idle-read, and total deadlines use Host-supplied
monotonic microseconds. Abort and all deadline paths select one terminal result.
When a response boundary is unknown, the Core cancels active read/write work or
starts an explicit close. When the transport admits cleanup, the Core waits for
its fail-close or close terminal. If cleanup cannot be admitted or times out,
the Core emits the already selected terminal with poison and retained ownership
so the product can tear down the dedicated transport. The ESP transport instance
must be dedicated to this Core because completion dequeue is single-consumer.

**The first selected HTTP terminal result is immutable.** A later close
admission failure, close error, close timeout, read-lease release failure, or
completion-retirement failure cannot replace it. Those native cleanup failures
set machine-readable poison flags exposed by
`pocketjs_net_http_client_core_get_status`; a poisoned Core rejects every new
request. Failed lease release retains the exact handle as owned state, and a
failed completion retirement retains its token for bounded retries. An exact
Host event-retirement invariant failure is reported separately and retains the
delivering event and any body lease until shutdown cleanup.

The lifecycle is explicit. `begin_shutdown` permanently stops admission and
aborts a current request. The owner continues pumping and retiring events until
`is_quiescent` succeeds, then calls `deinit`. If poisoned native ownership cannot
be discharged through the transport API, the product must synchronously destroy
the dedicated transport and call `confirm_transport_shutdown` before the Core
can become quiescent. A poisoned Core whose exact Host event still cannot be
retired after that confirmation exposes a separate abandon call; it is rejected
before shutdown, on a healthy Core, before transport confirmation, for a pending
event, or for a mismatched sequence. `init` detects and rejects reuse of live
storage.

The Core implements `manual`, `error`, and bounded `follow` redirect modes in
the original operation. Intermediate redirect headers and bodies are not
published to the Guest. The Core closes the old connection, resolves the new
target, and repeats hostname and every numeric-candidate permission check
before the next write. The original total deadline spans all hops. It rewrites
POST for 301/302 and every method except HEAD for 303, removes the body fields,
and strips `Authorization`, `Proxy-Authorization`, and `Cookie` across origins.
A fixed body can be replayed for 307/308. **A consumed streaming body is never
buffered or replayed; a redirect that must preserve it fails with
`invalid_state` before the next hop.** Redirect response bodies and trailers
are abandoned by explicitly closing the current connection before the next
hop; they are never placed into the one-entry reuse cache.

Redirect resolution currently accepts bounded ASCII HTTP(S) references,
including absolute, scheme-relative, root-relative, path-relative,
query-relative, fragment-only, and percent-encoded dot segments. Control
bytes, raw non-ASCII bytes, backslashes, invalid escapes, unsupported schemes,
IPv6, and non-canonical host syntax fail closed. This is sufficient for the
formal ESP smoke target but remains narrower than the framework's pinned
WHATWG/UTS #46 parser. Retry, authentication, cookie storage, proxy,
compression, and decompression remain absent.

## HTTPS and admission blockers

HTTPS is an explicit Host-selected experimental path. The default
`allow_https=false` still returns
`POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS` before permission callbacks,
DNS, or socket I/O. An opted-in request must also carry the exact base TLS
policy: TLS 1.2 only, full verification, Host-default revocation, no ALPN,
credential, client certificate, or custom CA, and a server name equal to the
Core's canonical DNS hostname. HTTPS IP literals remain pre-I/O unsupported:
ESP-TLS/Mbed TLS currently couples IP-ID verification to sending that IP as an
invalid SNI value. The Core passes the canonical DNS name and selected numeric
candidate separately to the transport. Any policy mismatch fails before I/O.

This path does not change admission status. The current ESP transport reports
a bounded one millisecond internal TLS wait, native DNS/socket/TLS allocations
without caller-owned byte bounds, and incomplete DNS candidate sets. Those
transport blockers also apply to this plaintext candidate's eventual public
admission where relevant.

The current Core additionally has these gaps:

- it supports one in-flight operation and one connection, not the architecture
  concurrency target;
- it supports IPv4 only and does not implement IDNA or IPv6;
- its redirect resolver remains an ASCII-only native subset and therefore
  still needs differential conformance against the pinned framework URL
  implementation before public admission;
- a native failure to start or complete the final close has no lower-level
  force-close primitive, so the Core preserves the HTTP terminal result,
  exposes the cleanup poison and retained ownership, and requires the product
  to tear down the dedicated transport;
- fixed PocketJS-owned storage is proven, but the composed lwIP pools and socket
  allocations still need target-specific Kconfig bounds, peak measurements,
  and soak evidence;
- the composed product scheduler, resource ledger, and full AtomS3R/Tab5
  admission matrix remain incomplete even though the formal runtime smoke
  artifacts now exercise this Core on both targets.

Until those gaps are resolved, this component must not enter a production or
publicly admitted Build Plan and must not advertise `network.http.client` or
`network.http.client.tls`.

## Verification

`test_host/core_test.c` uses a deterministic fake transport to cover permission
ordering, ordered fallback across authorized DNS candidates, candidate
exhaustion and non-retryable error classes, headers-first delivery, bounded
body credit and leases, 4xx success, strict trailer failure,
close-before-error ordering, default pre-I/O HTTPS
rejection, exact base-policy validation and explicit TLS connect selection,
redirect follow/error/manual decisions, relative URL resolution, per-hop
permission checks, method/body rewrite, cross-origin sensitive-field removal,
fixed-body replay, streaming-body replay refusal, abort, total timeout,
selected response-header configuration and parse
boundaries, and exact-one terminal delivery. Hostile cases cover all
public API calls attempted from a permission callback, bytes-plus-EOF reads,
stale completions while idle, malformed read cleanup, lease and completion
retirement failures, close admission/error/timeout, terminal immutability,
explicit teardown, poison-only Host event/lease abandonment, HEAD, 1xx followed
by 304, numeric-host denial, and the exact
4096-byte fixed request-body boundary. Streaming hostile cases cover strict
chunk coding over more than 64 KiB, one-byte chunks, asynchronous credit after
event retirement, empty/oversized/no-credit/stale submissions, known-length
underflow and overflow, abort, timeout, producer error, shutdown, and
generation non-reuse. It is compiled with `-Wall -Wextra -Werror` plus
AddressSanitizer and UndefinedBehaviorSanitizer and is also checked with Clang
Static Analyzer.

Reuse cases cover same-origin plaintext and TLS requests without another DNS
or connect operation, permission rechecks on every request, close-token
handling, changed-origin replacement, and idle cached-connection shutdown.
The descriptor exposes a bounded one-entry cache per Core.

`test_apps/build_smoke` links the Core, wire codec, and real ESP transport under
the pinned ESP-IDF v6.0.2 tree. It builds for both `esp32s3` and `esp32p4` with
the transport TLS policy Kconfig, while asserting that HTTPS remains
fail-closed unless the selected Host opts in.
