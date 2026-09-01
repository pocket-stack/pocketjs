# PocketJS PPSSPP Benchmark

Generated: 2026-07-28T23:55:22.401Z
Samples per app/framework: 7
Frameworks: solid, vue-vapor, octane
PPSSPP revision: 676724ee5e
Git revision: 3c14b47
Frame budget: 16667us

## Comparison (baseline: solid; lower is better)

| metric | vue-vapor/solid geomean | octane/solid geomean |
|---|---:|---:|
| `eval_us` | 2.926x [2.926, 2.926] | 2.955x [2.955, 2.955] |
| `boot_to_frame0_us` | 2.298x [2.298, 2.298] | 2.317x [2.317, 2.317] |
| `avg_work_us` | 1.238x [1.238, 1.238] | 15.583x [15.583, 15.583] |
| `host_wall_ms` | 1.349x [1.342, 1.357] | 3.954x [3.934, 3.976] |
| `bundle_bytes` | 2.413x [2.413, 2.413] | 2.956x [2.956, 2.956] |

95% CIs from 5000 bootstrap resamples.

### Average frame work by app

| app | solid avg work | vue-vapor avg work | octane avg work |
|---|---:|---:|---:|
| hero | 4.35 ms | 4.61 ms | 387.82 ms |
| cards | 5.21 ms | 5.66 ms | 9.66 ms |
| stats | 8.63 ms | 11.08 ms | 279.91 ms |
| library | 4.61 ms | 6.05 ms | 50.76 ms |
| settings | 7.71 ms | 8.78 ms | 27.44 ms |
| notifications | 5.55 ms | 9.04 ms | 271.21 ms |
| music | 13.04 ms | 16.12 ms | 282.71 ms |

