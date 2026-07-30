# PocketJS PPSSPP Benchmark

Generated: 2026-07-30T00:48:05.365Z
Samples per app/framework: 7
Frameworks: solid, vue-vapor, octane
PPSSPP revision: 676724ee5e
Git revision: 4e097c0
Frame budget: 16667us

## Comparison (baseline: solid; lower is better)

| metric | vue-vapor/solid geomean | octane/solid geomean |
|---|---:|---:|
| `eval_us` | 2.906x [2.906, 2.906] | 2.876x [2.876, 2.876] |
| `boot_to_frame0_us` | 2.019x [2.019, 2.019] | 2.001x [2.001, 2.001] |
| `avg_work_us` | 1.114x [1.114, 1.114] | 1.664x [1.664, 1.664] |
| `host_wall_ms` | 1.245x [1.237, 1.254] | 1.274x [1.264, 1.284] |
| `bundle_bytes` | 2.413x [2.413, 2.413] | 2.964x [2.964, 2.964] |

95% CIs from 5000 bootstrap resamples.

### Average frame work by app

| app | solid avg work | vue-vapor avg work | octane avg work |
|---|---:|---:|---:|
| hero | 3.66 ms | 3.61 ms | 6.53 ms |
| cards | 4.82 ms | 5.14 ms | 6.56 ms |
| stats | 6.84 ms | 8.04 ms | 9.25 ms |
| library | 3.68 ms | 4.39 ms | 4.94 ms |
| settings | 6.84 ms | 7.37 ms | 14.53 ms |
| notifications | 4.52 ms | 6.10 ms | 13.84 ms |
| music | 10.44 ms | 10.39 ms | 12.92 ms |

