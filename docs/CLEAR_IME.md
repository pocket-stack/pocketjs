# Clear IME and USB companions

Clear supports **application text composition** on the iPod touch 4 and Moto G Play 2024. This is a PocketJS editor API, not an iOS system keyboard extension or Android `InputMethodService`.

## Ownership

| Example | Device owns | Companion owns |
| --- | --- | --- |
| Pocket Doc | Page selection, scrolling, resource handles | Library files, document processing, text coverage |
| Pocket Map | Viewport, gestures, resource lifetime | Map requests, tile processing, resource responses |
| Pocket Term | Terminal view, input, bounded coverage uploads | A supervisor and authenticated daemon own PTYs; transport workers can reconnect |
| Clear IME | Keyboard, composition transcript, editor revision, committed text, textures | Rime process, dictionaries, conversion, CJK rasterization |

The inspected source revisions are [Pocket Doc `host/serve.ts`](https://github.com/pocket-stack/pocket-doc/blob/b3a0d72a377226ef01ed95c3162eb83c91024805/host/serve.ts), [Pocket Map `host/serve.ts`](https://github.com/pocket-stack/pocket-map/blob/457a33568a96bc44c24c4f7a7cc55cd2d2cba592/host/serve.ts), and [Pocket Term `host/serve.ts`](https://github.com/pocket-stack/pocket-term/blob/34f27c816ac1903ed3d53b08f8f81f5ec2ec43b4/host/serve.ts), alongside PocketJS `tools/companion-session.ts`, `tools/offload-provider.ts`, and `framework/src/offload.ts`.

**The render thread never opens the companion socket or reads a dictionary.** `hosts/shared/offload_posix.c` owns a pthread, loopback listener, key-file reads, socket authentication and transfers. The guest submits and drains fixed-capacity queues. Each record has a connection generation; a later connection cannot consume a previous connection's response. The 3DS and POSIX hosts share the queue and coverage decoder.

The v1 offload contract bounds records to **4,096 bytes**, pending requests to **8**, accepted submissions to **2 per frame**, deliveries to **1 per frame**, and coverage uploads to **1 per frame**. These are bounded handoffs; network or provider latency can delay candidates. No network latency guarantee follows from the frame budgets.

`tools/ime/serve.ts` owns one native Rime process and an authenticated loopback HTTP endpoint. A per-connection Worker exposes two allowlisted methods:

- `ime.compose`: evaluate a transcript of at most 128 key actions; return preedit, UTF-16 caret position, cumulative commit, page state and at most five candidates.
- `text.tile`: rasterize one bounded text slice into 2-bit coverage. Device labels use fixed tile grids at raster density 2; coverage data never exceeds one offload record.

**Rime evaluates each transcript in a fresh session with user learning disabled.** Replaying the same input therefore avoids repeated dictionary mutations. The guest fences replies by editor revision, retains its transcript during disconnection and applies the new suffix of the cumulative commit once. Closing or cancelling the editor rejects pending commits. This replay policy belongs to IME; it does not change the transport's no-replay policy for sent mutations such as terminal input.

The native API comes from [librime](https://github.com/rime/librime/blob/master/src/rime_api.h). `tools/ime/setup.ts` pins the Luna Pinyin, Prelude and Essay dictionary revisions. Schema compilation, dictionary storage, OpenCC and system CJK font access stay on the Mac. System fonts and dictionary artifacts are not packaged into the applications.

An editor creates one client and advances it from its frame callback. For a Solid application, API ownership is:

```ts
import { createIme, IME } from "@pocketjs/framework/ime";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { onCleanup } from "solid-js";

const ime = createIme({ changed: renderComposition, commit: insertAtCaret });
onFrame(() => ime.step());
onCleanup(() => ime.dispose());
// Keyboard handlers call ime.key(code), ime.key(IME.backspace),
// ime.select(pageRelativeIndex), or ime.reset().
```

`renderComposition` receives pending/connected/error state alongside the snapshot. `insertAtCaret` receives committed text. The application supplies both callbacks and owns its text model.

## Setup on this Mac

Install Bun, the repository dependencies, Homebrew `librime`, and the platform tools described below. Then run:

```sh
bun install --frozen-lockfile
brew install librime
bun ime:setup
bun tools/ime/verify.ts
```

`ime:setup` writes generated data to ignored `.pocket/ime/`. Apple Silicon Homebrew defaults to `/opt/homebrew`; `POCKETJS_RIME_PREFIX` selects another prefix. The companion uses `/System/Library/Fonts/STHeiti Medium.ttc`; direct `tools/ime/serve.ts --font=<path>` selects another installed CJK font.

## iPod touch 4

Follow [IPODTOUCH4.md](IPODTOUCH4.md) for the pinned iOS 6 toolchain, SSH and User-app installation prerequisites. This path requires the prepared device's existing jailbreak and AppSync. Select its exact USB identifier:

```sh
export POCKETJS_IPODTOUCH4_UDID=<idevice_id output>
bun ipodtouch4 doctor
bun ipodtouch4 deploy
bun ipodtouch4 launch
bun clear:companion ipodtouch4 --id="$POCKETJS_IPODTOUCH4_UDID"
```

The companion command verifies `iPod4,1`, opens USB forwards for SSH and port 8741, finds the installed Clear User-app container, provisions `Documents/offload.key`, verifies its readback and starts the provider. It uses the SSH host identity established by the iPod preparation workflow. Clear retains its native **320×480 logical / 640×960 physical** viewport.

In a second terminal:

```sh
bun ipodtouch4 status
bun ipodtouch4 capture
```

## Moto G Play 2024

The tested device is `fogona`, Android 14, with a **720×1600 physical** display. The host uses arm64, GLES2, QuickJS-C, the shared Rust renderer, native multi-touch and a **360×800 logical** viewport. Clear's keyboard follows the viewport width; gestures continue through the shared input contracts.

Install Android command-line tools, Java 17 and Rust. Enable USB debugging and authorize this Mac on the device. The default SDK is `/opt/homebrew/share/android-commandlinetools`; `POCKETJS_ANDROID_SDK_ROOT` selects another location. `JAVA_HOME` selects Java 17. The setup command installs platform 34, build tools 35.0.0, NDK 27.1.12297006, the pinned QuickJS revision and the Rust target. Install the pinned Rust toolchain before setup:

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal
adb devices -l
bun moto-g-play setup
bun moto-g-play doctor
bun moto-g-play build
bun moto-g-play deploy --id=<adb serial>
bun moto-g-play launch --id=<adb serial>
bun clear:companion moto-g-play --id=<adb serial>
```

The device commands reject a different model. Deployment installs `dev.pocket_stack.clear` and verifies the installed APK SHA-256 against the local build. The development APK permits `run-as`, which writes the key to the app's private files directory. This package targets Android 14 and keeps the signing key in the local toolchain cache for replacement installs.

```sh
bun moto-g-play status --id=<adb serial>
bun moto-g-play capture --id=<adb serial>
```

The two companions can run at the same time: Mac ports 18741 and 28741 forward to each device's loopback port 8741. Each device has its own 256-bit key in a mode-0600 ignored file. Pairing receipts contain a fingerprint, never the key. Stopping a companion leaves local scrolling and editing available. Restoring it resumes the current composition; offline conversion requires the Mac to return.

## Editing

Tap a list, then a row. In PY mode, type pinyin and tap a candidate. Space or Return selects the first candidate; Return after composition closes the editor. `<` and `>` change candidate pages. Tap the left or right half of the preedit to move its caret. `x` cancels the composition. The globe changes between PY and EN; numbers, symbols, shift and committed-text deletion remain available.

Pending candidates cannot be selected against newer input. `Offline (queued)` means the device retains the current transcript. A composition is bounded to 128 actions; `x` clears it if the limit is reached. Clear retains its existing 40-code-point title limit and in-memory demo list model. It does not add list persistence or dictionary learning.

## Validation

`bun run test` includes shared queue/authentication/generation tests, IME revision/reconnect tests and the Moto viewport plan test. `bun tools/ime/verify.ts` requires the built native Rime data and checks Chinese phrases, candidate selection, deterministic replay, paging, backspace, caret movement, raw commit and space selection.

Device screenshots and build/install/runtime receipts are separate evidence. See [the device acceptance record](evidence/clear-ime/README.md). iPod capture reads the app's rendered frame; Android capture reads the device display. Automated UIKit events and ADB touch events prove the native input routes, not a physical finger test.
