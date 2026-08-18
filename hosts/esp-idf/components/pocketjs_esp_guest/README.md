# PocketJS ESP-IDF Guest component

This component creates one task-owned QuickJS realm for an ESP-IDF product
Host. It installs only `console.*`; the realm has no filesystem, network,
timer, process, or UI authority until another product component installs a
private binding before evaluating the Guest bootstrap.

The component pins `espressif/quickjs-ng` 0.14.0. That is an explicit ESP-IDF
Host engine choice and is not the same source revision currently used by the
PSP/Vita hosts. A product capability cannot be admitted by build success alone;
it must run its Guest and protocol conformance suites against this engine.

All realm APIs are owner-task-only. Native workers can wake that task or queue
plain data, but they must never call these functions or QuickJS directly.
Calls from product schedulers into a registered Guest dispatcher use
`pocketjs_esp_guest_call_function()`, which applies the same monotonic timeout
and QuickJS interrupt-check budget as factory, frame, and Promise-job calls.

Product Hosts mount bundles as factories. The component freezes a private
native binding object and passes it directly to the factory; it never installs
that object on `globalThis`. Each eval, factory call, and Promise-job checkpoint
has optional wall-clock and QuickJS interrupt-check budgets. The scheduler also
receives an explicit pending-jobs result, so it cannot mistake a truncated
checkpoint for quiescence.

While a bounded Guest execution is active, the component gives FreeRTOS one
scheduler tick at 100 ms intervals. QuickJS bytecode reaches that checkpoint
through its interrupt hook; source parsing reaches it through sampled engine
allocations. **This keeps the idle task and system watchdog live while a large,
verified factory is parsed.** The yield counter is included in Guest stats.
Native code that neither invokes the engine interrupt hook nor allocates engine
memory remains the Host's responsibility and must be independently bounded.

The engine allocator can require PSRAM. That mode fails closed instead of
silently consuming internal DRAM when external memory is unavailable. Current
and high-water byte/count counters plus QuickJS object/memory totals are
observable through the component API. This is a Host resource measurement, not
a replacement for the network Core's independent queue and lease budgets.

The current network bring-up uses this component only for a private-ABI smoke.
It does not advertise a public PocketJS network capability.
