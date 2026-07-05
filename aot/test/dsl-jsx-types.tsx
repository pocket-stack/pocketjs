/** @jsxImportSource @pocketjs/aot */
import {
  ascii,
  defineMap,
  defineTileset,
  Npc,
  PlayerSpawn,
  script,
  tile,
} from "../dsl/index.ts";

const rows8 = (v: string): string[] => Array.from({ length: 8 }, () => v);

const typedTown = defineTileset("typed-jsx-town", {
  palette: [[0, 0, 0]],
  tiles: {
    grass: { px: rows8("11111111") },
    wall: { solid: true, px: rows8("22222222") },
  },
});

const talk = script(0);

defineMap("typed-jsx-ok")
  .tileset(typedTown)
  .layer(
    ascii`
      #.
    `.legend({
      "#": tile("wall"),
      ".": tile("grass"),
    }),
  )
  .entities(
    <PlayerSpawn id="spawn" at={[1, 1]} facing="down" />,
    <Npc id="rival" sprite="hero" at={[2, 1]} facing="left" onTalk={talk} />,
  );

defineMap("typed-jsx-bad-facing")
  .tileset(typedTown)
  .layer(
    ascii`
      .
    `.legend({
      ".": tile("grass"),
    }),
  )
  .entities(
    // @ts-expect-error "north" is not a GBA direction.
    <PlayerSpawn id="spawn" at={[0, 0]} facing="north" />,
  );

defineMap("typed-jsx-bad-script")
  .tileset(typedTown)
  .layer(
    ascii`
      .
    `.legend({
      ".": tile("grass"),
    }),
  )
  .entities(
    // @ts-expect-error onTalk must be a compiled ScriptRef.
    <Npc id="rival" sprite="hero" at={[0, 0]} facing="down" onTalk={1} />,
  );
