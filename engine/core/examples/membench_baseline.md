# Core Memory Benchmark Baseline

This receipt was measured at `b7dd46f`, based on `origin/main` revision
`2d20ddad228db52fa29ad7d7d06f44e8672164af`.

The byte values below are **allocator-independent requested-byte metrics** from
the counting allocator. They are not process RSS, committed pages, or PSP arena
high-water measurements. Timing values are host measurements and are excluded
from deterministic receipt comparisons.

## Reproduction

```text
cargo run --manifest-path engine/core/Cargo.toml --example membench --quiet
```

Toolchain: `rustc 1.97.1 (8bab26f4f 2026-07-14)`, `cargo 1.97.1 (c980f4866 2026-06-30)`.

Workload shape: 99 nodes; 24 steady ticks; 8 rounds of 4-node subtree churn;
16 text ticks; 12 burst ticks. Text and texture modes are both `atlas`.

## Receipt

| Field | Value | Meaning |
| --- | ---: | --- |
| `peak_requested_bytes` | 29591 | Peak requested bytes |
| `final_requested_bytes` | 10793 | Final live requested bytes |
| `allocation_count` | 11682 | Count of measured allocation events |
| `total_allocated_bytes` | 6225569 | Total requested bytes across measured allocation events |
| `avg_layout_us` | 1210 | Host timing, excluded from canonical comparison |
| `max_layout_us` | 5163 | Host timing, excluded from canonical comparison |
| `nodes` | 99 | Workload node count |
| `structural_relayouts` | 16 | Structural relayout count |
| `drawlist_checksum` | `cc6a0b00efdba151` | Deterministic drawlist checksum |
