# pocketjs_runner

Optional exact-cadence owner task for a mounted PocketJS UI guest.

- Public header: `pocketjs/runner.h`
- Targets: ESP32-P4 and ESP32-S3
- Dependency: `pocketjs_ui_qjs`

The runner samples hardware-neutral input, executes `pocketjs_ui_turn`, and
passes the frame view to `after_turn`. It never allocates display buffers or
presents pixels. Its cadence comes from the binding's UI core.
`pocketjs_runner_stop` interrupts a running JS turn, joins the task, and leaves
every borrowed guest/UI object owned by the caller.
