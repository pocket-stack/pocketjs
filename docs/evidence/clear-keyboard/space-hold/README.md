# Space press continuity

The Space cap used the character-key flash: its colors returned to rest after 180 ms, before the 360 ms hold threshold. **The cap now follows the active Space contact.** Its pressed colors persist through trackpad activation and dragging. Release, cancellation, leaving a pending hold or closing the keyboard clears the pressed state. A two-thumb chord retains it until the Space contact ends.

The trackpad indicator is an authored filled SVG with a shallow slot, a bevelled thumb grip and three inset ridges. A small highlight on the center ridge supplies character-step feedback. Native-density baking and linear sampling preserve coverage at its 96×24 logical display size.

| Phase | iPod touch 4 | Moto G Play |
| --- | --- | --- |
| Rest | [Rest](ipod-rest.png) | [Rest](moto-rest.png) |
| Finger down, before trackpad activation | Covered by the simulation pixel check | [Pressed](moto-pressed.png) |
| Trackpad active, contact held | [Trackpad](ipod-trackpad.png) | [Trackpad](moto-trackpad.png) |

[receipts.json](receipts.json) records installed identities, image hashes and cap pixel samples outside the icon. The Moto pressed and trackpad samples match; each differs from rest. The iPod trackpad sample differs from rest. **The frames use software-generated native touch events on both physical devices.** The iPod helper holds Space for ten seconds while the renderer capture runs; Moto captures immediately after DOWN and again after a 600 ms wait before UP. Both devices remain on the same editor text after the hold.

The app simulation probes the cap on touch-down, after 300 ms, after trackpad activation and after release. It asserts that no fade occurs while held and that the resting color returns after release. The controller test covers activation, dragging, rolling two-thumb input and cancellation. All 18 focused keyboard/Clear tests, the 12-stage repository suite and TypeScript passed.
