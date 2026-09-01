# GXM shader provenance

These binaries are the `.data` payloads from xerpi/libvita2d commit
`a8f15ab09d5233f0a4e4ad0e8f6ade0da888cbed`:

```text
libvita2d/shader/compiled/color_v_gxp.o        -> color_v.gxp
libvita2d/shader/compiled/color_f_gxp.o        -> color_f.gxp
libvita2d/shader/compiled/texture_v_gxp.o      -> texture_v.gxp
libvita2d/shader/compiled/texture_f_gxp.o      -> texture_f.gxp
libvita2d/shader/compiled/texture_tint_f_gxp.o -> texture_tint_f.gxp
```

Extract each payload with VitaSDK's object-copy tool:

```sh
arm-vita-eabi-objcopy -O binary INPUT_gxp.o OUTPUT.gxp
```

The checked-in files were byte-compared with fresh extractions from that
commit. See `LICENSE.libvita2d` for the upstream MIT license.
