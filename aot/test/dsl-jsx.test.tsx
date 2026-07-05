/** @jsxImportSource @pocketjs/aot */
import { describe, expect, test } from "bun:test";
import {
  __resetRegistry,
  ascii,
  defineMap,
  defineSprite,
  defineTileset,
  Entrance,
  Layer,
  Npc,
  PlayerSpawn,
  script,
  Sign,
  tile,
  Warp,
} from "../dsl/index.ts";

const rows8 = (v: string): string[] => Array.from({ length: 8 }, () => v);
const rows16 = (v: string): string[] => Array.from({ length: 16 }, () => v);

describe("AOT JSX entity composition", () => {
  test("MapBuilder.entities expands pure JSX prefabs into scene nodes", () => {
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

    function TownEntities() {
      return (
        <>
          <PlayerSpawn id="spawn" at={[1, 1]} facing="down" />
          <Entrance id="south" at={[1, 2]} facing="up" />
          <Npc id="rival" sprite={hero} at={[2, 1]} facing="left" movement="static" onTalk={talk} />
          <Sign text="HELLO" at={[1, 0]} />
          <Warp to="route101:north" at={[1, 2]} />
        </>
      );
    }

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
      .entities(<TownEntities />)
      .done();

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

  test("MapBuilder.entities keeps tile layers on the typed builder path", () => {
    const town = defineTileset("town-entities-reject-layer", {
      palette: [[0, 0, 0]],
      tiles: {
        grass: { px: rows8("11111111") },
      },
    });

    expect(() =>
      defineMap("bad-entities")
        .tileset(town)
        .entities(<Layer rows={["."]} legend={{ ".": "grass" }} />),
    ).toThrow('defineMap("bad-entities").entities(...) does not accept <Layer>');
  });
});
