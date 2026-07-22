# Vita physical goldens

`tests/e2e/vita3k.ts` compares every Vita capture with an independent 960x544
golden in this directory. These are physical-density images, not 480x272 WASM
goldens enlarged after rendering.

The capture guest runs the normal Vita QuickJS/input/layout path, submits the
production vita2d/GXM frame, verifies all referenced GPU textures and font
atlases are resident, then executes the same DrawList in the deterministic CPU
rasterizer directly at physical resolution. The driver rejects a frame made
only from duplicated 2x2 logical pixels.

After inspecting `.actual.png` output, regenerate one app or the full set with:

```sh
UPDATE_VITA=1 E2E_VITA3K_APP=hero bun run e2e:vita
UPDATE_VITA=1 bun run e2e:vita
```
