# PocketJS ESP-IDF transport candidate

This component is a private, experimental substrate for the reference protocol
cores. **It does not register or advertise a PocketJS public capability.** It
is pinned to ESP-IDF v6.0.2 commit
`7101770dc6db2667b3c477cc31365dd1acd6db4e` and supports the `esp32s3` and
`esp32p4` build targets.

## Ownership and scheduling

The API separates `resolve` from `connect`. A resolve completion contains a
bounded, de-duplicated IPv4 candidate array. The protocol Core is responsible
for applying endpoint permission to every candidate before starting a connect
with one numeric address. TLS connect additionally receives the original DNS
hostname, which ESP-TLS uses as `common_name`; Mbed TLS therefore performs both
certificate identity verification and SNI with the original hostname.

Create, start, pump, completion, lease, and destroy calls belong to one Host
owner task. `cancel` and `begin_shutdown` are thread-safe and wake the owner
after releasing the transport lock. Before destroy, the Host must prohibit new
cross-task calls and join all in-flight callers. The lwIP DNS callback only
copies bounded numeric results, updates native state, and calls the Host wake
hook. **No worker, lwIP callback, or ESP-TLS call enters QuickJS.**

Every accepted operation reserves one terminal credit. Success, error, abort,
and monotonic timeout compete for one operation lifecycle transition. Dequeue
moves that credit to `delivering`; the Core returns it explicitly only after
Guest delivery. Operation tokens are strictly increasing 64-bit values and
never wrap. Connection and read-lease generations also never wrap, so a stale
handle cannot become valid through slot reuse.

Cancel or timeout of connect, read, write, or close closes that connection. In
particular, a partially completed write cannot leave a reusable stream with an
unreported prefix, and a cancelled read cannot reuse an HTTP/1 connection at an
unknown response boundary. Resolve cancellation retains only its quarantined
DNS context. A normal TLS close sends `close_notify`; `WANT_READ`/`WANT_WRITE`
retries consume bounded owner-pump steps under the close operation's monotonic
deadline. The client does not wait indefinitely for a reciprocal alert. A
close-alert failure, cancellation, or timeout hard-closes the native stream and
is reported through the existing close terminal path. Transport-wide shutdown
cancels active resolve/connect/read/write operations, but it does not cancel an
already accepted close; that close completes or reaches its own deadline.

Poison recovery is separate from healthy shutdown. An owner may call
`pocketjs_net_esp_transport_destroy_poisoned` only after the sole Core using the
dedicated transport has reported poison and shutdown has stopped admission.
The call abandons stuck completion/lease accounting and closes every native
connection after a tcpip-thread barrier. It does not free a raw DNS lookup's
callback context early: until lwIP delivers that lookup's late callback, poison
teardown returns `ESP_ERR_NOT_FINISHED` and the owner retries. A successful
poison teardown invalidates that Core's transport context, so its owner confirms
transport shutdown before calling any other Core entry point.

The transport owner is a product task, never lwIP's tcpip task, because both
destroy paths use a synchronous tcpip callback barrier. The component accepts
only stock tcpip-thread DNS callbacks. A build with
`CONFIG_LWIP_HOOK_DNS_EXT_RESOLVE_CUSTOM` fails at compile time because an
external resolver can deliver a late callback outside that barrier.

DNS submission uses one pre-acquired lwIP static callback message per DNS
context and `dns_gethostbyname_addrtype(..., LWIP_DNS_ADDRTYPE_IPV4)`. The
component does not call synchronous `getaddrinfo` for a hostname. Cancellation
marks the operation immediately; a pending raw DNS context remains quarantined
and cannot be reused until its late callback performs cleanup. Both the static
tcpip submission and raw found callback carry an immutable, nonzero snapshot of
the context generation. They compare it with the live generation under the
transport lock before every state transition, so a stale callback cannot act on
a reused slot. `.local` and non-canonical hostnames are rejected before native
I/O. If all `DNS_MAX_HOST_IP` cache slots are populated, the result is rejected
as `resource_limit` instead of exposing a possibly truncated prefix.

