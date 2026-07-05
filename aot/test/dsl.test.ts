import { describe, expect, test } from "bun:test";
import {
  __resetRegistry,
  ascii,
  defineMap,
  defineSprite,
  defineTileset,
  script,
  tile,
} from "../dsl/index.ts";

const rows8 = (v: string): string[] => Array.from({ length: 8 }, () => v);
const rows16 = (v: string): string[] => Array.from({ length: 16 }, () => v);

describe("AOT map builder DSL", () => {
  test("ascii normalizes indentation and validates legend coverage", () => {
    const layer = ascii`
      ###
      #.#
      ###
    `.legend({
      "#": tile("wall"),
      ".": tile("grass"),
    });

    expect(layer.rows).toEqual(["###", "#.#", "###"]);
    expect(layer.legend).toEqual({ "#": "wall", ".": "grass" });

    expect(() =>
      ascii`
        ##
        #.
      `.legend({
        "#": tile("wall"),
      }),
    ).toThrow('ascii legend missing entry for "."');
  });

  test("defineMap builder emits the same host scene nodes the compiler walks", () => {
    __resetRegistry();

    const town = defineTileset("town", {
      palette: [[0, 0, 0]],
      tiles: {
        grass: { px: rows8("11111111") },
        wall: { solid: true, px: rows8("22222222") },
      },
    });
    const hero = defineSprite("hero", {
      size: [16, 16],
      palette: [[0, 0, 0]],
      facings: {
        down: [rows16("0000000000000000")],
        up: [rows16("0000000000000000")],
        left: [rows16("0000000000000000")],
        right: [rows16("0000000000000000")],
      },
    });
    const talk = script(0);

    const map = defineMap("littleroot")
      .tileset(town)
      .layer(
        ascii`
          ###
          #.#
          ###
        `.legend({
          "#": tile("wall"),
          ".": tile("grass"),
        }),
      )
      .spawn("spawn").at(1, 1).facing("down")
      .entrance("south").at(1, 2).facing("up")
      .npc("rival").sprite(hero).at(2, 1).facing("left").movement("static").talk(talk)
      .sign("HELLO").at(1, 0)
      .warp("route101:north").at(1, 2)
      .done();

    expect(map.name).toBe("littleroot");
    expect(map.tileset).toBe("town");
    expect(map.size).toEqual([3, 3]);
    expect(map.root.children.map((child) => child.host)).toEqual([
      "Layer",
      "PlayerSpawn",
      "Entrance",
      "Npc",
      "Sign",
      "Warp",
    ]);
    expect(map.root.children[3]!.props).toMatchObject({
      id: "rival",
      sprite: "hero",
      at: [2, 1],
      facing: "left",
      movement: "static",
      onTalk: talk,
    });
  });
});
