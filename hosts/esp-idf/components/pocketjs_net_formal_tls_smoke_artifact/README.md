# ESP formal TLS network smoke artifact

This component is an isolated **test-only** PocketJS network factory for
ESP32-S3 and ESP32-P4 hardware validation. It does not change the public
network capability gate.

The verified Build Plan admits exactly `network.http.client` and
`network.http.client.tls`, the ESP HTTP Core, the ESP transport, and the ESP-TLS
provider. The only endpoint is **`https://pocketjs.test:8443`**. Each of 20
rounds performs one health request and one streamed binary echo request with
the SDK's default redirect-follow mode and this exact Guest TLS policy:

- DNS A-label and SNI: `pocketjs.test`
- TLS minimum and maximum: 1.2
- verification: full
- revocation: host-default
- ALPN, Guest custom CA, client credentials, and client certificates: absent

`fixtures/ca.cert.pem` is the public test CA only. Its DER SHA-256 is recorded
in generated metadata. **No CA or server private key belongs in this
component.**

ESP-IDF generates the artifact into the component's build directory during
configuration. To inspect the deterministic outputs without changing the
source tree, generate them into a temporary directory:

```sh
bun hosts/esp-idf/components/pocketjs_net_formal_tls_smoke_artifact/generate.ts \
  --output-dir=/tmp/pocketjs-formal-tls-artifact
bun test tests/esp-network-artifacts.test.ts
```

**Generated plans, metadata C, and factory bundles are build outputs and are
not committed.** The consolidated artifact test regenerates all HTTP and TLS
profiles in an isolated directory and locks their hashes and admission rules.

The board harness must configure stock lwIP DNS so `pocketjs.test` resolves to
the selected Mac peer, provision a trusted wall clock, and pass both facts to
`pocketjs_net_formal_tls_smoke_run()`. The runner snapshots the public CA into
the runtime as `POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA` and rejects every
other Host profile.

The runner also exposes test-only deadline and cancellation controls. A zero
stage-timeout field selects the fixed artifact default; a nonzero value is
passed unchanged to the formal runtime. `cancel_after_ms` installs no timer in
native networking: the owner task waits until the first health request is
active, then invokes the artifact's private AbortController function through
the guarded Guest call API. These controls are for deterministic delayed-
handshake tests and do not change the Build Plan or public SDK surface.
With a five-second peer handshake delay, a two-second connect deadline must
produce `timed_out`; cancelling after 500 ms must produce `aborted`. Both runs
must complete three-phase shutdown with zero poison and no live leases. Peer
evidence must contain the board's DNS answer, delayed TLS connection, and SNI
`pocketjs.test`, but no successful connection or HTTP request.

The generated artifact metadata also carries the exact HTTP backend, network
driver, and TLS provider selection from its verified Build Plan. The runner
passes those generated values into fail-closed test-only runtime admission;
they are not reconstructed from product defaults.

The exact runtime descriptor must report `distinct_tls_errors=true`. The
transport reads the failed handshake's live Mbed TLS verification result before
teardown: hostname mismatch maps to `tls_hostname_mismatch`, while trust-chain,
validity, and usage failures map to `tls_certificate_invalid`. Negative wire
evidence must show the expected SNI, a failed TLS handshake, zero HTTP requests,
and no plaintext fallback. Native allocation and DNS completeness blockers keep
the public TLS capability gate closed.
