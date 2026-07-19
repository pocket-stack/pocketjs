// static/test/smoke/game.ts — the cross-target contract game.
//
// Small on purpose, but it exercises every RPG mechanism the runtimes must
// agree on: spawn, walking, collision (tiles + solid actor), talk scripts,
// choices, flags, vars, a battle-style while loop over RNG, template FMT
// text, warps (walk-on + scripted), triggers (incl. once), actor show/hide,
// subroutine calls, wander movement, lock/release and SFX. The three console
// E2E suites and the reference-VM story test all drive THIS module.
//
// Art is deliberately procedural (declaration zone = plain TypeScript).

import {
  defineGame,
  defineMap,
  defineSprite,
  defineTileset,
  npc,
  script,
  trigger,
  warp,
  type Ops,
  type Vars,
} from "@pocketjs/static/rpg";

// --- procedural art ---------------------------------------------------------
const row = (c: string) => c.repeat(8);
const rows8 = (c: string) => Array.from({ length: 8 }, () => row(c));
const framed = (edge: string, fill: string) => [
  row(edge),
  ...Array.from({ length: 6 }, () => edge + fill.repeat(6) + edge),
  row(edge),
];

const office = defineTileset("office", {
  palette: [
    [24, 26, 30], // 0 backdrop
    [92, 148, 252], // 1 floor blue
    [56, 56, 72], // 2 wall dark
    [200, 76, 12], // 3 desk orange
    [252, 224, 168], // 4 door light
    [0, 168, 68], // 5 plant green
  ],
  tiles: {
    floor: { px: rows8("1") },
    wall: { px: framed("2", "2"), solid: true },
    desk: { px: framed("2", "3"), solid: true },
    door: { px: rows8("4") },
    plant: { px: framed("5", "1"), solid: true },
  },
});

const frame16 = (c: string) => Array.from({ length: 16 }, () => c.repeat(16));
const twoTone = (top: string, bottom: string) => [
  ...Array.from({ length: 8 }, () => top.repeat(16)),
  ...Array.from({ length: 8 }, () => bottom.repeat(16)),
];

const hero = defineSprite("hero", {
  palette: [
    [0, 0, 0], // 0 transparent
    [248, 248, 248], // 1 white
    [216, 40, 40], // 2 red
    [40, 40, 216], // 3 blue
  ],
  facings: {
    down: [twoTone("2", "1"), twoTone("1", "2")],
    up: [twoTone("3", "1"), twoTone("1", "3")],
    right: [twoTone("2", "3"), twoTone("3", "2")],
  },
});

const guide = defineSprite("guide", {
  palette: [
    [0, 0, 0],
    [252, 216, 96], // yellow
    [96, 96, 96],
  ],
  facings: {
    down: [frame16("1")],
    up: [frame16("2")],
    right: [twoTone("1", "2")],
  },
});

// --- scripts -----------------------------------------------------------------
function* cheer(s: Ops, v: Vars, effects: readonly ("confirm" | "fanfare")[]) {
  for (const fx of effects) {
    yield* s.sfx(fx);
    v.cheers += 1;
  }
}

const Fanfare = script(function* (s, v, f) {
  v.sub_calls += 1;
});

const GuideTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.beat_guide) {
    yield* s.say("GUIDE: You already won. Take the door north.");
    yield* s.release();
    return;
  }
  yield* s.say("GUIDE: New build! Want to spar?");
  const pick = yield* s.choose(["Spar", "Later"]);
  if (pick === "Spar") {
    v.hp = 8;
    v.foe = 6;
    while (v.foe > 0 && v.hp > 0) {
      const move = yield* s.choose(["Strike", "Guard"]);
      if (move === "Strike") {
        v.foe -= 2 + (yield* s.rnd(2));
      } else {
        v.hp += 1;
      }
      if (v.foe > 0) {
        v.hp -= 1;
      }
    }
    if (v.hp > 0) {
      f.beat_guide = true;
      yield* s.call(Fanfare);
      yield* cheer(s, v, ["confirm", "fanfare", "fanfare"]);
      yield* s.say(`GUIDE: You win with ${v.hp} HP left.`);
    } else {
      yield* s.say("GUIDE: Rest and try again.");
    }
  } else {
    yield* s.say("GUIDE: The road is tougher than it looks.");
  }
  yield* s.release();
});

const RevealSign = script(function* (s, v, f) {
  f.trigger_hit = true;
  yield* s.show("intern");
  yield* s.sfx("confirm");
});

const OfficeEnter = script(function* (s, v, f) {
  v.office_enters += 1;
  if (f.beat_guide) {
    yield* s.hide("guide");
  }
});

const InternTalk = script(function* (s, v, f) {
  yield* s.say("INTERN: I was hiding here all along.");
  yield* s.warp("street:door");
});

// --- maps ----------------------------------------------------------------------
const officeMap = defineMap("office", {
  tileset: office,
  layout: `
    ##########
    #....d...#
    #..~..p..#
    #........#
    #...T....#
    ####.#####
  `,
  legend: { "#": "wall", ".": "floor", d: "door", "~": "desk", p: "plant", T: "floor" },
  entrances: {
    door: { at: [5, 1], dir: "down" },
    south: { at: [4, 4], dir: "up" },
  },
  actors: [
    npc("guide", { sprite: guide, at: [3, 1], facing: "down", talk: GuideTalk }),
    npc("intern", { sprite: guide, at: [8, 3], facing: "down", hidden: true, talk: InternTalk }),
  ],
  warps: [warp({ at: [4, 5], to: "street:door" })],
  triggers: [trigger({ at: [4, 4], run: RevealSign, once: true })],
  onEnter: OfficeEnter,
});

const streetMap = defineMap("street", {
  tileset: office,
  layout: `
    p........p
    ..........
    .....d....
    ..........
    p........p
  `,
  legend: { p: "plant", ".": "floor", d: "door" },
  entrances: {
    door: { at: [5, 2], dir: "down" },
  },
  actors: [npc("walker", { sprite: guide, at: [1, 1], move: "wander", solid: false })],
  warps: [warp({ at: [5, 3], to: "office:south" })],
});

defineGame({
  title: "POCKET SMOKE",
  start: "office:door",
  player: hero,
  maps: [officeMap, streetMap],
});
