# Cartridge format

PJGB is the packed cartridge data model consumed by the GBA runtime. It is not a
general application bundle; it is a purpose-built layout for tile RPG scenes and
their scripts.

## Chunk families

| Chunk | Purpose |
| --- | --- |
| Header | Magic, version, offsets, and cartridge metadata. |
| Palettes | BGR555 background and sprite palette banks. |
| Tiles | 4bpp background tiles and sprite tiles. |
| Maps | Layer tile indices, collision, actors, and warp tables. |
| Scripts | VM bytecode, constants, labels, and string references. |
| Text | Dialogue glyph atlas, advances, and textbox strings. |
| Debug | Optional symbol names and source locations for development builds. |

The runtime reads offsets directly from the blob. Versioning belongs in the
header so compiler and runtime compatibility is easy to check at boot.
