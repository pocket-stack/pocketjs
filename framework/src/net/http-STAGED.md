# HTTP SDK admission status

**`net/http` remains behind the compiler staged-surface gate.** The object
implementation does not add a target capability and does not admit ESP-IDF or
another Host.

**`http-binding.ts` is the high-level SDK seam, while
`network-v1-binding.ts` adapts the generated private ABI 1.1 vocabulary to that
seam.** The generated TypeScript and C constants, BufferLease ownership,
owner-thread completion dispatch, exact Build Plan handshake, and admitted
limits snapshot are fixed. The ESP-IDF native binding table, descriptor
aggregation, and product scheduler integration remain required before
admission.

**A bound response prefetches at most the admitted tee window: the smaller of
four admitted chunks, 256 KiB, and `http.bufferedBodyBytes`.** A small response
therefore reaches `BODY_END`, releases every BufferLease, retires its operation,
and detaches its abort listener even when application code never reads the
body. The formal integration test retains nine such responses across an
eight-slot adapter. A response larger than that window stops receiving credit
until application code reads or cancels it. There is no Guest finalizer, so
dropping an arbitrary large response is not proof that its native operation was
released.

**Resolving a response-headers event is the request-upload terminal claim.**
The binding must stop further upload credit and cancel an upload producer that
has not reached EOF before it resolves that event, including early HEAD,
content-length-zero, 204, 205, and 304 responses. The SDK performs an additional
best-effort producer cancel, but that does not replace the Host/Core claim.

**HTTP URL normalization is fixed to the special-URL behavior adapted from
`whatwg-url@17.1.0` and UTS #46 data from `tr46@6.0.0` / Unicode 17.0.0.** It
supports IDNA A-labels, IPv4, IPv6, dot segments, default ports, percent
encoding, query strings, and fragments under explicit input and serialization
ceilings. PocketJS additionally rejects userinfo, requires strict DNS labels,
and removes one DNS root dot because the canonical host is also a permission
and TLS identity.

**Body helpers, chunks, header storage, clone tee branches, and response
prefetch use the admitted HTTP/client defaults and the lower SDK hard ceiling.**
The constants remain SDK ceilings, not ESP32 resource measurements.

**TLS and per-operation dictionary snapshots also have staged SDK ceilings.**
The current limits are 64 KiB for a CA input, 16 ALPN tokens / 1 KiB total ALPN
bytes, 253 bytes for `serverName`, 256 bytes for a credential id, and 32 limit
overrides with 64-byte names. Native descriptor limits can only lower them. The
required DER/PEM CA structural validation is not implemented by this staged JS
surface and remains an admission blocker for custom-CA capability.

The directly ported Fetch/WPT cases are recorded in
`tests/http-fetch-wpt-allowlist.json`. That file is a partial staged allowlist,
not the conformance report required to remove the compiler gate.

**ABI 1.1 does not yet expose the selected provider's negotiated ALPN
snapshot.** Custom ALPN therefore fails before I/O and cannot be advertised as
a capability.
