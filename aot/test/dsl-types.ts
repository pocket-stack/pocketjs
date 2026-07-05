import { ascii, defineMap, defineTileset, tile } from "../dsl/index.ts";

const rows8 = (v: string): string[] => Array.from({ length: 8 }, () => v);

const typedTown = defineTileset("typed-town", {
  palette: [[0, 0, 0]],
  tiles: {
    grass: { px: rows8("11111111") },
    wall: { solid: true, px: rows8("22222222") },
  },
});

defineMap("typed-ok")
  .tileset(typedTown)
  .layer(
    ascii`
      #.
    `.legend({
      "#": tile("wall"),
      ".": tile("grass"),
    }),
  );

defineMap("typed-bad")
  .tileset(typedTown)
  .layer(
    // @ts-expect-error "water" is not a tile in typedTown.
    ascii`
      ~
    `.legend({
      "~": tile("water"),
    }),
  );

const constTown = defineTileset("const-town", {
  palette: [[0, 0, 0]],
  tiles: {
    grass: {
      px: [
        "11111111",
        "11111111",
        "11111111",
        "11111111",
        "11111111",
        "11111111",
        "11111111",
        "11111111",
      ],
    },
  },
} as const);

defineMap("const-ok")
  .tileset(constTown)
  .layer(
    ascii`
      .
    `.legend({
      ".": tile("grass"),
    }),
  );
