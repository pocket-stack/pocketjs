# Authoring model

AOT source files are split into two zones. The static zone runs during the Bun
build and declares the cartridge. The residual zone is limited script code that
can be compiled into the runtime VM.

```tsx
import { cartridge, map, npc, script } from "@pocketjs/aot";

export default cartridge({
  title: "Demo Town",
  scenes: [
    map("town", {
      tileset: "town.png",
      layers: ["ground", "details"],
      actors: [
        npc("elder", { x: 6, y: 8, facing: "down" }, script(function* () {
          yield say("Welcome to the route.");
          yield choice("Go north?", ["Yes", "No"]);
        })),
      ],
    }),
  ],
});
```

## Static declarations

The compiler can freely evaluate cartridge declarations. This is where tilesets,
maps, layers, actors, hitboxes, warps, palettes, and asset references are
collected. The result is deterministic game data, not a runtime component tree.

## Residual scripts

Dialogue scripts preserve only the supported control flow and commands. The
compiler lowers `say`, `choice`, flag checks, and scene transitions into compact
bytecode. Unsupported JavaScript stays a compile-time error so the runtime does
not need to embed a dynamic interpreter.
