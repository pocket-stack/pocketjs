# Desktop QuickJS observations

Run date: 2026-09-06. Linux x86_64, GCC 16.2.1, CMake Release (`-O3 -DNDEBUG`), QuickJS 2025-09-13 archive `-2`, Solid 1.9.13. No JIT, LTO, CPU affinity or power governor controls. These are local observations on a shared development machine, not target-device forecasts.

**All 54 runs matched computation counts, observer counts and checksums across implementations.** Each cell below is the median of three process-level measurements. Each process warms up with 100 updates and measures 2,000 updates. See [raw JSONL](results-linux-x64.jsonl) for per-run latency, memory, boundary counts and behavior counts.

## Update latency

Units: microseconds per workload update. The p95 column is the median of the native runs' p95 values; it is not a pooled percentile. Ratios compare the medians in this table.

| Workload | Solid median | JS control median | Native median | Native p95 | Solid/native | JS control/native |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| untracked | 15.32 | 18.95 | 8.73 | 10.50 | 1.75× | 2.17× |
| fanout | 654.29 | 672.04 | 27.98 | 54.41 | 23.38× | 24.02× |
| equality | 390.18 | 476.83 | 17.53 | 18.19 | 22.25× | 27.20× |
| chain | 390.55 | 369.01 | 13.16 | 14.00 | 29.68× | 28.05× |
| branch | 14.15 | 12.87 | 0.64 | 0.68 | 22.05× | 20.04× |
| expensive | 166.59 | 165.89 | 154.61 | 195.43 | 1.08× | 1.07× |

The fanout, equality and chain workloads spend much of their time managing dependencies. The expensive workload keeps its numeric loop in JS, reducing the relative gain. Even untracked reads improved in this build; this does not establish the cost of every native accessor design. Short native timings include timer overhead. The two subsets share graph states, edge maintenance and scheduling; Solid uses its own algorithm and supports a larger API.

## Accounted heap after warmup

Units: bytes, before the timed sample array grows. Each cell sums QuickJS `malloc_size` and tracked native allocations. These figures include loaded code and live benchmark scaffolding. Baselines, separate JS/native values, disposal snapshots and process peak RSS are in the raw data. They are not graph-only sizes or a promise of lower memory in a long-running app.

| Workload | Solid | JS control | Native | Native reactive JS→C calls in timed region | Native C→JS calls in timed region |
| --- | ---: | ---: | ---: | ---: | ---: |
| untracked | 152856 | 117896 | 96632 | 258000 | 0 |
| fanout | 464888 | 409592 | 257544 | 514000 | 512000 |
| equality | 464888 | 409512 | 257560 | 258000 | 256000 |
| chain | 353688 | 282072 | 200352 | 260000 | 258000 |
| branch | 171608 | 127832 | 98344 | 18000 | 8000 |
| expensive | 170552 | 127272 | 97848 | 6000 | 4000 |

**Node records remain allocated until runner shutdown in both algorithm controls.** Disposal releases callback references and incoming dependency vectors, but this prototype has no bounded handle reclamation. Repeated component creation can therefore invalidate memory advantages suggested by these fixed-graph workloads.

## Validation and decision limits

- CTest verifies graph propagation, equality suppression, disposal and callback release.
- Twelve shared tests pass against all three variants, including a seeded 500-update graph. Five rejection checks pass for both subsets.
- AddressSanitizer, UndefinedBehaviorSanitizer and leak detection pass for the CTest and shared/subset tests.
- The branch demo prints `1`, `2`, `20` under all three variants.
- No actual PocketJS UI scene, native UI property binding, browser benchmark or hardware run is included.

**The results support further QuickJS experiments, not a runtime migration.** Next measurements need a real host scene, device builds, larger/deeper graphs, creation/disposal churn, and a native UI binding path. Exception recovery, allocator failure handling, stack depth and compatibility beyond the tested subset also remain open.