The BSP must initialize its concrete network interface, ESP-NETIF, and lwIP
before creating this transport. This component never configures Wi-Fi or owns
interface lifecycle.

## TLS profile

TLS is exact TLS 1.2 with hostname verification and SNI. The product Host
selects either the compiled ESP certificate bundle or one copied, bounded,
validated CA PEM. Guest input cannot select trust. The Host must publish a
trusted wall-clock state; every handshake step fails closed with
`tls_certificate_invalid` while that state is absent. Insecure certificate
verification, weak certificate verification, renegotiation, DES/3DES, early
data, and plaintext fallback are disabled or rejected at compile time.
ESP-TLS reports `MBEDTLS_ERR_X509_CERT_VERIFY_FAILED` when certificate
verification aborts without retained verification flags. The transport maps
that code to `tls_certificate_invalid`; it does not relabel it as a generic
handshake failure.

## Admission blockers

The descriptor deliberately reports the following gaps:

- **Native step wall time is not proven.** The adapter now creates and connects
  the numeric IPv4 socket itself, polls it with zero timeout, and transfers the
  connected `O_NONBLOCK` descriptor through ESP-TLS's public socket/state APIs.
  This bypasses ESP-TLS's private `getaddrinfo` and internal TCP-connect
  `select`; each Mbed TLS handshake call returns on `WANT_READ`/`WANT_WRITE`.
  Socket allocation, cryptographic work, and scheduler contention still have no
  proven per-step wall-time bound.
- **lwIP DNS tables, socket/netconn objects, TCP buffers, callback MEMP entries,
  and ESP-TLS/Mbed TLS handshake objects are native allocations whose byte peak
  is not proven by the fixed PocketJS pools.** The descriptor reports each as
  unbounded.
- **Validation of the one Host-pinned CA uses Mbed TLS X.509 parsing.** Its
  transient native allocation is not caller-owned or byte-bounded even though
  the input snapshot is fixed at 4096 bytes.
- **Certificate verification reasons are recovered from the live negotiation
  state.** ESP-IDF's error handle may preserve only the generic X.509 failure,
  so the adapter also reads `mbedtls_ssl_get_verify_result()` from the public
  ESP-TLS SSL-context accessor before destroying the connection. Hostname
  mismatch maps to `tls_hostname_mismatch`; chain, validity, and usage failures
  map to `tls_certificate_invalid`. S3 and P4 wire tests require the expected
  SNI, a failed handshake, and zero HTTP requests.
- **The lwIP resolver retains at most `DNS_MAX_HOST_IP` records.** A full prefix
  is rejected, but the stock callback does not expose the DNS `TC` bit. A
  truncated response containing fewer records therefore remains
  indistinguishable from a complete response, so the descriptor does not claim
  a complete candidate set.
- **lwIP raw DNS has no request cancellation primitive.** A cancelled query can
  retain one fixed DNS context until success, failure, or lwIP timeout.
- **The Host owns cross-task API lifetime.** It must disable and join
  `cancel`/`begin_shutdown` callers before destroy; internal pool quiescence
  cannot prove that an external caller does not still hold the pointer.

Until these blockers have measured target-specific resource envelopes and
bounded native step wall time, this provider must not enter a production or
admitted-target Build Plan and must not advertise
`network.http.client.tls`. **An exact test-only TLS smoke plan may select this
provider solely to gather pre-admission hardware evidence.** That plan does not
add a stock target, open the compiler's public network gate, or change the
descriptor's `advertises_public_capability=false` result.

## Verification

The host-state test covers token monotonicity, no-wrap generations, shutdown
admission, terminal credit conservation, cancel/deadline terminal arbitration,
round-robin progress, saturated DNS-prefix rejection, stale DNS callback-ticket
rejection, and pure TLS error classification without ESP-IDF. The nested
ESP-IDF build-smoke app repeats the TLS classification assertions with the
pinned Mbed TLS constants and asserts the public descriptor and stable numeric
and name mapping. Its `sdkconfig.defaults` fixes the candidate count and TLS
policy.
