# PocketJS Brand Avatars

White-background 1024x1024 avatar exports for profile canvases that explicitly
require white. Arcade yellow has nowhere near enough contrast on white, so the
mark never sits bare on a light canvas: each export puts it in the `#171226`
capsule, which is the same lockup the app icons and the favicon use.

- `pocketjs-avatar-white-polished.png` is the default white-canvas export.
- `pocketjs-avatar-white-plate.png` keeps the capsule safe under circular crops.
- `pocketjs-avatar-white-minimal.png` has the strongest small-size contrast.

The matching `.svg` files are the editable sources for each PNG.

The mark itself lives in `site/assets/favicon.svg`; generated platform artwork
such as the Vita LiveArea and the original-iPhone icons derives from the same
geometry and the same two colours.
