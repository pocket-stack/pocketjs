# PlayStation Portable (PSP) - EG02

- Author: **Dibad**
- Original source: <https://sketchfab.com/3d-models/playstation-portable-psp-eg02-b76c7f9158204a39929a9c97d0b813d0>
- Sketchfab UID: `b76c7f9158204a39929a9c97d0b813d0`
- License: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)

## Local files

The bundled files are optimization derivatives of the author's community GLB.
The meshes, materials, decals, L/R shoulder groups, and textures are retained,
apart from four tiny overlapping `Metal_Blanco` face islands that incorrectly
sealed the authored lanyard opening. Decal materials carry a non-destructive
`monochrome` display semantic so the runtime renders the hardware markings in
white/gray while retaining their source textures and alpha. The screen surface
additionally carries the `dynamic_screen` semantic and a normalized UV set so
a host can bind a live framebuffer without editing the mesh at runtime.

- `psp_lod2_interactive.glb`: 131,680 triangles, SHA-256
  `44043163d9c286b4513ba9aa9cb4ffb5f5cf228534ab6a33307fa123cae47048`.
- `psp_lod3_eco.glb`: 80,879 triangles, SHA-256
  `9d85b2eb146dcfc338e0505fb5fe51292507feba5c55a4510082621aa8f3c46d`.

The original downloaded GLB had SHA-256
`c781c75d410ec083b75412db212493ee48913143d94aacd46c723b09ff4ebef6`.

Sony, PlayStation, and PSP names and marks belong to their respective owners.
The Creative Commons license covers the model author's contribution and does not
itself grant trademark rights.
