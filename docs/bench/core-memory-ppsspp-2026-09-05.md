# Core Memory PSP Receipt

Status: **BLOCKED**

The canonical target workload is **`stats`**, using the existing fixed input
script and the existing PSP JSONL schema. No second demo or Taffy A/B run was
added.

## Commands

Baseline:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 bun tools/bench-ppsspp.ts --apps=stats --samples=3
```

Memory scan:

```bash
PSP_SDK="$PSP_SDK" BENCH_PPSSPP_TIMEOUT=60 bun tools/bench-ppsspp.ts --apps=stats --samples=3 --memory-scan
```

## Revisions

| item | value |
|---|---|
| git revision | `2e93828` |
| PPSSPP revision | unavailable |
| selected app | `stats` |
| framework | `solid` |
| samples | `3` |

## Metrics

No measurements were recorded. The following requested fields are therefore
**null**, not fabricated: `arena_bump_bytes`, `arena_tail_free_bytes`,
`avg_tick_us`, `avg_work_us`, `max_work_us`, `uncapped_arena_bump_bytes`,
`min_pass_arena_bytes`, and `safe_arena_bytes`.

## Blocker

`PSP_SDK` was unset and
`/Users/quake/ppsspp-src/build/PPSSPPHeadless` was not present. Both commands
failed in `tools/bench-ppsspp.ts` before the PSP app was built or run:

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
