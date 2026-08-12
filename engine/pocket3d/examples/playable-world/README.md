# Playable World

This example is an original Pocket3D proof of concept for a small systemic
world. A deterministic simulation owns bodies, attachments, structural damage,
heat, moisture, fuel, and combustion. The Pocket3D adapter maps simulation
state to procedural low-poly geometry, particles, lighting, a third-person
camera, and a debug HUD.

The implementation does not include or derive game assets, source code,
configuration data, shaders, or numeric tuning from *The Legend of Zelda:
Breath of the Wild*. Public reverse-engineering research was used only to
identify general relationships worth testing: physical contacts become ordered
events; physical and reactive materials are separate; attachments can become
independent bodies; and structural or thermal changes produce deferred state
transitions.

## Run

From the repository root:

```sh
cargo run --locked --manifest-path engine/Cargo.toml -p playable-world
```

Controls:

- `WASD` moves the explorer.
- Mouse movement or arrow keys orbit the camera.
- `Space` swings the axe at the nearest tree or log.
- `F` casts an ember at the aimed reactive object.
- `Q` pours water on the nearest burning object.
- `E` picks up or drops the nearest apple.
- `R` resets the world to the initial seed.
- `Escape` releases or captures the mouse; close the window to quit.

## Deterministic acceptance

The headless path drives the same fixed-step simulation and Pocket3D renderer:

```sh
cargo run --locked --manifest-path engine/Cargo.toml -p playable-world -- \
  --headless --scenario orchard-fire --ticks 720 --seed 7 \
  --receipt /tmp/playable-world.json \
  --screenshot /tmp/playable-world.png
```

`--scenario orchard-fire` walks to the tree, chops it, lets attached apples
become rigid bodies, ignites the fallen wood, and records ordered world events.
The receipt proves simulation state; the PNG proves the rendered result.
