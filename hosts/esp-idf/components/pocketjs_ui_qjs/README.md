# pocketjs_ui_qjs

QuickJS binding for the PocketJS `ui` HostOps surface.

- Public header: `pocketjs/ui_qjs.h`
- Targets: ESP32-P4 and ESP32-S3
- Dependencies: `pocketjs_guest`, `pocketjs_ui_core`

The binding borrows a guest and core and derives its viewport and tick rate
from that core. Feed the target PAK, mount the binding, then evaluate the JS
bundle. `pocketjs_ui_turn` resolves touch-hit facts, runs one guest turn,
advances the core, and returns a frame view. **It does not render, present, or
create a task.** Destroy the guest before the mounted binding.
