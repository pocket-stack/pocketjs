# Web demo

The AOT web demo is a static browser preview of generated cartridge states. It
uses the screenshots emitted for the GBA DSL work and draws them into a 240x160
canvas with pixel scaling.

It deliberately does not use the PocketJS framework playground. The playground
loads a QuickJS-backed UI runtime and framework examples; the AOT demo presents
the cartridge product line as its own surface.

## Controls

- `A` or Enter advances through the captured states.
- `B` or Escape moves backward.
- Arrow left jumps to town; arrow right jumps to route.
- Arrow up and arrow down cycle through the scene list.

The demo is useful for documentation and product validation. The authoritative
runtime behavior remains the GBA runtime linked with the PJGB cartridge data.
