# Authoring model

AOT source files are split into two zones. The static zone runs during the Bun
build and declares the cartridge. The residual zone is limited script code that
can be compiled into the runtime VM.

The authoring shape is deliberately hybrid:

- tile layers stay on the typed builder path;
- scene entities are grouped with build-time JSX components;
- scripts are generator bodies that the compiler residualizes into bytecode.

```tsx
/** @jsxImportSource @pocketjs/aot */
import {
  ascii,
  defineMap,
  Npc,
  PlayerSpawn,
  script,
  say,
  tile,
} from "@pocketjs/aot";
import { hero, town } from "./assets";

const ElderTalk = script(function* () {
  yield say("Welcome to the route.");
});

function TownEntities() {
  return (
    <>
      <PlayerSpawn id="spawn" at={[6, 8]} facing="down" />
      <Npc id="elder" sprite={hero} at={[6, 6]} facing="down" onTalk={ElderTalk} />
    </>
  );
}

export const Town = defineMap("town")
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
```

## Static declarations

The compiler can freely evaluate cartridge declarations. This is where tilesets,
maps, layers, actors, hitboxes, warps, palettes, and asset references are
collected. JSX components are just build-time functions that return scene
nodes; they are expanded before the ROM is built.

## Typed tile layers

`defineTileset()` preserves literal tile names, and `.tileset(town).layer(...)`
uses that type to reject legends that reference missing tiles. JSX does not own
tile layers because parent-to-child type propagation is weaker there.

```tsx
defineMap("typed")
  .tileset(town)
  .layer(ascii`#.`.legend({
    "#": tile("wall"),
    ".": tile("grass"),
  }));
```

## Residual scripts

Dialogue scripts preserve only the supported control flow and commands. The
compiler lowers `say`, `choice`, flag checks, and scene transitions into compact
bytecode. Unsupported JavaScript stays a compile-time error so the runtime does
not need to embed a dynamic interpreter.
