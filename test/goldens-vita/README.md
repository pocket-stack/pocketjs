# Vita golden overrides

`test/e2e-vita3k.ts` compares Vita captures against the shared WASM goldens by
default. A file appears here only when the ARM/Vita layout result has a stable,
visually reviewed pixel difference from that shared oracle.

The current two overrides are the same one-pixel horizontal rounding of the
first `library-main` tile at frames 2 and 150. All other 33 frames use the
shared golden byte-for-byte. The driver still requires a 960x544 capture and
checks every logical pixel expands to an exact 2x2 physical block before any
platform override is considered.

After inspecting `.actual.png` output, regenerate only deterministic Vita
differences with:

```sh
UPDATE_VITA=1 E2E_VITA3K_APP=library bun run e2e:vita
```