## hero (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 597648us | 0us | 597648us | 597648us | 597648us |
| boot_to_frame0_us | 949383us | 0us | 949383us | 949383us | 949383us |
| avg_frame_interval_us | 18103us | 0us | 18103us | 18103us | 18103us |
| max_frame_interval_us | 50050us | 0us | 50050us | 50050us | 50050us |
| avg_js_us | 2831us | 0us | 2831us | 2831us | 2831us |
| avg_jobs_us | 1us | 0us | 1us | 1us | 1us |
| avg_tick_us | 398us | 0us | 398us | 398us | 398us |
| avg_draw_us | 940us | 0us | 940us | 940us | 940us |
| avg_render_us | 178us | 0us | 178us | 178us | 178us |
| avg_work_us | 4350us | 0us | 4350us | 4350us | 4350us |
| max_work_us | 41918us | 0us | 41918us | 41918us | 41918us |
| stack_free_bytes | 777.9 KiB | 0 B | 777.9 KiB | 777.9 KiB | 777.9 KiB |
| host_wall_ms | 315.0ms | 3.3ms | 310.3ms | 314.8ms | 319.6ms |
| bundle_bytes | 103.1 KiB | 0 B | 103.1 KiB | 103.1 KiB | 103.1 KiB |
| pak_bytes | 453.8 KiB | 0 B | 453.8 KiB | 453.8 KiB | 453.8 KiB |
| arena_capacity_bytes | 16.96 MiB | 0 B | 16.96 MiB | 16.96 MiB | 16.96 MiB |
| arena_bump_bytes | 2.94 MiB | 0 B | 2.94 MiB | 2.94 MiB | 2.94 MiB |
| arena_tail_free_bytes | 14.03 MiB | 0 B | 14.03 MiB | 14.03 MiB | 14.03 MiB |
| arena_init_free_bytes | 18.96 MiB | 0 B | 18.96 MiB | 18.96 MiB | 18.96 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## hero (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1758497us | 0us | 1758497us | 1758497us | 1758497us |
| boot_to_frame0_us | 2116818us | 0us | 2116818us | 2116818us | 2116818us |
| avg_frame_interval_us | 17748us | 0us | 17748us | 17748us | 17748us |
| max_frame_interval_us | 33367us | 0us | 33367us | 33367us | 33367us |
| avg_js_us | 2495us | 0us | 2495us | 2495us | 2495us |
| avg_jobs_us | 819us | 0us | 819us | 819us | 819us |
| avg_tick_us | 163us | 0us | 163us | 163us | 163us |
| avg_draw_us | 950us | 0us | 950us | 950us | 950us |
| avg_render_us | 178us | 0us | 178us | 178us | 178us |
| avg_work_us | 4607us | 0us | 4607us | 4607us | 4607us |
| max_work_us | 27641us | 0us | 27641us | 27641us | 27641us |
| stack_free_bytes | 646.5 KiB | 0 B | 646.5 KiB | 646.5 KiB | 646.5 KiB |
| host_wall_ms | 425.1ms | 4.4ms | 421.0ms | 423.1ms | 431.6ms |
| bundle_bytes | 253.6 KiB | 0 B | 253.6 KiB | 253.6 KiB | 253.6 KiB |
| pak_bytes | 450.7 KiB | 0 B | 450.7 KiB | 450.7 KiB | 450.7 KiB |
| arena_capacity_bytes | 16.82 MiB | 0 B | 16.82 MiB | 16.82 MiB | 16.82 MiB |
| arena_bump_bytes | 4.65 MiB | 0 B | 4.65 MiB | 4.65 MiB | 4.65 MiB |
| arena_tail_free_bytes | 12.17 MiB | 0 B | 12.17 MiB | 12.17 MiB | 12.17 MiB |
| arena_init_free_bytes | 18.82 MiB | 0 B | 18.82 MiB | 18.82 MiB | 18.82 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## hero (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1764658us | 0us | 1764658us | 1764658us | 1764658us |
| boot_to_frame0_us | 2133510us | 0us | 2133510us | 2133510us | 2133510us |
| avg_frame_interval_us | 397560us | 0us | 397560us | 397560us | 397560us |
| max_frame_interval_us | 750750us | 0us | 750750us | 750750us | 750750us |
| avg_js_us | 357793us | 0us | 357793us | 357793us | 357793us |
| avg_jobs_us | 28745us | 0us | 28745us | 28745us | 28745us |
| avg_tick_us | 178us | 0us | 178us | 178us | 178us |
| avg_draw_us | 931us | 0us | 931us | 931us | 931us |
| avg_render_us | 175us | 0us | 175us | 175us | 175us |
| avg_work_us | 387824us | 0us | 387824us | 387824us | 387824us |
| max_work_us | 747260us | 0us | 747260us | 747260us | 747260us |
| stack_free_bytes | 744.6 KiB | 0 B | 744.6 KiB | 744.6 KiB | 744.6 KiB |
| host_wall_ms | 3322.6ms | 11.7ms | 3305.4ms | 3324.8ms | 3337.6ms |
| bundle_bytes | 311.3 KiB | 0 B | 311.3 KiB | 311.3 KiB | 311.3 KiB |
| pak_bytes | 450.7 KiB | 0 B | 450.7 KiB | 450.7 KiB | 450.7 KiB |
| arena_capacity_bytes | 16.76 MiB | 0 B | 16.76 MiB | 16.76 MiB | 16.76 MiB |
| arena_bump_bytes | 13.94 MiB | 0 B | 13.94 MiB | 13.94 MiB | 13.94 MiB |
| arena_tail_free_bytes | 2.82 MiB | 0 B | 2.82 MiB | 2.82 MiB | 2.82 MiB |
| arena_init_free_bytes | 18.76 MiB | 0 B | 18.76 MiB | 18.76 MiB | 18.76 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## cards (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 566823us | 0us | 566823us | 566823us | 566823us |
| boot_to_frame0_us | 861344us | 0us | 861344us | 861344us | 861344us |
| avg_frame_interval_us | 17951us | 0us | 17951us | 17951us | 17951us |
| max_frame_interval_us | 66801us | 0us | 66801us | 66801us | 66801us |
| avg_js_us | 2207us | 0us | 2207us | 2207us | 2207us |
| avg_jobs_us | 1us | 0us | 1us | 1us | 1us |
| avg_tick_us | 192us | 0us | 192us | 192us | 192us |
| avg_draw_us | 2370us | 0us | 2370us | 2370us | 2370us |
| avg_render_us | 433us | 0us | 433us | 433us | 433us |
| avg_work_us | 5205us | 0us | 5205us | 5205us | 5205us |
| max_work_us | 55501us | 0us | 55501us | 55501us | 55501us |
| stack_free_bytes | 817.0 KiB | 0 B | 817.0 KiB | 817.0 KiB | 817.0 KiB |
| host_wall_ms | 353.7ms | 6.4ms | 345.4ms | 351.8ms | 362.6ms |
| bundle_bytes | 103.5 KiB | 0 B | 103.5 KiB | 103.5 KiB | 103.5 KiB |
| pak_bytes | 149.2 KiB | 0 B | 149.2 KiB | 149.2 KiB | 149.2 KiB |
| arena_capacity_bytes | 17.26 MiB | 0 B | 17.26 MiB | 17.26 MiB | 17.26 MiB |
| arena_bump_bytes | 2.03 MiB | 0 B | 2.03 MiB | 2.03 MiB | 2.03 MiB |
| arena_tail_free_bytes | 15.23 MiB | 0 B | 15.23 MiB | 15.23 MiB | 15.23 MiB |
| arena_init_free_bytes | 19.26 MiB | 0 B | 19.26 MiB | 19.26 MiB | 19.26 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## cards (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1727805us | 0us | 1727805us | 1727805us | 1727805us |
| boot_to_frame0_us | 2045822us | 0us | 2045822us | 2045822us | 2045822us |
| avg_frame_interval_us | 18373us | 0us | 18373us | 18373us | 18373us |
| max_frame_interval_us | 66801us | 0us | 66801us | 66801us | 66801us |
| avg_js_us | 1992us | 0us | 1992us | 1992us | 1992us |
| avg_jobs_us | 454us | 0us | 454us | 454us | 454us |
| avg_tick_us | 325us | 0us | 325us | 325us | 325us |
| avg_draw_us | 2457us | 0us | 2457us | 2457us | 2457us |
| avg_render_us | 433us | 0us | 433us | 433us | 433us |
| avg_work_us | 5664us | 0us | 5664us | 5664us | 5664us |
| max_work_us | 50014us | 0us | 50014us | 50014us | 50014us |
| stack_free_bytes | 690.9 KiB | 0 B | 690.9 KiB | 690.9 KiB | 690.9 KiB |
| host_wall_ms | 461.6ms | 4.8ms | 457.1ms | 459.5ms | 471.3ms |
| bundle_bytes | 254.6 KiB | 0 B | 254.6 KiB | 254.6 KiB | 254.6 KiB |
| pak_bytes | 147.7 KiB | 0 B | 147.7 KiB | 147.7 KiB | 147.7 KiB |
| arena_capacity_bytes | 17.11 MiB | 0 B | 17.11 MiB | 17.11 MiB | 17.11 MiB |
| arena_bump_bytes | 3.49 MiB | 0 B | 3.49 MiB | 3.49 MiB | 3.49 MiB |
| arena_tail_free_bytes | 13.63 MiB | 0 B | 13.63 MiB | 13.63 MiB | 13.63 MiB |
| arena_init_free_bytes | 19.11 MiB | 0 B | 19.11 MiB | 19.11 MiB | 19.11 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## cards (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1672506us | 0us | 1672506us | 1672506us | 1672506us |
| boot_to_frame0_us | 1979077us | 0us | 1979077us | 1979077us | 1979077us |
| avg_frame_interval_us | 22386us | 0us | 22386us | 22386us | 22386us |
| max_frame_interval_us | 417151us | 0us | 417151us | 417151us | 417151us |
| avg_js_us | 6190us | 0us | 6190us | 6190us | 6190us |
| avg_jobs_us | 475us | 0us | 475us | 475us | 475us |
| avg_tick_us | 184us | 0us | 184us | 184us | 184us |
| avg_draw_us | 2379us | 0us | 2379us | 2379us | 2379us |
| avg_render_us | 433us | 0us | 433us | 433us | 433us |
| avg_work_us | 9663us | 0us | 9663us | 9663us | 9663us |
| max_work_us | 403328us | 0us | 403328us | 403328us | 403328us |
| stack_free_bytes | 738.2 KiB | 0 B | 738.2 KiB | 738.2 KiB | 738.2 KiB |
| host_wall_ms | 470.7ms | 6.0ms | 464.9ms | 468.3ms | 482.3ms |
| bundle_bytes | 311.0 KiB | 0 B | 311.0 KiB | 311.0 KiB | 311.0 KiB |
| pak_bytes | 147.7 KiB | 0 B | 147.7 KiB | 147.7 KiB | 147.7 KiB |
| arena_capacity_bytes | 17.06 MiB | 0 B | 17.06 MiB | 17.06 MiB | 17.06 MiB |
| arena_bump_bytes | 4.17 MiB | 0 B | 4.17 MiB | 4.17 MiB | 4.17 MiB |
| arena_tail_free_bytes | 12.89 MiB | 0 B | 12.89 MiB | 12.89 MiB | 12.89 MiB |
| arena_init_free_bytes | 19.06 MiB | 0 B | 19.06 MiB | 19.06 MiB | 19.06 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## stats (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 701978us | 0us | 701978us | 701978us | 701978us |
| boot_to_frame0_us | 1044203us | 0us | 1044203us | 1044203us | 1044203us |
| avg_frame_interval_us | 19715us | 0us | 19715us | 19715us | 19715us |
| max_frame_interval_us | 116469us | 0us | 116469us | 116469us | 116469us |
| avg_js_us | 4818us | 0us | 4818us | 4818us | 4818us |
| avg_jobs_us | 1us | 0us | 1us | 1us | 1us |
| avg_tick_us | 512us | 0us | 512us | 512us | 512us |
| avg_draw_us | 2725us | 0us | 2725us | 2725us | 2725us |
| avg_render_us | 574us | 0us | 574us | 574us | 574us |
| avg_work_us | 8633us | 0us | 8633us | 8633us | 8633us |
| max_work_us | 107585us | 0us | 107585us | 107585us | 107585us |
| stack_free_bytes | 711.5 KiB | 0 B | 711.5 KiB | 711.5 KiB | 711.5 KiB |
| host_wall_ms | 453.4ms | 7.2ms | 444.0ms | 450.4ms | 463.5ms |
| bundle_bytes | 108.4 KiB | 0 B | 108.4 KiB | 108.4 KiB | 108.4 KiB |
| pak_bytes | 140.5 KiB | 0 B | 140.5 KiB | 140.5 KiB | 140.5 KiB |
| arena_capacity_bytes | 17.26 MiB | 0 B | 17.26 MiB | 17.26 MiB | 17.26 MiB |
| arena_bump_bytes | 2.45 MiB | 0 B | 2.45 MiB | 2.45 MiB | 2.45 MiB |
| arena_tail_free_bytes | 14.82 MiB | 0 B | 14.82 MiB | 14.82 MiB | 14.82 MiB |
| arena_init_free_bytes | 19.26 MiB | 0 B | 19.26 MiB | 19.26 MiB | 19.26 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## stats (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1968671us | 0us | 1968671us | 1968671us | 1968671us |
| boot_to_frame0_us | 2328556us | 0us | 2328556us | 2328556us | 2328556us |
| avg_frame_interval_us | 21400us | 0us | 21400us | 21400us | 21400us |
| max_frame_interval_us | 199887us | 0us | 199887us | 199887us | 199887us |
| avg_js_us | 3544us | 0us | 3544us | 3544us | 3544us |
| avg_jobs_us | 3313us | 0us | 3313us | 3313us | 3313us |
| avg_tick_us | 725us | 0us | 725us | 725us | 725us |
| avg_draw_us | 2920us | 0us | 2920us | 2920us | 2920us |
| avg_render_us | 574us | 0us | 574us | 574us | 574us |
| avg_work_us | 11078us | 0us | 11078us | 11078us | 11078us |
| max_work_us | 191784us | 0us | 191784us | 191784us | 191784us |
| stack_free_bytes | 534.3 KiB | 0 B | 534.3 KiB | 534.3 KiB | 534.3 KiB |
| host_wall_ms | 596.4ms | 9.5ms | 586.7ms | 590.8ms | 609.9ms |
| bundle_bytes | 259.3 KiB | 0 B | 259.3 KiB | 259.3 KiB | 259.3 KiB |
| pak_bytes | 140.5 KiB | 0 B | 140.5 KiB | 140.5 KiB | 140.5 KiB |
| arena_capacity_bytes | 17.12 MiB | 0 B | 17.12 MiB | 17.12 MiB | 17.12 MiB |
| arena_bump_bytes | 4.48 MiB | 0 B | 4.48 MiB | 4.48 MiB | 4.48 MiB |
| arena_tail_free_bytes | 12.64 MiB | 0 B | 12.64 MiB | 12.64 MiB | 12.64 MiB |
| arena_init_free_bytes | 19.12 MiB | 0 B | 19.12 MiB | 19.12 MiB | 19.12 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## stats (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 2158258us | 0us | 2158258us | 2158258us | 2158258us |
| boot_to_frame0_us | 2528828us | 0us | 2528828us | 2528828us | 2528828us |
| avg_frame_interval_us | 292883us | 0us | 292883us | 292883us | 292883us |
| max_frame_interval_us | 1217883us | 0us | 1217883us | 1217883us | 1217883us |
| avg_js_us | 254147us | 0us | 254147us | 254147us | 254147us |
| avg_jobs_us | 21937us | 0us | 21937us | 21937us | 21937us |
| avg_tick_us | 508us | 0us | 508us | 508us | 508us |
| avg_draw_us | 2748us | 0us | 2748us | 2748us | 2748us |
| avg_render_us | 572us | 0us | 572us | 572us | 572us |
| avg_work_us | 279914us | 0us | 279914us | 279914us | 279914us |
| max_work_us | 1214654us | 0us | 1214654us | 1214654us | 1214654us |
| stack_free_bytes | 683.8 KiB | 0 B | 683.8 KiB | 683.8 KiB | 683.8 KiB |
| host_wall_ms | 2854.3ms | 11.3ms | 2834.2ms | 2855.7ms | 2866.1ms |
| bundle_bytes | 319.6 KiB | 0 B | 319.6 KiB | 319.6 KiB | 319.6 KiB |
| pak_bytes | 140.5 KiB | 0 B | 140.5 KiB | 140.5 KiB | 140.5 KiB |
| arena_capacity_bytes | 17.06 MiB | 0 B | 17.06 MiB | 17.06 MiB | 17.06 MiB |
| arena_bump_bytes | 16.87 MiB | 0 B | 16.87 MiB | 16.87 MiB | 16.87 MiB |
| arena_tail_free_bytes | 196.3 KiB | 0 B | 196.3 KiB | 196.3 KiB | 196.3 KiB |
| arena_init_free_bytes | 19.06 MiB | 0 B | 19.06 MiB | 19.06 MiB | 19.06 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## library (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 600022us | 0us | 600022us | 600022us | 600022us |
| boot_to_frame0_us | 910618us | 0us | 910618us | 910618us | 910618us |
| avg_frame_interval_us | 18504us | 0us | 18504us | 18504us | 18504us |
| max_frame_interval_us | 105694us | 0us | 105694us | 105694us | 105694us |
| avg_js_us | 2989us | 0us | 2989us | 2989us | 2989us |
| avg_jobs_us | 205us | 0us | 205us | 205us | 205us |
| avg_tick_us | 183us | 0us | 183us | 183us | 183us |
| avg_draw_us | 983us | 0us | 983us | 983us | 983us |
| avg_render_us | 244us | 0us | 244us | 244us | 244us |
| avg_work_us | 4606us | 0us | 4606us | 4606us | 4606us |
| max_work_us | 103562us | 0us | 103562us | 103562us | 103562us |
| stack_free_bytes | 720.1 KiB | 0 B | 720.1 KiB | 720.1 KiB | 720.1 KiB |
| host_wall_ms | 341.0ms | 7.4ms | 331.0ms | 344.2ms | 350.1ms |
| bundle_bytes | 108.1 KiB | 0 B | 108.1 KiB | 108.1 KiB | 108.1 KiB |
| pak_bytes | 353.0 KiB | 0 B | 353.0 KiB | 353.0 KiB | 353.0 KiB |
| arena_capacity_bytes | 17.06 MiB | 0 B | 17.06 MiB | 17.06 MiB | 17.06 MiB |
| arena_bump_bytes | 2.64 MiB | 0 B | 2.64 MiB | 2.64 MiB | 2.64 MiB |
| arena_tail_free_bytes | 14.42 MiB | 0 B | 14.42 MiB | 14.42 MiB | 14.42 MiB |
| arena_init_free_bytes | 19.06 MiB | 0 B | 19.06 MiB | 19.06 MiB | 19.06 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## library (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1805153us | 0us | 1805153us | 1805153us | 1805153us |
| boot_to_frame0_us | 2145545us | 0us | 2145545us | 2145545us | 2145545us |
| avg_frame_interval_us | 19485us | 0us | 19485us | 19485us | 19485us |
| max_frame_interval_us | 155730us | 0us | 155730us | 155730us | 155730us |
| avg_js_us | 2195us | 0us | 2195us | 2195us | 2195us |
| avg_jobs_us | 2165us | 0us | 2165us | 2165us | 2165us |
| avg_tick_us | 299us | 0us | 299us | 299us | 299us |
| avg_draw_us | 1146us | 0us | 1146us | 1146us | 1146us |
| avg_render_us | 244us | 0us | 244us | 244us | 244us |
| avg_work_us | 6051us | 0us | 6051us | 6051us | 6051us |
| max_work_us | 149259us | 0us | 149259us | 149259us | 149259us |
| stack_free_bytes | 554.9 KiB | 0 B | 554.9 KiB | 554.9 KiB | 554.9 KiB |
| host_wall_ms | 462.3ms | 10.5ms | 452.3ms | 456.6ms | 478.1ms |
| bundle_bytes | 260.0 KiB | 0 B | 260.0 KiB | 260.0 KiB | 260.0 KiB |
| pak_bytes | 350.9 KiB | 0 B | 350.9 KiB | 350.9 KiB | 350.9 KiB |
| arena_capacity_bytes | 16.91 MiB | 0 B | 16.91 MiB | 16.91 MiB | 16.91 MiB |
| arena_bump_bytes | 4.55 MiB | 0 B | 4.55 MiB | 4.55 MiB | 4.55 MiB |
| arena_tail_free_bytes | 12.36 MiB | 0 B | 12.36 MiB | 12.36 MiB | 12.36 MiB |
| arena_init_free_bytes | 18.91 MiB | 0 B | 18.91 MiB | 18.91 MiB | 18.91 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## library (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1761956us | 0us | 1761956us | 1761956us | 1761956us |
| boot_to_frame0_us | 2094800us | 0us | 2094800us | 2094800us | 2094800us |
| avg_frame_interval_us | 63927us | 0us | 63927us | 63927us | 63927us |
| max_frame_interval_us | 355930us | 0us | 355930us | 355930us | 355930us |
| avg_js_us | 45119us | 0us | 45119us | 45119us | 45119us |
| avg_jobs_us | 4205us | 0us | 4205us | 4205us | 4205us |
| avg_tick_us | 186us | 0us | 186us | 186us | 186us |
| avg_draw_us | 1002us | 0us | 1002us | 1002us | 1002us |
| avg_render_us | 244us | 0us | 244us | 244us | 244us |
| avg_work_us | 50758us | 0us | 50758us | 50758us | 50758us |
| max_work_us | 343449us | 0us | 343449us | 343449us | 343449us |
| stack_free_bytes | 662.4 KiB | 0 B | 662.4 KiB | 662.4 KiB | 662.4 KiB |
| host_wall_ms | 877.4ms | 5.4ms | 870.7ms | 878.3ms | 884.9ms |
| bundle_bytes | 318.9 KiB | 0 B | 318.9 KiB | 318.9 KiB | 318.9 KiB |
| pak_bytes | 350.9 KiB | 0 B | 350.9 KiB | 350.9 KiB | 350.9 KiB |
| arena_capacity_bytes | 16.85 MiB | 0 B | 16.85 MiB | 16.85 MiB | 16.85 MiB |
| arena_bump_bytes | 7.07 MiB | 0 B | 7.07 MiB | 7.07 MiB | 7.07 MiB |
| arena_tail_free_bytes | 9.78 MiB | 0 B | 9.78 MiB | 9.78 MiB | 9.78 MiB |
| arena_init_free_bytes | 18.85 MiB | 0 B | 18.85 MiB | 18.85 MiB | 18.85 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## settings (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 671193us | 0us | 671193us | 671193us | 671193us |
| boot_to_frame0_us | 977857us | 0us | 977857us | 977857us | 977857us |
| avg_frame_interval_us | 19029us | 0us | 19029us | 19029us | 19029us |
| max_frame_interval_us | 83673us | 0us | 83673us | 83673us | 83673us |
| avg_js_us | 2777us | 0us | 2777us | 2777us | 2777us |
| avg_jobs_us | 360us | 0us | 360us | 360us | 360us |
| avg_tick_us | 522us | 0us | 522us | 522us | 522us |
| avg_draw_us | 3208us | 0us | 3208us | 3208us | 3208us |
| avg_render_us | 838us | 0us | 838us | 838us | 838us |
| avg_work_us | 7708us | 0us | 7708us | 7708us | 7708us |
| max_work_us | 83022us | 0us | 83022us | 83022us | 83022us |
| stack_free_bytes | 711.6 KiB | 0 B | 711.6 KiB | 711.6 KiB | 711.6 KiB |
| host_wall_ms | 345.8ms | 6.1ms | 340.7ms | 343.7ms | 357.8ms |
| bundle_bytes | 116.9 KiB | 0 B | 116.9 KiB | 116.9 KiB | 116.9 KiB |
| pak_bytes | 150.0 KiB | 0 B | 150.0 KiB | 150.0 KiB | 150.0 KiB |
| arena_capacity_bytes | 17.25 MiB | 0 B | 17.25 MiB | 17.25 MiB | 17.25 MiB |
| arena_bump_bytes | 2.22 MiB | 0 B | 2.22 MiB | 2.22 MiB | 2.22 MiB |
| arena_tail_free_bytes | 15.03 MiB | 0 B | 15.03 MiB | 15.03 MiB | 15.03 MiB |
| arena_init_free_bytes | 19.25 MiB | 0 B | 19.25 MiB | 19.25 MiB | 19.25 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## settings (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1891076us | 0us | 1891076us | 1891076us | 1891076us |
| boot_to_frame0_us | 2228794us | 0us | 2228794us | 2228794us | 2228794us |
| avg_frame_interval_us | 19683us | 0us | 19683us | 19683us | 19683us |
| max_frame_interval_us | 114799us | 0us | 114799us | 114799us | 114799us |
| avg_js_us | 2613us | 0us | 2613us | 2613us | 2613us |
| avg_jobs_us | 1380us | 0us | 1380us | 1380us | 1380us |
| avg_tick_us | 552us | 0us | 552us | 552us | 552us |
| avg_draw_us | 3402us | 0us | 3402us | 3402us | 3402us |
| avg_render_us | 835us | 0us | 835us | 835us | 835us |
| avg_work_us | 8784us | 0us | 8784us | 8784us | 8784us |
| max_work_us | 103329us | 0us | 103329us | 103329us | 103329us |
| stack_free_bytes | 551.5 KiB | 0 B | 551.5 KiB | 551.5 KiB | 551.5 KiB |
| host_wall_ms | 454.3ms | 5.1ms | 448.2ms | 454.9ms | 463.9ms |
| bundle_bytes | 267.3 KiB | 0 B | 267.3 KiB | 267.3 KiB | 267.3 KiB |
| pak_bytes | 148.6 KiB | 0 B | 148.6 KiB | 148.6 KiB | 148.6 KiB |
| arena_capacity_bytes | 17.10 MiB | 0 B | 17.10 MiB | 17.10 MiB | 17.10 MiB |
| arena_bump_bytes | 4.17 MiB | 0 B | 4.17 MiB | 4.17 MiB | 4.17 MiB |
| arena_tail_free_bytes | 12.93 MiB | 0 B | 12.93 MiB | 12.93 MiB | 12.93 MiB |
| arena_init_free_bytes | 19.10 MiB | 0 B | 19.10 MiB | 19.10 MiB | 19.10 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## settings (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1886720us | 0us | 1886720us | 1886720us | 1886720us |
| boot_to_frame0_us | 2228794us | 0us | 2228794us | 2228794us | 2228794us |
| avg_frame_interval_us | 38939us | 0us | 38939us | 38939us | 38939us |
| max_frame_interval_us | 567238us | 0us | 567238us | 567238us | 567238us |
| avg_js_us | 20707us | 0us | 20707us | 20707us | 20707us |
| avg_jobs_us | 2255us | 0us | 2255us | 2255us | 2255us |
| avg_tick_us | 433us | 0us | 433us | 433us | 433us |
| avg_draw_us | 3208us | 0us | 3208us | 3208us | 3208us |
| avg_render_us | 835us | 0us | 835us | 835us | 835us |
| avg_work_us | 27440us | 0us | 27440us | 27440us | 27440us |
| max_work_us | 554901us | 0us | 554901us | 554901us | 554901us |
| stack_free_bytes | 694.9 KiB | 0 B | 694.9 KiB | 694.9 KiB | 694.9 KiB |
| host_wall_ms | 591.6ms | 15.1ms | 578.6ms | 589.1ms | 624.0ms |
| bundle_bytes | 325.6 KiB | 0 B | 325.6 KiB | 325.6 KiB | 325.6 KiB |
| pak_bytes | 148.5 KiB | 0 B | 148.5 KiB | 148.5 KiB | 148.5 KiB |
| arena_capacity_bytes | 17.04 MiB | 0 B | 17.04 MiB | 17.04 MiB | 17.04 MiB |
| arena_bump_bytes | 5.97 MiB | 0 B | 5.97 MiB | 5.97 MiB | 5.97 MiB |
| arena_tail_free_bytes | 11.07 MiB | 0 B | 11.07 MiB | 11.07 MiB | 11.07 MiB |
| arena_init_free_bytes | 19.04 MiB | 0 B | 19.04 MiB | 19.04 MiB | 19.04 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## notifications (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 642845us | 0us | 642845us | 642845us | 642845us |
| boot_to_frame0_us | 960853us | 0us | 960853us | 960853us | 960853us |
| avg_frame_interval_us | 19424us | 0us | 19424us | 19424us | 19424us |
| max_frame_interval_us | 93673us | 0us | 93673us | 93673us | 93673us |
| avg_js_us | 2706us | 0us | 2706us | 2706us | 2706us |
| avg_jobs_us | 596us | 0us | 596us | 596us | 596us |
| avg_tick_us | 516us | 0us | 516us | 516us | 516us |
| avg_draw_us | 1186us | 0us | 1186us | 1186us | 1186us |
| avg_render_us | 543us | 0us | 543us | 543us | 543us |
| avg_work_us | 5549us | 0us | 5549us | 5549us | 5549us |
| max_work_us | 80911us | 0us | 80911us | 80911us | 80911us |
| stack_free_bytes | 712.4 KiB | 0 B | 712.4 KiB | 712.4 KiB | 712.4 KiB |
| host_wall_ms | 307.0ms | 5.1ms | 297.9ms | 307.3ms | 313.5ms |
| bundle_bytes | 107.5 KiB | 0 B | 107.5 KiB | 107.5 KiB | 107.5 KiB |
| pak_bytes | 166.7 KiB | 0 B | 166.7 KiB | 166.7 KiB | 166.7 KiB |
| arena_capacity_bytes | 17.24 MiB | 0 B | 17.24 MiB | 17.24 MiB | 17.24 MiB |
| arena_bump_bytes | 2.21 MiB | 0 B | 2.21 MiB | 2.21 MiB | 2.21 MiB |
| arena_tail_free_bytes | 15.03 MiB | 0 B | 15.03 MiB | 15.03 MiB | 15.03 MiB |
| arena_init_free_bytes | 19.24 MiB | 0 B | 19.24 MiB | 19.24 MiB | 19.24 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## notifications (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1834713us | 0us | 1834713us | 1834713us | 1834713us |
| boot_to_frame0_us | 2161346us | 0us | 2161346us | 2161346us | 2161346us |
| avg_frame_interval_us | 22439us | 0us | 22439us | 22439us | 22439us |
| max_frame_interval_us | 200069us | 0us | 200069us | 200069us | 200069us |
| avg_js_us | 2793us | 0us | 2793us | 2793us | 2793us |
| avg_jobs_us | 3767us | 0us | 3767us | 3767us | 3767us |
| avg_tick_us | 703us | 0us | 703us | 703us | 703us |
| avg_draw_us | 1255us | 0us | 1255us | 1255us | 1255us |
| avg_render_us | 520us | 0us | 520us | 520us | 520us |
| avg_work_us | 9040us | 0us | 9040us | 9040us | 9040us |
| max_work_us | 189299us | 0us | 189299us | 189299us | 189299us |
| stack_free_bytes | 592.3 KiB | 0 B | 592.3 KiB | 592.3 KiB | 592.3 KiB |
| host_wall_ms | 428.1ms | 6.0ms | 418.4ms | 429.0ms | 438.1ms |
| bundle_bytes | 254.6 KiB | 0 B | 254.6 KiB | 254.6 KiB | 254.6 KiB |
| pak_bytes | 165 KiB | 0 B | 165 KiB | 165 KiB | 165 KiB |
| arena_capacity_bytes | 17.10 MiB | 0 B | 17.10 MiB | 17.10 MiB | 17.10 MiB |
| arena_bump_bytes | 3.70 MiB | 0 B | 3.70 MiB | 3.70 MiB | 3.70 MiB |
| arena_tail_free_bytes | 13.40 MiB | 0 B | 13.40 MiB | 13.40 MiB | 13.40 MiB |
| arena_init_free_bytes | 19.10 MiB | 0 B | 19.10 MiB | 19.10 MiB | 19.10 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## notifications (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1894267us | 0us | 1894267us | 1894267us | 1894267us |
| boot_to_frame0_us | 2228104us | 0us | 2228104us | 2228104us | 2228104us |
| avg_frame_interval_us | 285835us | 0us | 285835us | 285835us | 285835us |
| max_frame_interval_us | 784117us | 0us | 784117us | 784117us | 784117us |
| avg_js_us | 247511us | 0us | 247511us | 247511us | 247511us |
| avg_jobs_us | 21503us | 0us | 21503us | 21503us | 21503us |
| avg_tick_us | 502us | 0us | 502us | 502us | 502us |
| avg_draw_us | 1173us | 0us | 1173us | 1173us | 1173us |
| avg_render_us | 520us | 0us | 520us | 520us | 520us |
| avg_work_us | 271212us | 0us | 271212us | 271212us | 271212us |
| max_work_us | 771845us | 0us | 771845us | 771845us | 771845us |
| stack_free_bytes | 696.5 KiB | 0 B | 696.5 KiB | 696.5 KiB | 696.5 KiB |
| host_wall_ms | 1734.2ms | 8.0ms | 1724.5ms | 1732.6ms | 1747.5ms |
| bundle_bytes | 311.2 KiB | 0 B | 311.2 KiB | 311.2 KiB | 311.2 KiB |
| pak_bytes | 165 KiB | 0 B | 165 KiB | 165 KiB | 165 KiB |
| arena_capacity_bytes | 17.04 MiB | 0 B | 17.04 MiB | 17.04 MiB | 17.04 MiB |
| arena_bump_bytes | 11.16 MiB | 0 B | 11.16 MiB | 11.16 MiB | 11.16 MiB |
| arena_tail_free_bytes | 5.88 MiB | 0 B | 5.88 MiB | 5.88 MiB | 5.88 MiB |
| arena_init_free_bytes | 19.04 MiB | 0 B | 19.04 MiB | 19.04 MiB | 19.04 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## music (solid)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 601273us | 0us | 601273us | 601273us | 601273us |
| boot_to_frame0_us | 911290us | 0us | 911290us | 911290us | 911290us |
| avg_frame_interval_us | 23621us | 0us | 23621us | 23621us | 23621us |
| max_frame_interval_us | 86978us | 0us | 86978us | 86978us | 86978us |
| avg_js_us | 5604us | 0us | 5604us | 5604us | 5604us |
| avg_jobs_us | 390us | 0us | 390us | 390us | 390us |
| avg_tick_us | 4508us | 0us | 4508us | 4508us | 4508us |
| avg_draw_us | 1953us | 0us | 1953us | 1953us | 1953us |
| avg_render_us | 580us | 0us | 580us | 580us | 580us |
| avg_work_us | 13037us | 0us | 13037us | 13037us | 13037us |
| max_work_us | 84824us | 0us | 84824us | 84824us | 84824us |
| stack_free_bytes | 755.1 KiB | 0 B | 755.1 KiB | 755.1 KiB | 755.1 KiB |
| host_wall_ms | 364.6ms | 4.2ms | 360.7ms | 363.5ms | 373.8ms |
| bundle_bytes | 101.1 KiB | 0 B | 101.1 KiB | 101.1 KiB | 101.1 KiB |
| pak_bytes | 155.9 KiB | 0 B | 155.9 KiB | 155.9 KiB | 155.9 KiB |
| arena_capacity_bytes | 17.26 MiB | 0 B | 17.26 MiB | 17.26 MiB | 17.26 MiB |
| arena_bump_bytes | 2.25 MiB | 0 B | 2.25 MiB | 2.25 MiB | 2.25 MiB |
| arena_tail_free_bytes | 15.00 MiB | 0 B | 15.00 MiB | 15.00 MiB | 15.00 MiB |
| arena_init_free_bytes | 19.26 MiB | 0 B | 19.26 MiB | 19.26 MiB | 19.26 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## music (vue-vapor)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1815607us | 0us | 1815607us | 1815607us | 1815607us |
| boot_to_frame0_us | 2162224us | 0us | 2162224us | 2162224us | 2162224us |
| avg_frame_interval_us | 23305us | 0us | 23305us | 23305us | 23305us |
| max_frame_interval_us | 123669us | 0us | 123669us | 123669us | 123669us |
| avg_js_us | 3432us | 0us | 3432us | 3432us | 3432us |
| avg_jobs_us | 7314us | 0us | 7314us | 7314us | 7314us |
| avg_tick_us | 2610us | 0us | 2610us | 2610us | 2610us |
| avg_draw_us | 2182us | 0us | 2182us | 2182us | 2182us |
| avg_render_us | 577us | 0us | 577us | 577us | 577us |
| avg_work_us | 16117us | 0us | 16117us | 16117us | 16117us |
| max_work_us | 111336us | 0us | 111336us | 111336us | 111336us |
| stack_free_bytes | 638.6 KiB | 0 B | 638.6 KiB | 638.6 KiB | 638.6 KiB |
| host_wall_ms | 515.6ms | 6.6ms | 506.2ms | 516.8ms | 526.3ms |
| bundle_bytes | 255.5 KiB | 0 B | 255.5 KiB | 255.5 KiB | 255.5 KiB |
| pak_bytes | 154.3 KiB | 0 B | 154.3 KiB | 154.3 KiB | 154.3 KiB |
| arena_capacity_bytes | 17.11 MiB | 0 B | 17.11 MiB | 17.11 MiB | 17.11 MiB |
| arena_bump_bytes | 3.64 MiB | 0 B | 3.64 MiB | 3.64 MiB | 3.64 MiB |
| arena_tail_free_bytes | 13.47 MiB | 0 B | 13.47 MiB | 13.47 MiB | 13.47 MiB |
| arena_init_free_bytes | 19.11 MiB | 0 B | 19.11 MiB | 19.11 MiB | 19.11 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

