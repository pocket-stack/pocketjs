# Explorer character asset

`explorer.glb` is the runtime character for `playable-world`. It contains one
skinned `ExplorerMesh`, a 19-bone rig, and the `Idle`, `Walk`, and `Chop`
animation clips. The axe is rigidly weighted to `axe.R`, which is parented to
`hand.R`. The rest-pose foot soles sit at Y=0 after glTF export, and the
character faces -Z.

## Regenerate

Blender 5.1 or later is required. The checked-in receipt and byte-identical
runtime digest were produced with Blender 5.1.2. From this directory, run:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python generate_character.py
```

To write into a separate directory or omit the studio renders:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python generate_character.py -- \
  --output-dir /tmp/pocket3d-explorer --skip-previews
```

The generator validates the triangle budget, bone and clip names, rigid skin
weights, planted-foot error, opposing front/back arm travel during `Walk`, the
axe blade's outward clearance and forward travel during `Chop`, embedded GLB
buffers, and a fresh Blender import. It exits nonzero when a contract fails and
writes the measured values plus the GLB SHA-256 digest to `receipt.json`.

The committed studio renders show the exact generated `Idle`, `Walk`, and
`Chop` poses. `walk-rear.png` and `walk-side.png` verify the walk swing from
orthogonal directions. `explorer.blend` remains editable;
`generate_character.py` is the source of truth for reproducible changes.
