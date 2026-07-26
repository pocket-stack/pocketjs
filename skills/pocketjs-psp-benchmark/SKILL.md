---
name: pocketjs-psp-benchmark
description: Benchmark PocketJS demos on PSP or PPSSPP, including per-frame timing, renderer phase costs, bundle and pak sizes, arena high-water memory, and minimum passing arena scans. Use when asked to profile PSP performance, compare demo frame budgets, measure memory headroom, find the minimum safe heap for demos, or preserve benchmark evidence in dist/bench.
---

# PocketJS PSP Benchmark

## Overview

Use this skill to produce repeatable PocketJS PSP benchmark evidence instead of ad hoc emulator runs. Prefer `tools/bench-ppsspp.ts` for local PPSSPP measurements; use `tools/hw.ts` only when the user explicitly asks for real PSP hardware proof.

## Standard Workflow

1. Confirm the worktree is on the intended branch and inspect local changes with `git status --short --branch`.
2. Confirm host dependencies before long runs:

```bash
test -x "${PPSSPP_HEADLESS:-$HOME/ppsspp-src/build/PPSSPPHeadless}"
test -n "$PSP_SDK" && test -f "$PSP_SDK/psp/lib/libc.a"
```

3. Run a focused benchmark while iterating:

```bash
PSP_SDK=/path/to/mipsel-sony-psp BENCH_PPSSPP_TIMEOUT=60 \
  bun tools/bench-ppsspp.ts --apps=stats --samples=3
```

4. Run the full suite and memory scan for release-quality evidence:

```bash
PSP_SDK=/path/to/mipsel-sony-psp BENCH_PPSSPP_TIMEOUT=60 \
  bun tools/bench-ppsspp.ts --apps=all --samples=3 --memory-scan
```

5. Preserve the generated evidence paths from `dist/bench/` in the final answer, PR body, or handoff. The `.json` file is authoritative; the `.md` file is for human review; `.raw.jsonl` keeps per-sample and memory-probe records.

## Memory Scans

Use `--memory-scan` when the user asks for minimum memory, heap headroom, safe arena sizing, or whether all demos fit. The runner first measures uncapped arena high-water, then probes capped `POCKETJS_ARENA_BYTES` values in `--memory-step-kib` increments. The reported suite requirement is the maximum safe arena across selected apps.

Default safety policy is:

```text
safe_arena = min_passing_arena + max(512 KiB, 20% of min_passing_arena)
```

Override it only when the user specifies a different margin:

```bash
bun tools/bench-ppsspp.ts --apps=all --samples=3 --memory-scan \
  --memory-step-kib=128 --memory-safety-kib=1024 --memory-safety-percent=25
```

## Interpreting Results

Use `avg_work_us` against the 60 Hz budget of about `16667us`. `max_work_us` can spike on transitions, but a sustained average over budget is a performance finding.

Use `arena_bump_bytes` as the allocator high-water for the run. Use `min_pass_arena_bytes` as the probed lower bound at the configured step size, and `safe_arena_bytes` as the answer when the user asks for a minimum with safety margin.

Read `references/metrics.md` when you need field definitions, caveats, or exact wording for a benchmark report.

## Reporting

Always include:

- command run
- report path
- selected apps and sample count
- PPSSPP revision and git revision from the report
- suite safe arena when `--memory-scan` was used
- any app whose `avg_work_us` exceeds the frame budget

Do not claim real hardware proof from a PPSSPP run. State PPSSPP evidence as emulator evidence unless `tools/hw.ts` or a real PSP run was actually used.
