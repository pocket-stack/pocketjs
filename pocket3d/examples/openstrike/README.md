# OpenStrike

OpenStrike is the first Pocket3D app. It validates the runtime with a narrow
single-player loop on a user-supplied GoldSrc BSP map.

The default command points at the local CS map bundle used during development:

```sh
cargo run -p openstrike -- \
  --map ~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp \
  --wad-dir ~/Downloads/cs-maps-20260705-1836/support
```

For repeatable validation:

```sh
cargo run -p openstrike -- \
  --headless \
  --ticks 600 \
  --map ~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp \
  --wad-dir ~/Downloads/cs-maps-20260705-1836/support
```

The headless path loads the same BSP/WAD data and gameplay code, places the bot
near the player, aims automatically, fires the rifle, and fails if the bot is
not killed within the requested tick budget.
