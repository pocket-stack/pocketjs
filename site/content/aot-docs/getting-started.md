# Getting started

PocketJS AOT authoring has two build-time surfaces: a typed map builder for
tile layers, and JSX scene prefabs for entities. Keep tilemaps on the builder
path so TypeScript can compare layer tile names against the selected tileset.
Use JSX for NPCs, signs, warps, entrances, and reusable scene groups.

```tsx
/** @jsxImportSource @pocketjs/aot */
import {
  ascii,
  defineGame,
  defineMap,
  defineTileset,
  PlayerSpawn,
  Sign,
  tile,
} from "@pocketjs/aot";

const rows8 = (v: string) => Array.from({ length: 8 }, () => v);

const town = defineTileset("town", {
  palette: [[0, 0, 0]],
  tiles: {
    grass: { px: rows8("11111111") },
    wall: { solid: true, px: rows8("22222222") },
  },
});

function TownEntities() {
  return (
    <>
      <PlayerSpawn id="spawn" at={[1, 1]} facing="down" />
      <Sign text="POCKET TOWN" at={[1, 0]} />
    </>
  );
}

const Town = defineMap("town")
  .tileset(town)
  .layer(
    ascii`
      ####
      #..#
      ####
    `.legend({
      "#": tile("wall"),
      ".": tile("grass"),
    }),
  )
  .entities(<TownEntities />)
  .done();

export default defineGame({
  title: "POCKET TOWN",
  start: "town:spawn",
  maps: [Town],
});
```

## Why this shape

`defineMap(...).tileset(town).layer(...)` carries the concrete `town.tiles`
type into the layer check. If the legend references `tile("water")` and the
tileset has no `water`, `tsc` fails before the compiler builds a ROM.

JSX is intentionally used one layer later. Pure JSX components run during the
build, expand into static scene nodes, and never ship to the cartridge.

## Build

```bash
bun aot/compiler/cli.ts build aot/demo/game.tsx --out aot/dist/pocket-town.gba
```

The build evaluates static declarations, lowers supported `script(function* () {
... })` bodies into bytecode, packs PJGB data, and links the fixed GBA runtime.
