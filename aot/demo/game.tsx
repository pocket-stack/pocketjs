// aot/demo/game.tsx — a Pokemon-like overworld vertical slice, authored in TSX.
// Compiled by @pocketjs/aot into a GBA-native ROM (no JS engine on the cart).
import {
  ascii,
  battle,
  choose,
  defineGame,
  defineMap,
  facePlayer,
  giveItem,
  hasFlag,
  lockPlayer,
  releasePlayer,
  say,
  script,
  setFlag,
  tile,
} from "@pocketjs/aot";
import { hero, town } from "./assets.ts";

// --- scripts (residual zone: compiled from AST to bytecode) -----------------
const RivalTalk = script(function* () {
  yield lockPlayer();
  yield facePlayer("rival");
  if (yield hasFlag("beat_rival_1")) {
    yield say("The road ahead is tougher than it looks.");
  } else {
    yield say("You made it! Want to test your first build?");
    const answer = yield choose(["Battle", "Maybe later"] as const);
    switch (answer) {
      case "Battle":
        yield battle("rival_1");
        yield setFlag("beat_rival_1");
        yield giveItem("potion", 1);
        yield say("Take this Potion. You will need it.");
        break;
      case "Maybe later":
        yield say("No problem. I will be right here.");
        break;
    }
  }
  yield releasePlayer();
});

const MomTalk = script(function* () {
  yield lockPlayer();
  yield facePlayer("mom");
  yield say("Be careful out there on Route 101!");
  yield releasePlayer();
});

const RouteNpcTalk = script(function* () {
  yield say("Wild grass rustles to the north.");
});

// --- town map ---------------------------------------------------------------
// legend: . grass  , grass2  * flower  # tree  ~ water  = path
//         H wall    ^ roof   D door    F fence
export const Littleroot = defineMap("littleroot")
  .tileset(town)
  .layer(
    ascii`
      ####################
      #....,.....,......##
      #.^^HH^^..,...####.#
      #.HHDHH.......#~~#.#
      #.....=......,#~~#.#
      #..*..=..,......,..#
      #.,...=....^^HH^^..#
      #.....=....HHDHH...#
      #..,..======......,#
      #........,..=....*.#
      #.,....*....=..,...#
      #....F.F.F..=......#
      #..,........=...,..#
      #......,....=......#
      #.*......,..=..*...#
      #..........=.......#
      #,........===......#
      #########==#########
    `.legend({
      ".": tile("grass"),
      ",": tile("grass2"),
      "*": tile("flower"),
      "#": tile("tree"),
      "~": tile("water"),
      "=": tile("path"),
      H: tile("wall"),
      "^": tile("roof"),
      D: tile("door"),
      F: tile("fence"),
    }),
  )
  .spawn("spawn").at(9, 14).facing("up")
  .entrance("south").at(9, 15).facing("up")
  .npc("rival").sprite(hero).at(12, 9).facing("down").talk(RivalTalk)
  .npc("mom").sprite(hero).at(5, 8).facing("right").movement("static").talk(MomTalk)
  .sign("LITTLEROOT TOWN. Home of new trainers.").at(8, 4)
  .warp("route101:north").at(9, 17)
  .done();

// --- route map --------------------------------------------------------------
export const Route101 = defineMap("route101")
  .tileset(town)
  .layer(
    ascii`
      #########==#########
      #........==.......,#
      #..###...==...###..#
      #..###...==...###..#
      #.,......==........#
      #....*...==...*....#
      #........==........#
      #..~~~...==...,....#
      #..~~~...==.......,#
      #..~~~...=====....##
      #...,........==....#
      #.......,.....==*..#
      #..*.........,==...#
      #,..............==,#
      #..###...,....###..#
      ####################
    `.legend({
      ".": tile("grass"),
      ",": tile("grass2"),
      "*": tile("flower"),
      "#": tile("tree"),
      "~": tile("water"),
      "=": tile("path"),
    }),
  )
  .entrance("north").at(9, 1).facing("down")
  .spawn("spawn").at(9, 1).facing("down")
  .npc("hiker").sprite(hero).at(6, 7).facing("down").talk(RouteNpcTalk)
  .warp("littleroot:south").at(9, 0)
  .done();

export default defineGame({
  title: "POCKET TOWN",
  start: "littleroot:spawn",
  maps: [Littleroot, Route101],
  sprites: ["hero"],
  items: ["potion"],
  battles: ["rival_1"],
  flags: ["beat_rival_1", "intro_done"],
});
