# Core Memory Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic allocator-independent core memory receipt and connect its shared workload profile to the existing PSP/PPSSPP representative arena benchmark without merging the Taffy rebuild candidate.

**Architecture:** The host benchmark is a standalone `pocketjs-core` example with a counting global allocator. All fixture and harness allocations are completed before measurement, and the measured phase emits JSON only after counting is disabled. PSP evidence continues to come from `tools/bench-ppsspp.ts` and `hosts/psp` stats, so canonical requested bytes and target arena high-water remain separate metrics.

**Tech Stack:** Rust `pocketjs-core` example, `std::alloc::GlobalAlloc`, `std::time::Instant`, Bun/TypeScript PPSSPP runner, PSP JSONL stats, Cargo tests.

---

### Task 1: Add The Isolated Core Benchmark Harness

**Files:**
- Create: `engine/core/examples/membench.rs`

- [ ] **Step 1: Define the machine-readable report contract**

Create a Rust report struct or fixed output writer with these exact fields:

```text
peak_requested_bytes
final_requested_bytes
allocation_count
total_allocated_bytes
avg_layout_us
max_layout_us
nodes
structural_relayouts
text_mode
texture_mode
drawlist_checksum
```

Keep output deterministic: stable field order, no timestamps, no process IDs,
and no allocator addresses.

- [ ] **Step 2: Add counting allocator scope controls**

Implement a `GlobalAlloc` wrapper around `System` that tracks requested sizes
for `alloc`, `alloc_zeroed`, `realloc`, and `dealloc`. Add a scoped boolean or
counter with these semantics:

```rust
fn begin_measurement() {
    LIVE.store(0, Ordering::Relaxed);
    PEAK.store(0, Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    COUNT.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::Relaxed);
}

fn end_measurement() {
    COUNTING.store(false, Ordering::Relaxed);
}
```

When counting is disabled, allocator calls must still delegate to `System` but
must not change any counters. The report formatter must run after
`end_measurement()`.

- [ ] **Step 3: Prebuild all fixture and harness storage**

Construct style blobs, atlas blobs, source strings, node-handle vectors, and
input/churn data while counting is disabled. Reserve the exact capacities of
all vectors that are mutated during the measured phase. Do not retain a
`HashMap`/`HashSet` mirror of the core tree unless its allocations are created
before measurement and never grow afterward.

The measured phase must contain only calls through the public core API plus
pre-reserved benchmark bookkeeping.

- [ ] **Step 4: Implement the deterministic five-phase workload**

Use the following phase order and counters:

1. build the initial tree and resources;
2. run steady style-only ticks;
3. create and destroy fixed-size subtrees;
4. update text and force structural relayouts at fixed intervals;
5. run one fixed burst that exercises the peak path.

Count a structural relayout at the call site that changes the tree or text
structure. Measure layout duration around the core tick/layout call with
`Instant::now()` and accumulate `avg_layout_us` and `max_layout_us`.

- [ ] **Step 5: Preserve semantic output checks**

Accumulate a deterministic drawlist checksum after each draw. Keep the final
checksum in the report so memory-only benchmark changes cannot silently alter
rendered behavior.

- [ ] **Step 6: Run the example twice and verify deterministic output**

Run:

```bash
cargo run --manifest-path engine/core/Cargo.toml --example membench --quiet
cargo run --manifest-path engine/core/Cargo.toml --example membench --quiet
```

Expected result: all canonical memory fields and the checksum are identical.
Timing fields are parsed but excluded from byte-for-byte comparison because
host scheduling can vary. Timing is compared statistically in the PSP runner.

- [ ] **Step 7: Commit the standalone harness**

```bash
git add engine/core/examples/membench.rs
git commit -m "bench(core): add isolated memory receipt"
```

### Task 2: Add Benchmark Checks And Baseline Receipt

**Files:**
- Create: `engine/core/examples/membench_baseline.json`
- Create: `engine/core/examples/membench_baseline.md`
- Create: `tests/core-memory-bench.test.ts`

- [ ] **Step 1: Add a deterministic receipt check**

Use Bun's `$` command runner to invoke the Rust example twice, parse each
newline-delimited field, and compare the canonical memory fields and checksum.
Do not compare wall-clock timing fields byte-for-byte.

The test must fail if fixture construction or report formatting becomes part of
the measured allocation window. It must assert that all required fields are
present and non-negative.

