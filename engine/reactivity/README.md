# QuickJS native reactivity experiment

**This is a Solid API subset for numbers and booleans, with compatibility limited to the tested behavior.** It does not replace PocketJS's Solid runtime. The experiment compares production Solid, a small JavaScript graph, and the same graph algorithm in C, all inside the same QuickJS runner.

The C library has no QuickJS dependency. `bindings/quickjs/` retains JS callbacks and exposes function accessors; `benchmarks/reference.js` implements the C graph's scheduling and ownership rules in JavaScript. The `reactivity` import in tests, examples, and benchmarks is an experiment-local build alias. PocketJS application imports remain unchanged.

## Build and run

Requirements: Linux or macOS, C11 compiler, CMake, Node.js and npm. The recorded run uses Linux. Download the pinned [QuickJS release](https://bellard.org/quickjs/quickjs-2025-09-13-2.tar.xz) outside the repository:

```sh
curl -L --fail -o /tmp/quickjs-reactivity.tar.xz https://bellard.org/quickjs/quickjs-2025-09-13-2.tar.xz
printf '%s\n' '996c6b5018fc955ad4d06426d0e9cb713685a00c825aa5c0418bd53f7df8b0b4  /tmp/quickjs-reactivity.tar.xz' | sha256sum -c -
tar -xf /tmp/quickjs-reactivity.tar.xz -C /tmp
cd engine/reactivity
npm ci --ignore-scripts
cmake -S . -B build -DQUICKJS_DIR=/tmp/quickjs-2025-09-13 -DCMAKE_BUILD_TYPE=Release
cmake --build build -j4
ctest --test-dir build --output-on-failure
npm test
node benchmarks/run.mjs example
npm run --silent bench > results.jsonl
```

On macOS, use `shasum -a 256` to check the archive digest. `REACTIVITY_RUNNER=/path/to/reactivity-runner` selects another build. npm dependencies and the QuickJS archive are pinned; no root dependency or runtime configuration changes are needed. The runner evaluates one bundled script per process and exits with a nonzero status on an uncaught exception. It does not implement module loading or an event loop.

`-DREACTIVITY_BUILD_RUNNER=OFF` builds the C library and its CTest without QuickJS or npm dependencies.

To check C allocation lifetimes and undefined behavior:

```sh
cmake -S . -B build-asan -DQUICKJS_DIR=/tmp/quickjs-2025-09-13 \
  -DCMAKE_BUILD_TYPE=Debug \
  '-DCMAKE_C_FLAGS=-fsanitize=address,undefined -fno-omit-frame-pointer'
cmake --build build-asan -j4
ASAN_OPTIONS=detect_leaks=1 ctest --test-dir build-asan --output-on-failure
ASAN_OPTIONS=detect_leaks=1 REACTIVITY_RUNNER="$PWD/build-asan/reactivity-runner" npm test
```

## Supported behavior

| API | Behavior covered by shared tests |
| --- | --- |
| `createSignal(value)` | Getter/setter pair, dynamic read tracking, `===` equality, numeric/boolean values, updater functions and setter return values |
| `createMemo(fn, initial?)` | Initial execution at creation, cached reads, eager updates, changing dependencies, previous value argument, unchanged-result suppression |
| `createComputed(fn, initial?)` | Initial execution at creation, synchronous propagation, optional undefined return |
| `createRoot(fn)` | Callback result, disposal function, owned-computation cleanup and repeat disposal |

The shared suite covers branch removal, duplicate reads, diamonds, dependencies created after their consumers, `NaN`, signed zero, boolean/number distinction, nested computations, detached nested roots, disposal from an executing observer, and exception identity at creation. A seeded 500-update graph compares every computation's execution count, observer counts, final values and a checksum against Solid. Five additional checks for the two subsets reject objects, options, async roots, Promise memo results and reentrant writes.

**Computations belong to the current owner; signals do not.** A computation's rerun disposes its previous child computations. A nested root requires its own explicit disposal, matching the covered Solid root behavior. Signal accessors survive root disposal. JS callback references and incoming dependency vectors are released when a computation is disposed.

**Disposed node records remain allocated until graph shutdown.** Signal records also remain until shutdown, even if JS drops all their accessors. Observer-vector capacity can remain after edges are removed. Native handles therefore cannot dangle, but repeated creation/disposal grows retained memory. The JS algorithm control retains node records too. This is a measured prototype limitation, not a production reclamation strategy. Callback captures appear in QuickJS heap accounting, while callback wrapper structs appear in native accounting.

## Graph and boundary

A read adds a source/observer edge to the executing computation. Duplicate reads add one edge. A changed signal marks its direct subscribers dirty and downstream subscribers pending. Before a subscriber runs, the scheduler updates its sources. Pending subscribers whose memo sources have unchanged results skip their callbacks. Updating a memo from a read also resolves dependencies introduced by a branch change. Every setter drains the update queue before returning.

`core/reactivity.h` exposes graph creation, numeric/boolean values, reads, writes, callbacks and disposal. Node kinds are signal (0), memo (1), observer (2) and root (3). A computation callback returns zero on success and a nonzero value on failure. C callers must use nodes from the same live graph, restore owner/listener scopes, initialize computations with `rx_update`, and avoid cycles or reentrant writes. Graph shutdown invalidates every node pointer. The C library aborts on allocation failure in this version; it is not ready for a memory-constrained host's error policy.

The QuickJS binding owns callback `JSValue` references until disposal, retains a temporary reference across execution, restores tracking/ownership after exceptions, and tears down the graph before the QuickJS context. A failed propagation restores the tracking scopes and clears the queue; it is **not a transaction**. Values can have changed before the exception, and recovery semantics for the failed graph are outside the compatibility claim.

## Measurement

`benchmarks/run.mjs` bundles the same workload against:

1. **Solid 1.9.13's production client implementation** (`solid-js/dist/solid.js`), avoiding its Node server implementation.
2. The JavaScript algorithm control.
3. The native QuickJS binding.

There are six workloads: untracked reads, 128-way fanout, unchanged memo results, a 128-memo chain, branch switching, and expensive JS computation. Each uses 100 warmup updates and 2,000 timed updates. Three repetitions run in fresh processes, with implementation order rotated. Each row reports median/p95 update latency, callback counts and checksum. The driver fails if behavior differs across implementations or repetitions. An update includes the complete synchronous propagation; a branch update contains three setters, and an untracked update contains 128 reads plus a setter. Clock calls add overhead, which matters for the shortest updates.

Memory snapshots are taken before graph construction, after warmup, after timing and after disposal. `jsBytes` is QuickJS's `JSMemoryUsage.malloc_size`; `nativeBytes` counts graph structs, allocated vector capacity and native callback wrappers. Their sum is **accounted heap bytes**, excluding allocator headers, C stack and executable mappings. QuickJS snapshots include loaded code, closures and measurement arrays; no GC is forced. Baseline subtraction can help separate loaded-code cost, but is not an exact graph-only measurement. `peakRssBytes` is the process high-water resident set, including the runtime and code; it is not current memory or graph memory.

`jsToNative` and `nativeToJs` count calls through the reactive API, including root and updater callbacks. Metrics, printing and clock helpers are excluded. Solid and the JS control have zero reactive boundary crossings. Instrumentation remains enabled in timed runs. The counters are totals in snapshots and timed-region deltas in benchmark rows.

[Recorded desktop results](benchmarks/RESULTS.md) show the conditions and raw observations. They do not establish browser, device or whole-UI performance. **No real PocketJS renderer scenario or native UI property binding is implemented in this first experiment.** Before a migration decision, add a real host scene with frame-time and total-memory measurements, bounded handle reclamation, deeper ownership/error compatibility tests and target-device runs. An optional C-state-to-native-UI binding should be measured as a separate path, alongside the JS-callback workloads.

## Semantics references

The eager memo and equality behavior follows [Solid's createMemo documentation](https://docs.solidjs.com/reference/basic-reactivity/create-memo). The initial observer behavior follows [createComputed](https://docs.solidjs.com/reference/secondary-primitives/create-computed). Those references define the selected behavior; they do not imply compatibility with the remainder of Solid's APIs.

Stores, proxies, JSX, strings/objects as reactive values, custom comparators/options, effects, batching, transitions, async work, cleanup hooks and writes from computations are outside this version. The core and QuickJS API are experimental and may change.
