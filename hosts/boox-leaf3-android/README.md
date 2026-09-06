# BOOX Leaf3 Android host

This host packages a PocketJS guest as a fullscreen Android APK for the ONYX
BOOX Leaf3.

## Contract

- **The target is Android 11 on a 1264×1680 BOOX Leaf3 display.**
- **PocketJS renders a 320×480 logical viewport through GLES2.** Android
  stretches that viewport across the panel.
- **The package contains the Rust UI core, QuickJS, the guest JavaScript, and
  its baked asset pack.** It does not load code from the network.
- **Touch events enter through `input.touch`.** The host maps panel coordinates
  into the logical viewport before each guest tick.
- **The current host tracks one touch contact.** Clear's tap, drag, swipe, and
  long-press interactions work; its two-contact pinch gesture needs a
  multi-contact host path.

`apps/boox-todo` mounts the shared Clear implementation with
`CLEAR_EINK_PALETTE`. **Every palette channel has equal red, green, and blue
components.** Pending rows use separated gray ramps, completed rows use a
light surface with dark text, and the software keyboard uses neutral gray key
states.

## Build and install

```sh
bun boox-android setup
bun boox-android build
adb install -r dist/boox-android/pocketjs-boox-todo.apk
adb shell pm enable dev.pocket_stack.boox_todo
adb shell am start -n \
  dev.pocket_stack.boox_todo/dev.pocketstack.boox.PocketActivity
```

BOOX firmware marks a new third-party package for background freeze after the
package-added event. **Run `pm enable` after that event or disable automatic
third-party app freezing in App Management.**

The build writes:

```text
dist/boox-android/pocketjs-boox-todo.apk
dist/boox-android/pocketjs-boox-todo.receipt.json
```

## Device result

The APK has been installed on a physical BOOX Leaf3 running Android 11. The
device run covered launch, list navigation, swipe-to-complete, edit mode, and
the in-app keyboard. The process remained alive and `logcat` reported no
PocketJS runtime failure.