- [ ] **Step 2: Record a baseline from a harness based on latest `origin/main`**

Generate a JSON receipt from the benchmark and a short Markdown table that
labels the values as allocator-independent requested-byte metrics. The harness
may be based on the latest `origin/main`, but the receipt is measured at the
harness's own `git_revision`, not from `origin/main`; record
`origin_main_revision` separately. Include the benchmark implementation
revision, exact command, Rust toolchain, workload shape, and checksum.

- [ ] **Step 3: Run core verification**

Run:

```bash
cargo test --manifest-path engine/core/Cargo.toml
cargo run --manifest-path engine/core/Cargo.toml --example membench --quiet
```

Expected result: all core tests pass and the receipt check passes.

- [ ] **Step 4: Commit the baseline receipt**

```bash
git add engine/core/examples/membench_baseline.json engine/core/examples/membench_baseline.md tests/
git commit -m "bench(core): record baseline memory receipt"
```

### Task 3: Align The PSP Representative Workload And Timing Receipt

**Files:**
- Modify: `tools/bench-ppsspp.ts:81-100` to expose the existing `stats` workload as the representative structural-memory run
- Modify: `skills/pocketjs-psp-benchmark/references/metrics.md` for any new fields
- Create: `docs/bench/core-memory-ppsspp-2026-09-05.json`
- Create: `docs/bench/core-memory-ppsspp-2026-09-05.md`

- [ ] **Step 1: Define the shared workload profile without changing existing app defaults**

Use the existing `stats` app and its fixed input script as the representative workload.
Keep `stats` as the default app and preserve all existing app scripts. Align
the host benchmark phases with the stats app's initial dashboard construction,
style-only counter/bar animation, deterministic tab switch, and repeated text
updates. These are corresponding phases in a shared workload profile, not a
byte-identical event sequence. Do not add a second demo app solely for memory measurement.

- [ ] **Step 2: Verify PSP JSONL fields before changing the schema**

Use the existing fields first:

```text
arena_bump_bytes
arena_tail_free_bytes
avg_tick_us
avg_work_us
max_work_us
```

`avg_tick_us` is the existing combined core tick, animation, and layout timing
metric. Use it as the PSP-side layout proxy, and preserve the existing JSONL
schema in this benchmark branch.

- [ ] **Step 3: Run a focused PPSSPP baseline**

Run:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 \
  bun tools/bench-ppsspp.ts --apps=stats --samples=3
```

Record the report path, PPSSPP revision, git revision, selected app, sample
count, `arena_bump_bytes`, `avg_tick_us`, `avg_work_us`, and checksum. The
receipt must state that the target is the representative `stats` workload and
must report any checksum difference explicitly.

- [ ] **Step 4: Run the capped arena scan**

Run:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 \
  bun tools/bench-ppsspp.ts --apps=stats --samples=3 --memory-scan
```

Record `uncapped_arena_bump_bytes`, `min_pass_arena_bytes`, and
`safe_arena_bytes`. Report this as PPSSPP evidence, not real hardware proof.

- [ ] **Step 5: Update metric documentation and commit evidence**

Document any new fields in `skills/pocketjs-psp-benchmark/references/metrics.md`
and write the JSON/Markdown receipt under `docs/bench/`. Commit with:

```bash
git add tools/bench-ppsspp.ts \
  skills/pocketjs-psp-benchmark/references/metrics.md \
  docs/bench/core-memory-ppsspp-2026-09-05.json \
  docs/bench/core-memory-ppsspp-2026-09-05.md
git commit -m "bench(psp): record core memory arena receipt"
```

### Task 4: Final Verification And Handoff

**Files:**
- No Taffy rebuild implementation files are modified in this task

- [ ] **Step 1: Verify the branch contains no candidate optimization**

Run:

```bash
git diff origin/main...HEAD -- engine/core/src/layout.rs engine/core/src/tree.rs
```

Expected result: no diff in either file.

- [ ] **Step 2: Run final checks**

Run:

```bash
cargo test --manifest-path engine/core/Cargo.toml
git diff --check
git status --short --branch
```

Expected result: tests pass, no whitespace errors, and the working tree is
clean.

- [ ] **Step 3: Review benchmark evidence**

Confirm that the final report separates:

- canonical core requested-byte metrics;
- PSP arena high-water metrics;
- timing metrics;
- PPSSPP limitations.
