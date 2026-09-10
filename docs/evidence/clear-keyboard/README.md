# Clear keyboard follow-up

Captured on 2026-09-10. [receipts.json](receipts.json) records the installed builds, native runtime counters, icon sampling flags and screenshot hashes. The [earlier IME acceptance](../clear-ime/README.md) covers candidate conversion and reconnect.

| Check | iPod touch 4 | Moto G Play 2024 |
| --- | --- | --- |
| Type `abcdef`, hold Space, drag three characters left | [abc caret def](ipod-caret.png) | [abc caret def](moto-caret.png) |
| Hold Space: keys dim and the rail appears | [Trackpad](ipod-trackpad.png) | [Trackpad](moto-trackpad.png) |
| Insert z at caret, hold Backspace, release, type q; q remains | [q caret def](ipod-repeat-release.png) | [q caret def](moto-repeat-release.png) |

**These are physical-device frames driven by software-generated native input.** iPod uses UIKit/GraphicsServices; Moto uses Android MotionEvent. Physical finger feel and tactile feedback are outside this evidence. The character step, direction hysteresis, cancellation, overlapping contacts, repeat acceleration and popup dwell/fade are also covered by deterministic tests at 30, 60 and 120 Hz where applicable.

All six SVG icons are baked with supersampled coverage at density 2. Both installed packs carry image flag 2 (`IMG_FLAG_LINEAR`) for every icon. The globe, circled cross and backspace symbol retain gray edge coverage at their displayed sizes. Small rounded gradients share density-scaled corner masks, with at most six center gradient quads for a three-stop fill. Corner colors and center gradients retain the same global stops in all four directions; the tests cover density 2 and 3 and texture reuse after color changes.

The native interaction starts with an empty row in EN mode. On iPod, the a/b/c/d/e/f centers are `(32,366) (192,410) (128,410) (96,366) (80,322) (128,366)`. Space starts at `(166,454)` and moves to `(136,454)` after a 1,200 ms hold. On Moto the centers are `(72,1372) (432,1460) (288,1460) (216,1372) (180,1284) (288,1372)`. Space moves from `(374,1548)` to `(314,1548)` after 500 ms. The coordinates differ because Android input uses physical pixels and the iPod helper uses logical points.

Build the iPod sender with `bun tools/ime/build-ipod-tap.ts`. Its CLI is `x y [hold-ms [end-x end-y drag-ms]]`, targeting only the Clear bundle. Android uses `input motionevent DOWN/MOVE/UP`. Hold Backspace at `(300,410)` for 2,000 ms on iPod or `(670,1460)` for 1,200 ms on Moto, then release and type q. Both frames show `q|def` after a pause, demonstrating that deletion stops at release.

**Hold and popup deadlines use virtual time.** A host delivering fewer than 60 frames per second takes longer to reach those deadlines. The iPod timed windows during this run varied from about 17 to 31 frames per second with the editor open; this record does not claim a 60 FPS keyboard or a fixed wall-clock hold threshold. Runtime records preserve the measured window instead of treating the simulation rate as delivered FPS.

Validation: all 12 repository stages, 130 shared-core tests, TypeScript, and 17 focused keyboard/Clear tests passed. The popup pixel test verifies quick-tap dwell, retention through a held character, and eventual fade; no physical popup timing measurement is claimed.
