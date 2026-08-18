# PocketJS ESP-IDF network runtime candidate

This experimental component adapts the frozen private network ABI 1.1 table to
a bounded pool of HTTP Client Cores and dedicated ESP transports. **The table
is owner-task-only, frozen, accessor-free, and bound to the exact Build Plan
hash and either the `network.http.client` projection or the exact
`network.http.client` plus `network.http.client.tls` projection.** The
handshake and `getLimits()` return the same frozen feature list. lwIP callbacks
only call the configured scheduler wake hook; Guest code runs only through
`pocketjs_esp_guest_call_function()`.

Each operation slot owns one Core and one transport because Core-local
transport tokens cannot safely share a completion consumer. The pool has a
compile-time ceiling of eight slots and a smaller admitted runtime size.
`pocketjs_net_esp_runtime_required_native_buffer_bytes()` computes the maximum
PocketJS-owned allocation payload for the runtime, binding tombstone, fixed
slots, dedicated transports, and CA-validation snapshot. Creation rejects a
`runtime.nativeBufferBytes` default or hard limit below that result. Header
Latin-1 conversion uses fixed runtime scratch instead of transient native heap,
and stats report both current PocketJS-owned bytes and the admitted default.
Allocator metadata and IDF-owned lwIP/Mbed TLS pools remain outside this number
and must be admitted separately before public capability advertisement.
Response body events retain the Core lease until the formal
`leaseTake`/`leaseReadInto`/`leaseRelease` sequence completes. Request upload
pull events are retired immediately while their single credit and Core body
and pull generations remain recorded for the later producer command.
`leaseReadInto` accepts only an exact borrowed `Uint8Array` window whose byte
length equals `maxBytes`, and rejects any range beyond the retained lease.

Plaintext `http:` is available in both projections. HTTPS requires the exact
TLS feature projection and an immutable Host-selected certificate bundle or a
single Host-pinned CA. The runtime copies a pinned CA during `create()`; the
trusted-clock callback and its context remain borrowed until successful
destroy. **The native boundary accepts only TLS 1.2, full certificate and
hostname verification, no client certificate, no custom CA input, no ALPN,
and the canonical DNS A-label as `serverName`.** Numeric HTTPS hosts and every
other TLS policy are rejected before permission checks, DNS, or socket I/O.
The transport reads the failed handshake's live Mbed TLS verification result
through ESP-TLS's public SSL-context accessor before teardown. The runtime
therefore reports `distinct_tls_errors=true`: hostname mismatch maps to
`tls_hostname_mismatch`, while chain, validity, and usage failures map to
`tls_certificate_invalid`.
TLS close operations send a client `close_notify`. Nonblocking
`WANT_READ`/`WANT_WRITE` results are retried by later owner turns under the
close operation's monotonic deadline. The Host does not wait indefinitely for
the peer's reciprocal alert; failure, cancellation, and timeout hard-close the
dedicated connection.

The runtime passes `manual`, `error`, and bounded `follow` modes into the Core.
The final response metadata carries the effective URL and whether any hop was
followed. A one-shot streaming producer can follow redirects that rewrite the
request to GET, but 307/308 and other preserve-body redirects fail with
`invalid_state`; the runtime never asks the Guest producer to replay consumed
input. The native redirect resolver is still an ASCII-only subset of the
framework URL implementation. Runtime creation now compares the Build Plan's
generated HTTP backend, network driver, and optional TLS provider selection
with the exact compiled provider IDs before allocating slots. It also checks
the compiled Core and transport descriptors against the lifecycle, redirect,
credit, lease, pool, and TLS properties consumed by the runtime. This check
applies to test-only plans, so a component replacement or descriptor drift
fails before Guest evaluation. A public admission request additionally
requires every composed descriptor to advertise the capability, exhaustive
DNS candidates with generation-safe cancellation, bounded native-step time,
and bounded lwIP allocation. TLS public admission also requires nonblocking
TLS steps, no ESP-TLS internal resolver allocation, bounded ESP-TLS/X.509
allocation, and distinct certificate errors. Those properties are currently
false. Full product Host descriptor/resource aggregation is still incomplete.
**The descriptor therefore keeps public capability advertisement off.**

Shutdown has three explicit stages: stop admission and request cancellation,
run guarded shutdown service turns while pumping native cleanup, then destroy
quiescent transports and deinitialize every Core before releasing the binding.
If a poisoned Core retains native ownership, phase 2 destroys only that Core's
dedicated transport and synchronously confirms the invalid transport context
before any other Core call. Persistent Host event retirement then uses the
Core's poison-only exact-sequence abandon path; healthy event retirement is
never discarded. A late stock lwIP DNS callback delays this recovery without
freeing its callback context.
Both zero-budget probes and nonzero-budget empty polls read Core status before
reporting `Drained`, so Core poison cannot be hidden by an empty Host queue.
Binding construction clears and logs any QuickJS exception on failure, including
the closure constructor's returned-value/pending-exception boundary.
