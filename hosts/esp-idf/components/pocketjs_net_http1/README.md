# PocketJS bounded HTTP/1.1 wire substrate

This ESP-IDF component provides a fixed-memory HTTP/1.1 request-head encoder
and incremental response parser. It does not use `esp_http_client`, allocate
while parsing, open sockets, resolve DNS, perform TLS, follow redirects, or
expose the PocketJS `fetch()` capability.

The parser preserves the wire reason phrase for the synchronous status
callback and reports every initial field line separately, including duplicate
non-framing fields. It rejects ambiguous framing, obsolete folding, malformed
chunk coding, and forbidden trailer fields. `Content-Encoding` is forbidden in
trailers so a late field cannot reinterpret already delivered identity body
bytes. Valid trailers are parsed, validated, counted, and discarded.

Response body bytes point directly into the caller's input buffer. The parser
will not consume body bytes without explicit credit. A `PAUSED` result leaves
`input[consumed..]` untouched, so a transport can stop reading and resume with
the same bytes after downstream capacity returns.

The request encoder validates the entire request head before emitting bytes.
It rejects the Fetch-forbidden `CONNECT`, `TRACE`, and `TRACK` methods without
regard to ASCII case.
It owns no request data: all method, target, host, and header slices must remain
valid until the encoder reports `DONE`. The caller remains responsible for
writing exactly the declared fixed-length body or valid chunked coding.
Fetch guards and the future Protocol Core remain responsible for filtering
semantic and hop-by-hop request fields such as credentials, `Connection`, and
`Upgrade`; this wire layer controls only `Host`, `Content-Length`,
`Transfer-Encoding`, and the unsupported outgoing `Trailer` field.

This is parser/encoder substrate only. It must not appear in a Host descriptor
or resolved Build Plan until the socket/TLS backend, cancellation, bounded
resource ownership, Guest Binding, and hardware admission suites are complete.
