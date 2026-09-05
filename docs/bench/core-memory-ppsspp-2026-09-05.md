# Core Memory PSP Receipt

Status: **BLOCKED**

Receipt schema version: **1**

**No measurements were recorded.** All metric fields remain `null` because no
benchmark command reached the PSP app.

The PSP target is the **`stats` representative workload**, using the existing
fixed input script and PSP JSONL schema. It corresponds to phases in the Rust
synthetic workload profile; the two journeys are not byte-identical event
sequences. No second demo or Taffy A/B run was added. Any checksum difference
must be reported explicitly when measurements are available.

## Commands

Both commands were attempted with the repository checked out at the detached
revision `2e93828`. The later receipt metadata commits were not benchmarked.

```bash
git checkout --detach 2e93828
```

Baseline:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 bun tools/bench-ppsspp.ts --apps=stats --samples=3
```

Status: **BLOCKED**; exit status: `1`.

Error:

```text
PPSSPPHeadless not found at /Users/quake/ppsspp-src/build/PPSSPPHeadless
```

Memory scan:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 bun tools/bench-ppsspp.ts --apps=stats --samples=3 --memory-scan
```

Status: **BLOCKED**; exit status: `1`.

Error:

```text
PPSSPPHeadless not found at /Users/quake/ppsspp-src/build/PPSSPPHeadless
```

## Revisions

| item | value |
|---|---|
| git revision | `2e93828` |
| PPSSPP revision | unavailable |
| selected app | `stats` |
| framework | `solid` |
| samples | `3` |
| report path | `null` |
| checksum | `null` |

`report_path` is the expected generated JSON report path under `dist/bench/`,
using `ppsspp-bench-<timestamp>.json`; it is `null` because no report was
generated. `checksum` is the checksum of the representative workload drawlist; it is `null`
because no benchmark ran.

## Metrics

The following requested fields are therefore **null**, not fabricated:
`arena_bump_bytes`, `arena_tail_free_bytes`,
`avg_tick_us`, `avg_work_us`, `max_work_us`, `uncapped_arena_bump_bytes`,
`min_pass_arena_bytes`, and `safe_arena_bytes`.

## Blocker

`PSP_SDK` was **unset**. The `PPSSPP_HEADLESS` override was **unset/unknown**;
the runner therefore used the default path
`/Users/quake/ppsspp-src/build/PPSSPPHeadless`, which was not present. Both
commands failed in `tools/bench-ppsspp.ts` before the PSP app was built or run.
No measurements were recorded:

```text
PPSSPPHeadless not found at /Users/quake/ppsspp-src/build/PPSSPPHeadless
```

Human follow-up: provide a valid `PSP_SDK` and build or set
`PPSSPP_HEADLESS`, then rerun both commands and replace this blocked receipt
with the resulting samples and arena scan values.

**PPSSPP results, when available, are emulator evidence rather than real PSP
hardware proof.** `arena_bump_bytes` is a practical allocator capacity
requirement and includes size-class fragmentation; it is not a precise
live-object heap profile.
