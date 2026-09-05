# Core Memory Benchmark Design

## Purpose

Measure core memory changes independently from host allocator behavior, then
validate the operational result on PSP/PPSSPP using the existing arena
high-water metrics.

The benchmark must not claim that a host allocator's requested-byte count is a
PSP memory requirement. The two measurements answer different questions.

## Scope

This work covers:

- a deterministic, host-side `pocketjs-core` memory and layout benchmark;
- corrected separation between benchmark workload allocations and harness
  allocations;
- machine-readable canonical memory and layout metrics;
- PSP/PPSSPP collection of `arena_bump_bytes` and layout timing for the same
  workload;
- baseline receipts from the latest `origin/main`.

This work does not merge the Taffy storage rebuild strategy. That strategy is
an A/B candidate for a later change and will consume the benchmark receipts.

## Metrics

### Canonical core metrics

The host benchmark reports:

- `peak_requested_bytes`: maximum simultaneously-live allocation bytes
  requested by the measured core workload;
- `final_requested_bytes`: requested bytes still live after the workload;
- `allocation_count`: number of measured allocation operations;
- `total_allocated_bytes`: cumulative requested allocation bytes;
- `avg_layout_us`: average measured layout duration;
- `max_layout_us`: maximum measured layout duration;
- workload shape: live node count, structural relayout count, and text/texture
  mode.

The benchmark excludes fixture construction, result formatting, and reporting
allocations. It must prebuild and reserve harness data before measurement and
disable counting before formatting the report.

These metrics are allocator-independent requested-byte metrics. They are used
to compare core revisions, not to estimate a PSP arena capacity.

### PSP metrics

The existing PSP stats and PPSSPP runner remain authoritative for target
behavior:

- `arena_bump_bytes`;
- `arena_tail_free_bytes`;
- `avg_tick_us` and `avg_work_us`;
- structural relayout/layout timing where the host exposes it;
- `min_pass_arena_bytes` and `safe_arena_bytes` when `--memory-scan` runs.

PPSSPP output is reported as emulator evidence. It is not presented as real
PSP hardware proof.

## Workload

Use one deterministic UI journey with explicit phases:

1. boot and initial tree construction;
2. steady ticks with style-only animation;
3. structural churn with subtree creation and destruction;
4. text updates and relayout;
5. optional burst phase for peak allocation behavior.

The journey must keep its input data and output buffers outside the measured
allocation window. The same logical workload must be runnable by the host
benchmark and the PSP/PPSSPP benchmark, with target-specific launch wrappers
only where required.

## A/B Boundary

The benchmark defines, but does not yet merge, two layout implementations:

- baseline: clear and reuse the existing Taffy storage;
- candidate: rebuild Taffy storage using the structural subtree capacity.

Both variants must use identical workload inputs and produce the same drawlist
checksum. Candidate acceptance requires no regression in canonical peak bytes,
PSP arena high-water, average/max layout timing, or frame work timing.

## Implementation Shape

Prefer a host-side counting allocator around the existing core API rather than
adding production-only accounting fields to core data structures. Keep the
measurement interface local to the benchmark so normal host allocators and
target ABI remain unchanged.

The PSP side should reuse `tools/bench-ppsspp.ts`, PSP JSON stats, and the
existing `--memory-scan` protocol. Add only the smallest wiring needed to
identify the structural-relayout workload and preserve the existing report
schema.

## Verification

The implementation is complete when:

- the canonical benchmark is deterministic across repeated runs;
- harness allocations do not change canonical metrics;
- core tests and benchmark checks pass;
- baseline canonical receipts are recorded;
- PPSSPP reports include `arena_bump_bytes` and layout timing for the same
  workload;
- no Taffy rebuild code is included in this branch;
- the report clearly separates canonical core metrics from PSP operational
  metrics.
