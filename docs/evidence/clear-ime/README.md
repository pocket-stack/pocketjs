# Clear IME device acceptance

Captured on 2026-09-09. [receipts.json](receipts.json) records build identity, installed APK readback, viewport, runtime counters and image hashes. Pairing keys are excluded.

| Device | Native runtime | Viewport | Acceptance |
| --- | --- | --- | --- |
| iPod touch 4 / iOS 6.1.6 | ARMv7 QuickJS-C, GLES1, POSIX offload worker | 320×480 logical, 640×960 physical | User-app byte readback, UIKit touch route, Chinese candidates, reconnect and one committed `你好` |
| Moto G Play 2024 / Android 14 | arm64 QuickJS-C, GLES2, POSIX offload worker | 360×800 logical, 720×1600 physical | Installed APK hash, MotionEvent touch route, Chinese candidates, reconnect and one committed `你好`; swipe completion and deletion |

For each device: open the first list, edit its first row, remove its seed text, type `ni`, stop the companion, type `hao`, restart the companion, select the first candidate, then press Return. The offline frame shows a retained composition; the restored frame shows `ni hao`; the committed frame shows one `你好`.

| Stage | iPod touch 4 | Moto G Play |
| --- | --- | --- |
| Companion stopped after `ni`; `hao` queued | [Offline frame](ipod-offline.png) | [Offline frame](moto-offline.png) |
| Companion restored; `ni hao` candidates | [Candidates](ipod-candidates.png) | [Candidates](moto-candidates.png) |
| Candidate selected | [Committed title](ipod-commit.png) | [Committed title](moto-commit.png) |

**The interaction evidence uses software-generated native touch events on the physical devices.** It does not establish a physical finger test. iPod frames come from the application's renderer capture; Android frames come from `screencap`.

The iPod test sender lives in `tools/ime/ipod-tap.c`; its GraphicsServices record layout follows the [iOS GraphicsServices ABI reference](https://github.com/mringwal/hid-support/blob/master/3rdParty/GraphicsServices/GSEvent.h). Build it with `bun tools/ime/build-ipod-tap.ts` after `bun ipodtouch4 build`. Copy the resulting `.pocket-build/pocket-ime-gstap` over the prepared SSH connection, sign as the build script does, and run it with logical `x y` coordinates. It targets `dev.pocket-stack.clear` and is never packaged in the application. A list tap followed by an edit tap needs a pause for the list transition.

The Android route uses `adb -s <serial> shell input tap <physical-x> <physical-y>`. For this viewport, `n i h a o` are `(504,1460) (540,1284) (432,1372) (72,1372) (612,1284)`; the first candidate is `(60,1175)`. iPod equivalents are `(224,410) (240,322) (192,366) (32,366) (272,322)` and `(30,270)`.

Additional checks passed: the 12-stage repository suite, TypeScript, all nine Clear gesture simulation tests, shared POSIX authentication/queue/generation tests, and the native Rime acceptance script. BlackBerry's existing profile/unit contracts passed, but its API-18 SDK and pinned NDK were absent from this Mac, so this change has no new BlackBerry APK or device receipt. The shared Android extraction retains its command entry point and package activity wrapper.