## hero (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 319884us | 0us | 319884us | 319884us | 319884us |
| boot_to_frame0_us | 648975us | 0us | 648975us | 648975us | 648975us |
| avg_frame_interval_us | 17748us | 0us | 17748us | 17748us | 17748us |
| max_frame_interval_us | 33367us | 0us | 33367us | 33367us | 33367us |
| avg_js_us | 2147us | 0us | 2147us | 2147us | 2147us |
| avg_jobs_us | 1us | 0us | 1us | 1us | 1us |
| avg_tick_us | 396us | 0us | 396us | 396us | 396us |
| avg_draw_us | 940us | 0us | 940us | 940us | 940us |
| avg_render_us | 178us | 0us | 178us | 178us | 178us |
| avg_work_us | 3663us | 0us | 3663us | 3663us | 3663us |
| max_work_us | 31466us | 0us | 31466us | 31466us | 31466us |
| stack_free_bytes | 982.4 KiB | 0 B | 982.4 KiB | 982.4 KiB | 982.4 KiB |
| host_wall_ms | 231.1ms | 7.0ms | 224.2ms | 229.6ms | 245.1ms |
| bundle_bytes | 103.1 KiB | 0 B | 103.1 KiB | 103.1 KiB | 103.1 KiB |
| pak_bytes | 453.8 KiB | 0 B | 453.8 KiB | 453.8 KiB | 453.8 KiB |
| arena_capacity_bytes | 17.07 MiB | 0 B | 17.07 MiB | 17.07 MiB | 17.07 MiB |
| arena_bump_bytes | 2.94 MiB | 0 B | 2.94 MiB | 2.94 MiB | 2.94 MiB |
| arena_tail_free_bytes | 14.13 MiB | 0 B | 14.13 MiB | 14.13 MiB | 14.13 MiB |
| arena_init_free_bytes | 19.07 MiB | 0 B | 19.07 MiB | 19.07 MiB | 19.07 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## hero (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 936522us | 0us | 936522us | 936522us | 936522us |
| boot_to_frame0_us | 1266388us | 0us | 1266388us | 1266388us | 1266388us |
| avg_frame_interval_us | 17748us | 0us | 17748us | 17748us | 17748us |
| max_frame_interval_us | 33367us | 0us | 33367us | 33367us | 33367us |
| avg_js_us | 2015us | 0us | 2015us | 2015us | 2015us |
| avg_jobs_us | 300us | 0us | 300us | 300us | 300us |
| avg_tick_us | 163us | 0us | 163us | 163us | 163us |
| avg_draw_us | 954us | 0us | 954us | 954us | 954us |
| avg_render_us | 178us | 0us | 178us | 178us | 178us |
| avg_work_us | 3612us | 0us | 3612us | 3612us | 3612us |
| max_work_us | 23947us | 0us | 23947us | 23947us | 23947us |
| stack_free_bytes | 951.3 KiB | 0 B | 951.3 KiB | 951.3 KiB | 951.3 KiB |
| host_wall_ms | 292.2ms | 4.0ms | 288.5ms | 291.1ms | 300.4ms |
| bundle_bytes | 253.6 KiB | 0 B | 253.6 KiB | 253.6 KiB | 253.6 KiB |
| pak_bytes | 450.7 KiB | 0 B | 450.7 KiB | 450.7 KiB | 450.7 KiB |
| arena_capacity_bytes | 16.93 MiB | 0 B | 16.93 MiB | 16.93 MiB | 16.93 MiB |
| arena_bump_bytes | 4.65 MiB | 0 B | 4.65 MiB | 4.65 MiB | 4.65 MiB |
| arena_tail_free_bytes | 12.28 MiB | 0 B | 12.28 MiB | 12.28 MiB | 12.28 MiB |
| arena_init_free_bytes | 18.93 MiB | 0 B | 18.93 MiB | 18.93 MiB | 18.93 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## hero (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 926958us | 0us | 926958us | 926958us | 926958us |
| boot_to_frame0_us | 1249701us | 0us | 1249701us | 1249701us | 1249701us |
| avg_frame_interval_us | 20942us | 0us | 20942us | 20942us | 20942us |
| max_frame_interval_us | 183517us | 0us | 183517us | 183517us | 183517us |
| avg_js_us | 4973us | 0us | 4973us | 4973us | 4973us |
| avg_jobs_us | 315us | 0us | 315us | 315us | 315us |
| avg_tick_us | 163us | 0us | 163us | 163us | 163us |
| avg_draw_us | 904us | 0us | 904us | 904us | 904us |
| avg_render_us | 175us | 0us | 175us | 175us | 175us |
| avg_work_us | 6532us | 0us | 6532us | 6532us | 6532us |
| max_work_us | 176891us | 0us | 176891us | 176891us | 176891us |
| stack_free_bytes | 953.4 KiB | 0 B | 953.4 KiB | 953.4 KiB | 953.4 KiB |
| host_wall_ms | 290.7ms | 10.6ms | 280.2ms | 288.4ms | 312.5ms |
| bundle_bytes | 313.9 KiB | 0 B | 313.9 KiB | 313.9 KiB | 313.9 KiB |
| pak_bytes | 450.3 KiB | 0 B | 450.3 KiB | 450.3 KiB | 450.3 KiB |
| arena_capacity_bytes | 16.87 MiB | 0 B | 16.87 MiB | 16.87 MiB | 16.87 MiB |
| arena_bump_bytes | 4.89 MiB | 0 B | 4.89 MiB | 4.89 MiB | 4.89 MiB |
| arena_tail_free_bytes | 11.98 MiB | 0 B | 11.98 MiB | 11.98 MiB | 11.98 MiB |
| arena_init_free_bytes | 18.87 MiB | 0 B | 18.87 MiB | 18.87 MiB | 18.87 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## cards (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 304983us | 0us | 304983us | 304983us | 304983us |
| boot_to_frame0_us | 577211us | 0us | 577211us | 577211us | 577211us |
| avg_frame_interval_us | 17740us | 0us | 17740us | 17740us | 17740us |
| max_frame_interval_us | 50118us | 0us | 50118us | 50118us | 50118us |
| avg_js_us | 1825us | 0us | 1825us | 1825us | 1825us |
| avg_jobs_us | 1us | 0us | 1us | 1us | 1us |
| avg_tick_us | 194us | 0us | 194us | 194us | 194us |
| avg_draw_us | 2370us | 0us | 2370us | 2370us | 2370us |
| avg_render_us | 433us | 0us | 433us | 433us | 433us |
| avg_work_us | 4824us | 0us | 4824us | 4824us | 4824us |
| max_work_us | 38010us | 0us | 38010us | 38010us | 38010us |
| stack_free_bytes | 988.1 KiB | 0 B | 988.1 KiB | 988.1 KiB | 988.1 KiB |
| host_wall_ms | 278.3ms | 4.0ms | 269.8ms | 280.2ms | 280.9ms |
| bundle_bytes | 103.5 KiB | 0 B | 103.5 KiB | 103.5 KiB | 103.5 KiB |
| pak_bytes | 149.2 KiB | 0 B | 149.2 KiB | 149.2 KiB | 149.2 KiB |
| arena_capacity_bytes | 17.37 MiB | 0 B | 17.37 MiB | 17.37 MiB | 17.37 MiB |
| arena_bump_bytes | 2.03 MiB | 0 B | 2.03 MiB | 2.03 MiB | 2.03 MiB |
| arena_tail_free_bytes | 15.34 MiB | 0 B | 15.34 MiB | 15.34 MiB | 15.34 MiB |
| arena_init_free_bytes | 19.37 MiB | 0 B | 19.37 MiB | 19.37 MiB | 19.37 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## cards (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 924898us | 0us | 924898us | 924898us | 924898us |
| boot_to_frame0_us | 1211368us | 0us | 1211368us | 1211368us | 1211368us |
| avg_frame_interval_us | 17740us | 0us | 17740us | 17740us | 17740us |
| max_frame_interval_us | 33434us | 0us | 33434us | 33434us | 33434us |
| avg_js_us | 1725us | 0us | 1725us | 1725us | 1725us |
| avg_jobs_us | 192us | 0us | 192us | 192us | 192us |
| avg_tick_us | 333us | 0us | 333us | 333us | 333us |
| avg_draw_us | 2457us | 0us | 2457us | 2457us | 2457us |
| avg_render_us | 433us | 0us | 433us | 433us | 433us |
| avg_work_us | 5143us | 0us | 5143us | 5143us | 5143us |
| max_work_us | 29662us | 0us | 29662us | 29662us | 29662us |
| stack_free_bytes | 959.1 KiB | 0 B | 959.1 KiB | 959.1 KiB | 959.1 KiB |
| host_wall_ms | 347.9ms | 10.5ms | 338.1ms | 346.2ms | 369.5ms |
| bundle_bytes | 254.6 KiB | 0 B | 254.6 KiB | 254.6 KiB | 254.6 KiB |
| pak_bytes | 147.7 KiB | 0 B | 147.7 KiB | 147.7 KiB | 147.7 KiB |
| arena_capacity_bytes | 17.22 MiB | 0 B | 17.22 MiB | 17.22 MiB | 17.22 MiB |
| arena_bump_bytes | 3.49 MiB | 0 B | 3.49 MiB | 3.49 MiB | 3.49 MiB |
| arena_tail_free_bytes | 13.73 MiB | 0 B | 13.73 MiB | 13.73 MiB | 13.73 MiB |
| arena_init_free_bytes | 19.22 MiB | 0 B | 19.22 MiB | 19.22 MiB | 19.22 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## cards (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 879999us | 0us | 879999us | 879999us | 879999us |
| boot_to_frame0_us | 1161606us | 0us | 1161606us | 1161606us | 1161606us |
| avg_frame_interval_us | 19429us | 0us | 19429us | 19429us | 19429us |
| max_frame_interval_us | 183584us | 0us | 183584us | 183584us | 183584us |
| avg_js_us | 3424us | 0us | 3424us | 3424us | 3424us |
| avg_jobs_us | 136us | 0us | 136us | 136us | 136us |
| avg_tick_us | 194us | 0us | 194us | 194us | 194us |
| avg_draw_us | 2369us | 0us | 2369us | 2369us | 2369us |
| avg_render_us | 433us | 0us | 433us | 433us | 433us |
| avg_work_us | 6558us | 0us | 6558us | 6558us | 6558us |
| max_work_us | 173698us | 0us | 173698us | 173698us | 173698us |
| stack_free_bytes | 957.6 KiB | 0 B | 957.6 KiB | 957.6 KiB | 957.6 KiB |
| host_wall_ms | 341.8ms | 7.4ms | 332.3ms | 341.7ms | 354.1ms |
| bundle_bytes | 311.1 KiB | 0 B | 311.1 KiB | 311.1 KiB | 311.1 KiB |
| pak_bytes | 147.7 KiB | 0 B | 147.7 KiB | 147.7 KiB | 147.7 KiB |
| arena_capacity_bytes | 17.16 MiB | 0 B | 17.16 MiB | 17.16 MiB | 17.16 MiB |
| arena_bump_bytes | 4.17 MiB | 0 B | 4.17 MiB | 4.17 MiB | 4.17 MiB |
| arena_tail_free_bytes | 12.99 MiB | 0 B | 12.99 MiB | 12.99 MiB | 12.99 MiB |
| arena_init_free_bytes | 19.16 MiB | 0 B | 19.16 MiB | 19.16 MiB | 19.16 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## stats (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 370940us | 0us | 370940us | 370940us | 370940us |
| boot_to_frame0_us | 677038us | 0us | 677038us | 677038us | 677038us |
| avg_frame_interval_us | 18703us | 0us | 18703us | 18703us | 18703us |
| max_frame_interval_us | 66420us | 0us | 66420us | 66420us | 66420us |
| avg_js_us | 3045us | 0us | 3045us | 3045us | 3045us |
| avg_jobs_us | 1us | 0us | 1us | 1us | 1us |
| avg_tick_us | 506us | 0us | 506us | 506us | 506us |
| avg_draw_us | 2714us | 0us | 2714us | 2714us | 2714us |
| avg_render_us | 574us | 0us | 574us | 574us | 574us |
| avg_work_us | 6842us | 0us | 6842us | 6842us | 6842us |
| max_work_us | 61762us | 0us | 61762us | 61762us | 61762us |
| stack_free_bytes | 972.0 KiB | 0 B | 972.0 KiB | 972.0 KiB | 972.0 KiB |
| host_wall_ms | 354.5ms | 7.1ms | 345.0ms | 355.9ms | 365.8ms |
| bundle_bytes | 108.4 KiB | 0 B | 108.4 KiB | 108.4 KiB | 108.4 KiB |
| pak_bytes | 140.5 KiB | 0 B | 140.5 KiB | 140.5 KiB | 140.5 KiB |
| arena_capacity_bytes | 17.37 MiB | 0 B | 17.37 MiB | 17.37 MiB | 17.37 MiB |
| arena_bump_bytes | 2.45 MiB | 0 B | 2.45 MiB | 2.45 MiB | 2.45 MiB |
| arena_tail_free_bytes | 14.92 MiB | 0 B | 14.92 MiB | 14.92 MiB | 14.92 MiB |
| arena_init_free_bytes | 19.37 MiB | 0 B | 19.37 MiB | 19.37 MiB | 19.37 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## stats (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1034261us | 0us | 1034261us | 1034261us | 1034261us |
| boot_to_frame0_us | 1344611us | 0us | 1344611us | 1344611us | 1344611us |
| avg_frame_interval_us | 19209us | 0us | 19209us | 19209us | 19209us |
| max_frame_interval_us | 99786us | 0us | 99786us | 99786us | 99786us |
| avg_js_us | 2500us | 0us | 2500us | 2500us | 2500us |
| avg_jobs_us | 1333us | 0us | 1333us | 1333us | 1333us |
| avg_tick_us | 719us | 0us | 719us | 719us | 719us |
| avg_draw_us | 2912us | 0us | 2912us | 2912us | 2912us |
| avg_render_us | 574us | 0us | 574us | 574us | 574us |
| avg_work_us | 8039us | 0us | 8039us | 8039us | 8039us |
| max_work_us | 95373us | 0us | 95373us | 95373us | 95373us |
| stack_free_bytes | 933.5 KiB | 0 B | 933.5 KiB | 933.5 KiB | 933.5 KiB |
| host_wall_ms | 437.6ms | 4.2ms | 430.7ms | 437.9ms | 442.8ms |
| bundle_bytes | 259.3 KiB | 0 B | 259.3 KiB | 259.3 KiB | 259.3 KiB |
| pak_bytes | 140.5 KiB | 0 B | 140.5 KiB | 140.5 KiB | 140.5 KiB |
| arena_capacity_bytes | 17.22 MiB | 0 B | 17.22 MiB | 17.22 MiB | 17.22 MiB |
| arena_bump_bytes | 4.48 MiB | 0 B | 4.48 MiB | 4.48 MiB | 4.48 MiB |
| arena_tail_free_bytes | 12.75 MiB | 0 B | 12.75 MiB | 12.75 MiB | 12.75 MiB |
| arena_init_free_bytes | 19.22 MiB | 0 B | 19.22 MiB | 19.22 MiB | 19.22 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## stats (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1100489us | 0us | 1100489us | 1100489us | 1100489us |
| boot_to_frame0_us | 1411368us | 0us | 1411368us | 1411368us | 1411368us |
| avg_frame_interval_us | 21231us | 0us | 21231us | 21231us | 21231us |
| max_frame_interval_us | 350036us | 0us | 350036us | 350036us | 350036us |
| avg_js_us | 5190us | 0us | 5190us | 5190us | 5190us |
| avg_jobs_us | 263us | 0us | 263us | 263us | 263us |
| avg_tick_us | 511us | 0us | 511us | 511us | 511us |
| avg_draw_us | 2709us | 0us | 2709us | 2709us | 2709us |
| avg_render_us | 574us | 0us | 574us | 574us | 574us |
| avg_work_us | 9248us | 0us | 9248us | 9248us | 9248us |
| max_work_us | 339229us | 0us | 339229us | 339229us | 339229us |
| stack_free_bytes | 938.6 KiB | 0 B | 938.6 KiB | 938.6 KiB | 938.6 KiB |
| host_wall_ms | 433.8ms | 4.3ms | 425.6ms | 435.9ms | 438.5ms |
| bundle_bytes | 320.7 KiB | 0 B | 320.7 KiB | 320.7 KiB | 320.7 KiB |
| pak_bytes | 140.5 KiB | 0 B | 140.5 KiB | 140.5 KiB | 140.5 KiB |
| arena_capacity_bytes | 17.16 MiB | 0 B | 17.16 MiB | 17.16 MiB | 17.16 MiB |
| arena_bump_bytes | 5.44 MiB | 0 B | 5.44 MiB | 5.44 MiB | 5.44 MiB |
| arena_tail_free_bytes | 11.72 MiB | 0 B | 11.72 MiB | 11.72 MiB | 11.72 MiB |
| arena_init_free_bytes | 19.16 MiB | 0 B | 19.16 MiB | 19.16 MiB | 19.16 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## library (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 322146us | 0us | 322146us | 322146us | 322146us |
| boot_to_frame0_us | 627397us | 0us | 627397us | 627397us | 627397us |
| avg_frame_interval_us | 17943us | 0us | 17943us | 17943us | 17943us |
| max_frame_interval_us | 72327us | 0us | 72327us | 72327us | 72327us |
| avg_js_us | 2207us | 0us | 2207us | 2207us | 2207us |
| avg_jobs_us | 58us | 0us | 58us | 58us | 58us |
| avg_tick_us | 184us | 0us | 184us | 184us | 184us |
| avg_draw_us | 983us | 0us | 983us | 983us | 983us |
| avg_render_us | 244us | 0us | 244us | 244us | 244us |
| avg_work_us | 3677us | 0us | 3677us | 3677us | 3677us |
| max_work_us | 60921us | 0us | 60921us | 60921us | 60921us |
| stack_free_bytes | 973.3 KiB | 0 B | 973.3 KiB | 973.3 KiB | 973.3 KiB |
| host_wall_ms | 262.8ms | 4.6ms | 255.7ms | 262.4ms | 269.6ms |
| bundle_bytes | 108.1 KiB | 0 B | 108.1 KiB | 108.1 KiB | 108.1 KiB |
| pak_bytes | 353.0 KiB | 0 B | 353.0 KiB | 353.0 KiB | 353.0 KiB |
| arena_capacity_bytes | 17.16 MiB | 0 B | 17.16 MiB | 17.16 MiB | 17.16 MiB |
| arena_bump_bytes | 2.64 MiB | 0 B | 2.64 MiB | 2.64 MiB | 2.64 MiB |
| arena_tail_free_bytes | 14.53 MiB | 0 B | 14.53 MiB | 14.53 MiB | 14.53 MiB |
| arena_init_free_bytes | 19.16 MiB | 0 B | 19.16 MiB | 19.16 MiB | 19.16 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## library (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 962198us | 0us | 962198us | 962198us | 962198us |
| boot_to_frame0_us | 1261328us | 0us | 1261328us | 1261328us | 1261328us |
| avg_frame_interval_us | 18364us | 0us | 18364us | 18364us | 18364us |
| max_frame_interval_us | 72838us | 0us | 72838us | 72838us | 72838us |
| avg_js_us | 1848us | 0us | 1848us | 1848us | 1848us |
| avg_jobs_us | 836us | 0us | 836us | 836us | 836us |
| avg_tick_us | 308us | 0us | 308us | 308us | 308us |
| avg_draw_us | 1148us | 0us | 1148us | 1148us | 1148us |
| avg_render_us | 244us | 0us | 244us | 244us | 244us |
| avg_work_us | 4386us | 0us | 4386us | 4386us | 4386us |
| max_work_us | 72819us | 0us | 72819us | 72819us | 72819us |
| stack_free_bytes | 936.9 KiB | 0 B | 936.9 KiB | 936.9 KiB | 936.9 KiB |
| host_wall_ms | 335.7ms | 7.4ms | 323.4ms | 334.7ms | 347.6ms |
| bundle_bytes | 260.0 KiB | 0 B | 260.0 KiB | 260.0 KiB | 260.0 KiB |
| pak_bytes | 350.9 KiB | 0 B | 350.9 KiB | 350.9 KiB | 350.9 KiB |
| arena_capacity_bytes | 17.02 MiB | 0 B | 17.02 MiB | 17.02 MiB | 17.02 MiB |
| arena_bump_bytes | 4.55 MiB | 0 B | 4.55 MiB | 4.55 MiB | 4.55 MiB |
| arena_tail_free_bytes | 12.47 MiB | 0 B | 12.47 MiB | 12.47 MiB | 12.47 MiB |
| arena_init_free_bytes | 19.02 MiB | 0 B | 19.02 MiB | 19.02 MiB | 19.02 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## library (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 920423us | 0us | 920423us | 920423us | 920423us |
| boot_to_frame0_us | 1227961us | 0us | 1227961us | 1227961us | 1227961us |
| avg_frame_interval_us | 19345us | 0us | 19345us | 19345us | 19345us |
| max_frame_interval_us | 189096us | 0us | 189096us | 189096us | 189096us |
| avg_js_us | 3391us | 0us | 3391us | 3391us | 3391us |
| avg_jobs_us | 128us | 0us | 128us | 128us | 128us |
| avg_tick_us | 191us | 0us | 191us | 191us | 191us |
| avg_draw_us | 982us | 0us | 982us | 982us | 982us |
| avg_render_us | 244us | 0us | 244us | 244us | 244us |
| avg_work_us | 4939us | 0us | 4939us | 4939us | 4939us |
| max_work_us | 177488us | 0us | 177488us | 177488us | 177488us |
| stack_free_bytes | 939.5 KiB | 0 B | 939.5 KiB | 939.5 KiB | 939.5 KiB |
| host_wall_ms | 324.0ms | 3.2ms | 318.8ms | 325.4ms | 326.7ms |
| bundle_bytes | 318.6 KiB | 0 B | 318.6 KiB | 318.6 KiB | 318.6 KiB |
| pak_bytes | 350.5 KiB | 0 B | 350.5 KiB | 350.5 KiB | 350.5 KiB |
| arena_capacity_bytes | 16.96 MiB | 0 B | 16.96 MiB | 16.96 MiB | 16.96 MiB |
| arena_bump_bytes | 4.88 MiB | 0 B | 4.88 MiB | 4.88 MiB | 4.88 MiB |
| arena_tail_free_bytes | 12.08 MiB | 0 B | 12.08 MiB | 12.08 MiB | 12.08 MiB |
| arena_init_free_bytes | 18.96 MiB | 0 B | 18.96 MiB | 18.96 MiB | 18.96 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## settings (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 359238us | 0us | 359238us | 359238us | 359238us |
| boot_to_frame0_us | 644070us | 0us | 644070us | 644070us | 644070us |
| avg_frame_interval_us | 18517us | 0us | 18517us | 18517us | 18517us |
| max_frame_interval_us | 66252us | 0us | 66252us | 66252us | 66252us |
| avg_js_us | 2184us | 0us | 2184us | 2184us | 2184us |
| avg_jobs_us | 91us | 0us | 91us | 91us | 91us |
| avg_tick_us | 520us | 0us | 520us | 520us | 520us |
| avg_draw_us | 3210us | 0us | 3210us | 3210us | 3210us |
| avg_render_us | 837us | 0us | 837us | 837us | 837us |
| avg_work_us | 6843us | 0us | 6843us | 6843us | 6843us |
| max_work_us | 61630us | 0us | 61630us | 61630us | 61630us |
| stack_free_bytes | 972.1 KiB | 0 B | 972.1 KiB | 972.1 KiB | 972.1 KiB |
| host_wall_ms | 275.4ms | 2.3ms | 272.5ms | 275.0ms | 278.5ms |
| bundle_bytes | 116.9 KiB | 0 B | 116.9 KiB | 116.9 KiB | 116.9 KiB |
| pak_bytes | 150.0 KiB | 0 B | 150.0 KiB | 150.0 KiB | 150.0 KiB |
| arena_capacity_bytes | 17.35 MiB | 0 B | 17.35 MiB | 17.35 MiB | 17.35 MiB |
| arena_bump_bytes | 2.22 MiB | 0 B | 2.22 MiB | 2.22 MiB | 2.22 MiB |
| arena_tail_free_bytes | 15.14 MiB | 0 B | 15.14 MiB | 15.14 MiB | 15.14 MiB |
| arena_init_free_bytes | 19.35 MiB | 0 B | 19.35 MiB | 19.35 MiB | 19.35 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## settings (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1003175us | 0us | 1003175us | 1003175us | 1003175us |
| boot_to_frame0_us | 1295175us | 0us | 1295175us | 1295175us | 1295175us |
| avg_frame_interval_us | 18586us | 0us | 18586us | 18586us | 18586us |
| max_frame_interval_us | 73498us | 0us | 73498us | 73498us | 73498us |
| avg_js_us | 2117us | 0us | 2117us | 2117us | 2117us |
| avg_jobs_us | 457us | 0us | 457us | 457us | 457us |
| avg_tick_us | 549us | 0us | 549us | 549us | 549us |
| avg_draw_us | 3400us | 0us | 3400us | 3400us | 3400us |
| avg_render_us | 842us | 0us | 842us | 842us | 842us |
| avg_work_us | 7367us | 0us | 7367us | 7367us | 7367us |
| max_work_us | 69674us | 0us | 69674us | 69674us | 69674us |
| stack_free_bytes | 936.1 KiB | 0 B | 936.1 KiB | 936.1 KiB | 936.1 KiB |
| host_wall_ms | 341.3ms | 5.1ms | 335.8ms | 341.5ms | 351.2ms |
| bundle_bytes | 267.3 KiB | 0 B | 267.3 KiB | 267.3 KiB | 267.3 KiB |
| pak_bytes | 148.6 KiB | 0 B | 148.6 KiB | 148.6 KiB | 148.6 KiB |
| arena_capacity_bytes | 17.21 MiB | 0 B | 17.21 MiB | 17.21 MiB | 17.21 MiB |
| arena_bump_bytes | 4.17 MiB | 0 B | 4.17 MiB | 4.17 MiB | 4.17 MiB |
| arena_tail_free_bytes | 13.03 MiB | 0 B | 13.03 MiB | 13.03 MiB | 13.03 MiB |
| arena_init_free_bytes | 19.21 MiB | 0 B | 19.21 MiB | 19.21 MiB | 19.21 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## settings (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 981559us | 0us | 981559us | 981559us | 981559us |
| boot_to_frame0_us | 1278228us | 0us | 1278228us | 1278228us | 1278228us |
| avg_frame_interval_us | 26219us | 0us | 26219us | 26219us | 26219us |
| max_frame_interval_us | 216887us | 0us | 216887us | 216887us | 216887us |
| avg_js_us | 9350us | 0us | 9350us | 9350us | 9350us |
| avg_jobs_us | 697us | 0us | 697us | 697us | 697us |
| avg_tick_us | 426us | 0us | 426us | 426us | 426us |
| avg_draw_us | 3212us | 0us | 3212us | 3212us | 3212us |
| avg_render_us | 839us | 0us | 839us | 839us | 839us |
| avg_work_us | 14525us | 0us | 14525us | 14525us | 14525us |
| max_work_us | 215284us | 0us | 215284us | 215284us | 215284us |
| stack_free_bytes | 942.3 KiB | 0 B | 942.3 KiB | 942.3 KiB | 942.3 KiB |
| host_wall_ms | 379.6ms | 3.3ms | 374.6ms | 381.5ms | 382.6ms |
| bundle_bytes | 325.7 KiB | 0 B | 325.7 KiB | 325.7 KiB | 325.7 KiB |
| pak_bytes | 148.5 KiB | 0 B | 148.5 KiB | 148.5 KiB | 148.5 KiB |
| arena_capacity_bytes | 17.15 MiB | 0 B | 17.15 MiB | 17.15 MiB | 17.15 MiB |
| arena_bump_bytes | 5.97 MiB | 0 B | 5.97 MiB | 5.97 MiB | 5.97 MiB |
| arena_tail_free_bytes | 11.18 MiB | 0 B | 11.18 MiB | 11.18 MiB | 11.18 MiB |
| arena_init_free_bytes | 19.15 MiB | 0 B | 19.15 MiB | 19.15 MiB | 19.15 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## notifications (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 343251us | 0us | 343251us | 343251us | 343251us |
| boot_to_frame0_us | 627186us | 0us | 627186us | 627186us | 627186us |
| avg_frame_interval_us | 18711us | 0us | 18711us | 18711us | 18711us |
| max_frame_interval_us | 64749us | 0us | 64749us | 64749us | 64749us |
| avg_js_us | 2134us | 0us | 2134us | 2134us | 2134us |
| avg_jobs_us | 153us | 0us | 153us | 153us | 153us |
| avg_tick_us | 505us | 0us | 505us | 505us | 505us |
| avg_draw_us | 1186us | 0us | 1186us | 1186us | 1186us |
| avg_render_us | 543us | 0us | 543us | 543us | 543us |
| avg_work_us | 4523us | 0us | 4523us | 4523us | 4523us |
| max_work_us | 57273us | 0us | 57273us | 57273us | 57273us |
| stack_free_bytes | 972.5 KiB | 0 B | 972.5 KiB | 972.5 KiB | 972.5 KiB |
| host_wall_ms | 237.6ms | 6.8ms | 232.2ms | 235.2ms | 251.4ms |
| bundle_bytes | 107.5 KiB | 0 B | 107.5 KiB | 107.5 KiB | 107.5 KiB |
| pak_bytes | 166.7 KiB | 0 B | 166.7 KiB | 166.7 KiB | 166.7 KiB |
| arena_capacity_bytes | 17.35 MiB | 0 B | 17.35 MiB | 17.35 MiB | 17.35 MiB |
| arena_bump_bytes | 2.21 MiB | 0 B | 2.21 MiB | 2.21 MiB | 2.21 MiB |
| arena_tail_free_bytes | 15.13 MiB | 0 B | 15.13 MiB | 15.13 MiB | 15.13 MiB |
| arena_init_free_bytes | 19.35 MiB | 0 B | 19.35 MiB | 19.35 MiB | 19.35 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## notifications (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 970731us | 0us | 970731us | 970731us | 970731us |
| boot_to_frame0_us | 1261118us | 0us | 1261118us | 1261118us | 1261118us |
| avg_frame_interval_us | 19857us | 0us | 19857us | 19857us | 19857us |
| max_frame_interval_us | 99969us | 0us | 99969us | 99969us | 99969us |
| avg_js_us | 2171us | 0us | 2171us | 2171us | 2171us |
| avg_jobs_us | 1447us | 0us | 1447us | 1447us | 1447us |
| avg_tick_us | 696us | 0us | 696us | 696us | 696us |
| avg_draw_us | 1253us | 0us | 1253us | 1253us | 1253us |
| avg_render_us | 531us | 0us | 531us | 531us | 531us |
| avg_work_us | 6101us | 0us | 6101us | 6101us | 6101us |
| max_work_us | 89192us | 0us | 89192us | 89192us | 89192us |
| stack_free_bytes | 943.0 KiB | 0 B | 943.0 KiB | 943.0 KiB | 943.0 KiB |
| host_wall_ms | 288.8ms | 3.0ms | 286.0ms | 287.9ms | 293.5ms |
| bundle_bytes | 254.6 KiB | 0 B | 254.6 KiB | 254.6 KiB | 254.6 KiB |
| pak_bytes | 165 KiB | 0 B | 165 KiB | 165 KiB | 165 KiB |
| arena_capacity_bytes | 17.20 MiB | 0 B | 17.20 MiB | 17.20 MiB | 17.20 MiB |
| arena_bump_bytes | 3.70 MiB | 0 B | 3.70 MiB | 3.70 MiB | 3.70 MiB |
| arena_tail_free_bytes | 13.51 MiB | 0 B | 13.51 MiB | 13.51 MiB | 13.51 MiB |
| arena_init_free_bytes | 19.20 MiB | 0 B | 19.20 MiB | 19.20 MiB | 19.20 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## notifications (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 977445us | 0us | 977445us | 977445us | 977445us |
| boot_to_frame0_us | 1261118us | 0us | 1261118us | 1261118us | 1261118us |
| avg_frame_interval_us | 27833us | 0us | 27833us | 27833us | 27833us |
| max_frame_interval_us | 250250us | 0us | 250250us | 250250us | 250250us |
| avg_js_us | 10607us | 0us | 10607us | 10607us | 10607us |
| avg_jobs_us | 1025us | 0us | 1025us | 1025us | 1025us |
| avg_tick_us | 517us | 0us | 517us | 517us | 517us |
| avg_draw_us | 1156us | 0us | 1156us | 1156us | 1156us |
| avg_render_us | 530us | 0us | 530us | 530us | 530us |
| avg_work_us | 13838us | 0us | 13838us | 13838us | 13838us |
| max_work_us | 235308us | 0us | 235308us | 235308us | 235308us |
| stack_free_bytes | 941.4 KiB | 0 B | 941.4 KiB | 941.4 KiB | 941.4 KiB |
| host_wall_ms | 314.9ms | 5.3ms | 309.0ms | 313.3ms | 324.8ms |
| bundle_bytes | 311.2 KiB | 0 B | 311.2 KiB | 311.2 KiB | 311.2 KiB |
| pak_bytes | 165 KiB | 0 B | 165 KiB | 165 KiB | 165 KiB |
| arena_capacity_bytes | 17.15 MiB | 0 B | 17.15 MiB | 17.15 MiB | 17.15 MiB |
| arena_bump_bytes | 5.49 MiB | 0 B | 5.49 MiB | 5.49 MiB | 5.49 MiB |
| arena_tail_free_bytes | 11.66 MiB | 0 B | 11.66 MiB | 11.66 MiB | 11.66 MiB |
| arena_init_free_bytes | 19.15 MiB | 0 B | 19.15 MiB | 19.15 MiB | 19.15 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## music (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 321359us | 0us | 321359us | 321359us | 321359us |
| boot_to_frame0_us | 610882us | 0us | 610882us | 610882us | 610882us |
| avg_frame_interval_us | 22209us | 0us | 22209us | 22209us | 22209us |
| max_frame_interval_us | 70905us | 0us | 70905us | 70905us | 70905us |
| avg_js_us | 3297us | 0us | 3297us | 3297us | 3297us |
| avg_jobs_us | 103us | 0us | 103us | 103us | 103us |
| avg_tick_us | 4388us | 0us | 4388us | 4388us | 4388us |
| avg_draw_us | 2072us | 0us | 2072us | 2072us | 2072us |
| avg_render_us | 579us | 0us | 579us | 579us | 579us |
| avg_work_us | 10441us | 0us | 10441us | 10441us | 10441us |
| max_work_us | 60603us | 0us | 60603us | 60603us | 60603us |
| stack_free_bytes | 979.1 KiB | 0 B | 979.1 KiB | 979.1 KiB | 979.1 KiB |
| host_wall_ms | 269.8ms | 6.3ms | 264.6ms | 267.4ms | 282.4ms |
| bundle_bytes | 101.1 KiB | 0 B | 101.1 KiB | 101.1 KiB | 101.1 KiB |
| pak_bytes | 155.9 KiB | 0 B | 155.9 KiB | 155.9 KiB | 155.9 KiB |
| arena_capacity_bytes | 17.36 MiB | 0 B | 17.36 MiB | 17.36 MiB | 17.36 MiB |
| arena_bump_bytes | 2.25 MiB | 0 B | 2.25 MiB | 2.25 MiB | 2.25 MiB |
| arena_tail_free_bytes | 15.11 MiB | 0 B | 15.11 MiB | 15.11 MiB | 15.11 MiB |
| arena_init_free_bytes | 19.36 MiB | 0 B | 19.36 MiB | 19.36 MiB | 19.36 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## music (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 963770us | 0us | 963770us | 963770us | 963770us |
| boot_to_frame0_us | 1261996us | 0us | 1261996us | 1261996us | 1261996us |
| avg_frame_interval_us | 19813us | 0us | 19813us | 19813us | 19813us |
| max_frame_interval_us | 79690us | 0us | 79690us | 79690us | 79690us |
| avg_js_us | 2448us | 0us | 2448us | 2448us | 2448us |
| avg_jobs_us | 2627us | 0us | 2627us | 2627us | 2627us |
| avg_tick_us | 2619us | 0us | 2619us | 2619us | 2619us |
| avg_draw_us | 2112us | 0us | 2112us | 2112us | 2112us |
| avg_render_us | 584us | 0us | 584us | 584us | 584us |
| avg_work_us | 10392us | 0us | 10392us | 10392us | 10392us |
| max_work_us | 69615us | 0us | 69615us | 69615us | 69615us |
| stack_free_bytes | 950.3 KiB | 0 B | 950.3 KiB | 950.3 KiB | 950.3 KiB |
| host_wall_ms | 334.1ms | 3.0ms | 330.7ms | 333.2ms | 339.4ms |
| bundle_bytes | 255.5 KiB | 0 B | 255.5 KiB | 255.5 KiB | 255.5 KiB |
| pak_bytes | 154.3 KiB | 0 B | 154.3 KiB | 154.3 KiB | 154.3 KiB |
| arena_capacity_bytes | 17.21 MiB | 0 B | 17.21 MiB | 17.21 MiB | 17.21 MiB |
| arena_bump_bytes | 3.64 MiB | 0 B | 3.64 MiB | 3.64 MiB | 3.64 MiB |
| arena_tail_free_bytes | 13.57 MiB | 0 B | 13.57 MiB | 13.57 MiB | 13.57 MiB |
| arena_init_free_bytes | 19.21 MiB | 0 B | 19.21 MiB | 19.21 MiB | 19.21 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## music (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 949201us | 0us | 949201us | 949201us | 949201us |
| boot_to_frame0_us | 1245036us | 0us | 1245036us | 1245036us | 1245036us |
| avg_frame_interval_us | 24227us | 0us | 24227us | 24227us | 24227us |
| max_frame_interval_us | 216883us | 0us | 216883us | 216883us | 216883us |
| avg_js_us | 7407us | 0us | 7407us | 7407us | 7407us |
| avg_jobs_us | 588us | 0us | 588us | 588us | 588us |
| avg_tick_us | 2387us | 0us | 2387us | 2387us | 2387us |
| avg_draw_us | 1957us | 0us | 1957us | 1957us | 1957us |
| avg_render_us | 581us | 0us | 581us | 581us | 581us |
| avg_work_us | 12922us | 0us | 12922us | 12922us | 12922us |
| max_work_us | 202630us | 0us | 202630us | 202630us | 202630us |
| stack_free_bytes | 947.5 KiB | 0 B | 947.5 KiB | 947.5 KiB | 947.5 KiB |
| host_wall_ms | 345.5ms | 12.6ms | 332.8ms | 342.2ms | 369.2ms |
| bundle_bytes | 315.3 KiB | 0 B | 315.3 KiB | 315.3 KiB | 315.3 KiB |
| pak_bytes | 155 KiB | 0 B | 155 KiB | 155 KiB | 155 KiB |
| arena_capacity_bytes | 17.15 MiB | 0 B | 17.15 MiB | 17.15 MiB | 17.15 MiB |
| arena_bump_bytes | 5.22 MiB | 0 B | 5.22 MiB | 5.22 MiB | 5.22 MiB |
| arena_tail_free_bytes | 11.93 MiB | 0 B | 11.93 MiB | 11.93 MiB | 11.93 MiB |
| arena_init_free_bytes | 19.15 MiB | 0 B | 19.15 MiB | 19.15 MiB | 19.15 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