## music (octane)

| metric | mean | sd | min | median | max |
|---|---:|---:|---:|---:|---:|
| eval_us | 1816520us | 0us | 1816520us | 1816520us | 1816520us |
| boot_to_frame0_us | 2146209us | 0us | 2146209us | 2146209us | 2146209us |
| avg_frame_interval_us | 292181us | 0us | 292181us | 292181us | 292181us |
| max_frame_interval_us | 717384us | 0us | 717384us | 717384us | 717384us |
| avg_js_us | 258133us | 0us | 258133us | 258133us | 258133us |
| avg_jobs_us | 19576us | 0us | 19576us | 19576us | 19576us |
| avg_tick_us | 2446us | 0us | 2446us | 2446us | 2446us |
| avg_draw_us | 1972us | 0us | 1972us | 1972us | 1972us |
| avg_render_us | 584us | 0us | 584us | 584us | 584us |
| avg_work_us | 282713us | 0us | 282713us | 282713us | 282713us |
| max_work_us | 705206us | 0us | 705206us | 705206us | 705206us |
| stack_free_bytes | 714.5 KiB | 0 B | 714.5 KiB | 714.5 KiB | 714.5 KiB |
| host_wall_ms | 2509.2ms | 10.7ms | 2495.5ms | 2509.7ms | 2526.2ms |
| bundle_bytes | 313.5 KiB | 0 B | 313.5 KiB | 313.5 KiB | 313.5 KiB |
| pak_bytes | 154.3 KiB | 0 B | 154.3 KiB | 154.3 KiB | 154.3 KiB |
| arena_capacity_bytes | 17.05 MiB | 0 B | 17.05 MiB | 17.05 MiB | 17.05 MiB |
| arena_bump_bytes | 11.72 MiB | 0 B | 11.72 MiB | 11.72 MiB | 11.72 MiB |
| arena_tail_free_bytes | 5.33 MiB | 0 B | 5.33 MiB | 5.33 MiB | 5.33 MiB |
| arena_init_free_bytes | 19.05 MiB | 0 B | 19.05 MiB | 19.05 MiB | 19.05 MiB |
| arena_configured_bytes | 0 B | 0 B | 0 B | 0 B | 0 B |

