// aot/demo/game.tsx — a Pokemon-like overworld vertical slice, authored in TSX.
// Compiled by @pocketjs/aot into a GBA-native ROM (no JS engine on the cart).
import {
  battle,
  choose,
  defineGame,
  defineMap,
  facePlayer,
  giveItem,
  hasFlag,
  lockPlayer,
  Layer,
  Map,
  Npc,
  PlayerSpawn,
  Entrance,
  releasePlayer,
  say,
  script,
  setFlag,
  Sign,
  Warp,
} from "@pocketjs/aot";
import "./assets.ts"; // registers the "town" tileset + "hero" sprite

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
const townRows = [
  "####################",
  "#....,.....,......##",
  "#.^^HH^^..,...####.#",
  "#.HHDHH.......#~~#.#",
  "#.....=......,#~~#.#",
  "#..*..=..,......,..#",
  "#.,...=....^^HH^^..#",
  "#.....=....HHDHH...#",
  "#..,..======......,#",
  "#........,..=....*.#",
  "#.,....*....=..,...#",
  "#....F.F.F..=......#",
  "#..,........=...,..#",
  "#......,....=......#",
  "#.*......,..=..*...#",
  "#..........=.......#",
  "#,........===......#",
  "#########==#########",
] as const;

export const Littleroot = defineMap("littleroot", { size: [20, 18], tileset: "town" }, () => (
  <Map>
    <Layer
      rows={townRows as unknown as string[]}
      legend={{
        ".": "grass",
        ",": "grass2",
        "*": "flower",
        "#": "tree",
        "~": "water",
        "=": "path",
        H: "wall",
        "^": "roof",
        D: "door",
        F: "fence",
      }}
    />
    <PlayerSpawn id="spawn" at={[9, 14]} facing="up" />
    <Entrance id="south" at={[9, 15]} facing="up" />
    <Npc id="rival" sprite="hero" at={[12, 9]} facing="down" onTalk={RivalTalk} />
    <Npc id="mom" sprite="hero" at={[5, 8]} facing="right" movement="static" onTalk={MomTalk} />
    <Sign at={[8, 4]} text="LITTLEROOT TOWN. Home of new trainers." />
    <Warp at={[9, 17]} to="route101:north" />
  </Map>
));

// --- route map --------------------------------------------------------------
const routeRows = [
  "#########==#########",
  "#........==.......,#",
  "#..###...==...###..#",
  "#..###...==...###..#",
  "#.,......==........#",
  "#....*...==...*....#",
  "#........==........#",
  "#..~~~...==...,....#",
  "#..~~~...==.......,#",
  "#..~~~...=====....##",
  "#...,........==....#",
  "#.......,.....==*..#",
  "#..*.........,==...#",
  "#,..............==,#",
  "#..###...,....###..#",
  "####################",
] as const;

export const Route101 = defineMap("route101", { size: [20, 16], tileset: "town" }, () => (
  <Map>
    <Layer
      rows={routeRows as unknown as string[]}
      legend={{
        ".": "grass",
        ",": "grass2",
        "*": "flower",
        "#": "tree",
        "~": "water",
        "=": "path",
      }}
    />
    <Entrance id="north" at={[9, 1]} facing="down" />
    <PlayerSpawn id="spawn" at={[9, 1]} facing="down" />
    <Npc id="hiker" sprite="hero" at={[6, 7]} facing="down" onTalk={RouteNpcTalk} />
    <Warp at={[9, 0]} to="littleroot:south" />
  </Map>
));

export default defineGame({
  title: "POCKET TOWN",
  start: "littleroot:spawn",
  maps: [Littleroot, Route101],
  sprites: ["hero"],
  items: ["potion"],
  battles: ["rival_1"],
  flags: ["beat_rival_1", "intro_done"],
});
