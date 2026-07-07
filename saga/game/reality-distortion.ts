// saga/game/reality-distortion.ts — REALITY DISTORTION, Part One (1955-1984).
//
// An interactive fan tribute to Steve Jobs, from Paul Jobs' workbench to the
// Macintosh launch at the Flint Center. English-language, GBA-only.
//
// Factual discipline: every dated event follows game/dossier.md (source-cited;
// disputed items are avoided or framed). Two kinds of lines appear in the
// game: ORIGINAL fan writing (most dialogue), and DOCUMENTED lines used
// verbatim where the dossier verifies wording (the Hewlett call pitch, the
// PARC "gold mine" shout, the Carmel retreat sayings, the sugared-water
// question per Sculley's memoir, and the Macintosh's own 1984 speech).
// The credits say exactly that.

import {
  defineFilm, defineScene, cue, image, gradient, sprite,
  fadeIn, fadeOut, wait, waitA, waitTweens, caption, captionClear, dialog, choice,
  pan, panY, letterbox, mosaicTo, shake, alpha, zoom, spinTo, show, hide, animate,
  moveTo, walkTo, control, mash, counter, counterHide, affineOn, affineOff, sfx, gotoScene,
  setFlag, clrFlag, hasFlag, setVar, addVar, varEq, varNe, varLt, varGt, varLe, varGe,
  world, breakout, meterShow, meterHide, warp, face, walk,
} from "@pocketjs/saga";

// ---------------------------------------------------------------------------
// 0 · TITLE
// ---------------------------------------------------------------------------
const title = defineScene({
  id: "title",
  main: image("art/bg_title.png"),
  backdrop: "#0a0a14",
  play: cue(function* () {
    yield setVar("nav", 0);
    yield fadeIn(45);
    // the persistent title lives in the chip style: chips own a private
    // glyph-slot range, so the menu text below can never corrupt it
    yield caption("chip", "REALITY DISTORTION");
    yield caption("card", "PART ONE\n1955 - 1984");
    yield wait(40);
    yield caption("sub", "A fan tribute. Original\nwriting; not affiliated.");
    yield wait(40);
    yield captionClear("card");
    yield captionClear("sub");
    while (yield varEq("nav", 0)) {
      const c = yield choice(["Play", "Chapters"]);
      if (c === 0) {
        yield setVar("nav", 1);
        yield captionClear("all");
        yield fadeOut(30);
        yield gotoScene("garage62");
      }
      if (c === 1) {
        const p = yield choice(["The Workbench", "The Blue Box", "The Letterform", "Breakout", "More..."]);
        if (p === 0) {
          yield setVar("nav", 1);
          yield captionClear("all");
          yield fadeOut(20);
          yield gotoScene("garage62");
        }
        if (p === 1) {
          yield setVar("nav", 1);
          yield captionClear("all");
          yield fadeOut(20);
          yield gotoScene("bluebox");
        }
        if (p === 2) {
          yield setVar("nav", 1);
          yield captionClear("all");
          yield fadeOut(20);
          yield gotoScene("reed");
        }
        if (p === 3) {
          yield setVar("nav", 1);
          yield captionClear("all");
          yield fadeOut(20);
          yield gotoScene("atari");
        }
        if (p === 4) {
          const q = yield choice(["Fifty Boards", "The Goldmine", "Sugared Water", "Hello", "Back"]);
          if (q === 0) {
            yield setVar("nav", 1);
            yield captionClear("all");
            yield fadeOut(20);
            yield gotoScene("garage76");
          }
          if (q === 1) {
            yield setVar("nav", 1);
            yield captionClear("all");
            yield fadeOut(20);
            yield gotoScene("parc");
          }
          if (q === 2) {
            yield setVar("nav", 1);
            yield captionClear("all");
            yield fadeOut(20);
            yield gotoScene("sculley");
          }
          if (q === 3) {
            yield setVar("nav", 1);
            yield captionClear("all");
            yield fadeOut(20);
            yield gotoScene("bandley");
          }
        }
      }
    }
  }),
});

// ---------------------------------------------------------------------------
// 1 · THE WORKBENCH — Mountain View garage, early 1960s (world)
// ---------------------------------------------------------------------------
const garage62 = defineScene({
  id: "garage62",
  main: image("art/map_garage68.png"),
  backdrop: "#141018",
  actors: {
    kid: sprite("art/spr_kid.png", { w: 32, h: 32, frames: 3, walkFpd: 1 }),
    dad: sprite("art/spr_dad.png", { w: 32, h: 32, frames: 3, walkFpd: 1 }),
  },
  world: {
    grid: [
      "####################",
      "####################",
      "####################",
      "####################",
      "########.###...#####",
      "########.###...#####",
      "########.###...#####",
      "######.........#####",
      "...w...........#####",
      "..........p....#####",
      "....................",
      "....................",
      "..............######",
      "..............######",
      "dddd..........######",
    ],
    player: { actor: "kid", at: "p", dir: "up" },
    npcs: {
      dad: {
        actor: "dad",
        at: "w",
        dir: "right",
        talk: cue(function* () {
          if (yield hasFlag("bench")) {
            yield dialog("DAD", "Done means the hidden\nparts are done too.");
          } else {
            yield dialog("DAD", "See this end of the\nbench? It's yours now.");
            yield dialog("DAD", "Take things apart.\nLearn why they work.");
          }
        }),
      },
    },
    spots: {
      bench: {
        at: [0, 4, 8, 4],
        run: cue(function* () {
          yield caption("sub", "His side is spotless.\nYours can be anything.");
          yield waitA();
          yield captionClear("all");
          yield dialog("DAD", "Make the back of the\nfence as good as the");
          yield dialog("DAD", "front. Nobody sees it.\nYou will know.");
          yield setFlag("bench");
          yield sfx("confirm");
        }),
      },
      car: {
        at: [15, 2, 5, 8],
        run: cue(function* () {
          yield caption("sub", "Dad rebuilds cars to\nresell. Every weekend.");
          yield waitA();
          yield captionClear("all");
        }),
      },
    },
    exits: { door: { at: "d", value: 1 } },
  },
  play: cue(function* () {
    yield clrFlag("bench");
    yield letterbox(12, 1);
    yield fadeIn(40);
    yield caption("chip", "MOUNTAIN VIEW, EARLY 60s");
    yield letterbox(0, 30);
    while (!(yield hasFlag("bench"))) {
      yield world();
      if (!(yield hasFlag("bench"))) {
        yield dialog("DAD", "Not yet. Come look at\nthe bench first.");
        yield warp(2, 13, "up");
      }
    }
    yield captionClear("all");
    yield fadeOut(35);
  }),
});

// ---------------------------------------------------------------------------
// 2 · THE CALL — Los Altos, 1968 (cine bridge)
// ---------------------------------------------------------------------------
const hewlett = defineScene({
  id: "hewlett",
  main: image("art/bg_title.png"),
  backdrop: "#0a0a14",
  actors: {
    phone: sprite("art/spr_phone.png", { w: 32, h: 32, at: [104, 96], screen: true }),
  },
  play: cue(function* () {
    yield letterbox(14, 1);
    yield fadeIn(40);
    yield caption("chip", "LOS ALTOS, 1968");
    yield wait(30);
    yield caption("sub", "A frequency counter\nneeds parts. You are 12.");
    yield waitA();
    yield captionClear("sub");
    yield show("phone");
    yield caption("sub", "The Palo Alto phone book\nlists Bill Hewlett.");
    yield waitA();
    yield captionClear("all");
    const c = yield choice(["Dial it", "Put the book down"]);
    if (c === 1) {
      yield caption("sub", "You dial anyway.");
      yield wait(40);
      yield captionClear("all");
    }
    yield sfx("blip");
    yield dialog("STEVE", "Hi. My name's Steve\nJobs. You don't know me,");
    yield dialog("STEVE", "but I'm 12 years old,\nand I'm building a");
    yield dialog("STEVE", "frequency counter, and\nI'd like some spare parts.");
    yield wait(20);
    yield caption("sub", "He laughs. You get\nthe parts.");
    yield waitA();
    yield captionClear("all");
    yield caption("sub", "And a summer job at HP,\nbuilding counters.");
    yield waitA();
    yield captionClear("all");
    yield hide("phone");
    yield caption("card", "ASK. THE WORST THEY\nCAN SAY IS NO.");
    yield wait(90);
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 3 · THE BLUE BOX — Berkeley, fall 1971 (cine)
// ---------------------------------------------------------------------------
const bluebox = defineScene({
  id: "bluebox",
  main: image("art/bg_dorm.png"),
  backdrop: "#0c0c16",
  actors: {
    hero: sprite("art/spr_hero.png", { w: 32, h: 32, frames: 12, walkFpd: 4, at: [58, 108] }),
    woz: sprite("art/spr_woz.png", { w: 32, h: 32, frames: 3, walkFpd: 1, at: [160, 108] }),
    box: sprite("art/spr_bluebox.png", { w: 32, h: 32, at: [110, 60], screen: true }),
  },
  play: cue(function* () {
    yield letterbox(14, 1);
    yield fadeIn(40);
    yield caption("chip", "BERKELEY, FALL 1971");
    yield letterbox(0, 25);
    yield show("hero");
    yield show("woz", 150, 96, { flip: true });
    yield wait(20);
    yield dialog("WOZ", "Esquire says the phone\nnetwork obeys whistles.");
    yield dialog("WOZ", "We checked a book at\nSLAC. The tones are real.");
    yield show("box");
    yield sfx("blip");
    yield wait(12);
    yield sfx("blip");
    yield wait(12);
    yield sfx("star");
    yield caption("sub", "Woz built it. All\ndigital. No adjustments.");
    yield waitA();
    yield captionClear("all");
    yield dialog("WOZ", "I called the Vatican.\nSaid I was Kissinger.");
    const c = yield choice(["Sell them", "Too risky"]);
    if (c === 0) {
      yield caption("sub", "Door to door in the\ndorms. $150 a box.");
    } else {
      yield caption("sub", "You sold them anyway.\n$150 a box.");
    }
    yield waitA();
    yield captionClear("all");
    yield shake(2, 30);
    yield caption("sub", "One sale ended at\ngunpoint. You kept going.");
    yield waitA();
    yield captionClear("all");
    yield caption("card", "NO BLUE BOXES,\nNO APPLE.");
    yield caption("chip", "- HIM, LOOKING BACK");
    yield wait(110);
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 4 · THE LETTERFORM — Reed College, 1972 (cine)
// ---------------------------------------------------------------------------
const reed = defineScene({
  id: "reed",
  main: image("art/bg_reed.png"),
  backdrop: "#181410",
  play: cue(function* () {
    yield letterbox(14, 1);
    yield fadeIn(45);
    yield caption("chip", "REED COLLEGE, 1972");
    yield wait(30);
    yield caption("sub", "You dropped out after\nsix months. Then stayed.");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "Friends' floors. Coke\nbottles. A 7-mile walk");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "for one good meal a\nweek. And one classroom.");
    yield waitA();
    yield captionClear("all");
    yield letterbox(0, 25);
    yield caption("chip", "THE CALLIGRAPHY ROOM");
    yield wait(20);
    yield caption("card", "SERIF. SANS SERIF.");
    yield wait(70);
    yield captionClear("card");
    yield caption("sub", "What makes letters\nbeautiful. Palladino's");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "class. None of it looked\nuseful for a living.");
    yield waitA();
    yield captionClear("all");
    yield caption("card", "REMEMBER THIS ROOM.");
    yield wait(90);
    yield captionClear("all");
    yield mosaicTo(10, 40);
    yield waitTweens();
    yield caption("chip", "THEN: INDIA, 7 MONTHS");
    yield mosaicTo(0, 30);
    yield caption("sub", "The ashram stood empty.\nThe guru died last fall.");
    yield waitA();
    yield captionClear("all");
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 5 · BREAKOUT — Atari, 1975, four nights (cine + minigame)
// ---------------------------------------------------------------------------
const atari = defineScene({
  id: "atari",
  main: image("art/bg_atari.png"),
  backdrop: "#0a0c14",
  actors: {
    woz: sprite("art/spr_woz.png", { w: 32, h: 32, frames: 3, walkFpd: 1, at: [40, 100] }),
  },
  play: cue(function* () {
    yield fadeIn(40);
    yield caption("chip", "ATARI, 1975. NIGHT SHIFT");
    yield wait(30);
    yield dialog("THE BOSS", "Breakout. Fewer chips,\nbigger bonus. Four days.");
    yield show("woz");
    yield dialog("WOZ", "I'll design it. You\nwire and test. No sleep.");
    yield captionClear("all");
    yield caption("sub", "Keep the prototype alive\nuntil dawn. A to launch.");
    yield waitA();
    yield captionClear("all");
    const n = yield breakout(4, 3, 3600);
    yield setVar("bricks", n);
    if (yield varGe("bricks", 40)) {
      yield caption("sub", "The wall came down\nbefore the sun came up.");
    } else {
      yield caption("sub", "Dawn came first. The\ndesign held anyway.");
    }
    yield waitA();
    yield captionClear("all");
    yield caption("sub", "44-46 chips. So tight\nAtari couldn't build it.");
    yield waitA();
    yield captionClear("all");
    yield letterbox(14, 25);
    yield caption("sub", "Woz got $350 of what\nyou called $700.");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "A book later said there\nwas a bonus. He denied it.");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "Woz cried anyway. And\nsaid he'd do it for free.");
    yield waitA();
    yield captionClear("all");
    yield fadeOut(45);
  }),
});

// ---------------------------------------------------------------------------
// 6 · FIFTY BOARDS — Los Altos garage, April 1976 (world + encounter)
// ---------------------------------------------------------------------------
const garage76 = defineScene({
  id: "garage76",
  main: image("art/map_garage76.png"),
  backdrop: "#141018",
  actors: {
    hero: sprite("art/spr_hero.png", { w: 32, h: 32, frames: 12, walkFpd: 4 }),
    woz: sprite("art/spr_woz.png", { w: 32, h: 32, frames: 3, walkFpd: 1 }),
    supplier: sprite("art/port_supplier.png", { w: 64, h: 64, screen: true }),
  },
  world: {
    grid: [
      "####################",
      "####################",
      "####################",
      "####################",
      "####################",
      "########ddd#########",
      ".................###",
      "#..w...............#",
      "#.######.....#######",
      "#.######.....#######",
      "..######..p..#######",
      "########.....#######",
      "########.....#######",
      "##...............###",
      "....................",
    ],
    player: { actor: "hero", at: "p", dir: "up" },
    npcs: {
      woz: {
        actor: "woz",
        at: "w",
        dir: "down",
        talk: cue(function* () {
          if (yield hasFlag("woz76")) {
            yield dialog("WOZ", "Every single board\nworks. Every one.");
          } else {
            yield dialog("WOZ", "I design at my HP desk.\nHere we just test.");
            yield dialog("WOZ", "Fifty boards in thirty\ndays. We can do this.");
            yield setFlag("woz76");
          }
        }),
      },
    },
    spots: {
      tableL: {
        at: [2, 8, 6, 5],
        run: cue(function* () {
          yield caption("sub", "Patti and Dan solder.\nA dollar a board.");
          yield waitA();
          yield captionClear("all");
        }),
      },
      tableR: {
        at: [13, 8, 5, 5],
        run: cue(function* () {
          yield caption("sub", "Burned-in, tested,\nstacked. Day by day.");
          yield waitA();
          yield captionClear("all");
        }),
      },
      paper: {
        at: [2, 2, 2, 4],
        run: cue(function* () {
          yield caption("sub", "The partnership paper.\nApril 1. Woz, you, Wayne.");
          yield waitA();
          yield captionClear("all");
        }),
      },
      phone: {
        at: [7, 3, 1, 3],
        run: cue(function* () {
          if (yield varEq("credit", 1)) {
            yield dialog("SUPPLIER", "Thirty days, kid.\nDon't be late.");
            return;
          }
          yield caption("sub", "The parts man again.\nHe wants cash up front.");
          yield waitA();
          yield captionClear("all");
          yield show("supplier", 168, 24);
          yield setVar("trust", 2);
          yield meterShow(0, "trust", 16, 32, 8);
          while (yield varLt("trust", 8)) {
            const m = yield choice(["Mention the order", "Promise net thirty", "Talk faster"]);
            if (m === 0) {
              yield dialog("YOU", "Fifty boards for the\nByte Shop. Cash on");
              yield dialog("YOU", "delivery. Call Paul\nTerrell. He'll confirm.");
              yield sfx("confirm");
              yield addVar("trust", 3);
            }
            if (m === 1) {
              yield dialog("YOU", "Parts now, paid in 30\ndays. We ship in 29.");
              yield sfx("blip");
              yield addVar("trust", 2);
            }
            if (m === 2) {
              yield dialog("SUPPLIER", "Slow down. Talking\nfaster isn't collateral.");
              yield addVar("trust", -1);
            }
          }
          yield shake(2, 20);
          yield dialog("SUPPLIER", "...Net thirty. If Terrell\nvouches, you get parts.");
          yield meterHide(0);
          yield hide("supplier");
          yield setVar("credit", 1);
          yield sfx("star");
          yield caption("sub", "Parts on credit. The\nclock starts now.");
          yield waitA();
          yield captionClear("all");
        }),
      },
    },
    exits: { door: { at: "d", value: 1 } },
  },
  play: cue(function* () {
    yield setVar("credit", 0);
    yield clrFlag("woz76");
    yield letterbox(12, 1);
    yield fadeIn(40);
    yield caption("chip", "LOS ALTOS, APRIL 1976");
    yield letterbox(0, 25);
    yield caption("sub", "Yesterday, barefoot, you\nwalked into the Byte Shop.");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "Terrell: 50 assembled,\ntested boards. $500 each,");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "cash on delivery. You\nhave no parts. No money.");
    yield waitA();
    yield captionClear("all");
    while (yield varEq("credit", 0)) {
      yield world();
      if (yield varEq("credit", 0)) {
        yield caption("sub", "Not yet. No parts, no\ndelivery. Try the phone.");
        yield waitA();
        yield captionClear("all");
        yield warp(9, 6, "down");
      }
    }
    yield captionClear("all");
    yield caption("card", "DAY 29: DELIVERED.");
    yield wait(80);
    yield captionClear("all");
    yield caption("sub", "Apple I. $666.66 retail.\nAbout 175 ever sold.");
    yield waitA();
    yield captionClear("all");
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 7 · THE FAIRE — San Francisco, April 1977 (cine bridge)
// ---------------------------------------------------------------------------
const faire = defineScene({
  id: "faire",
  main: image("art/bg_faire.png"),
  backdrop: "#101018",
  play: cue(function* () {
    yield fadeIn(40);
    yield caption("chip", "SAN FRANCISCO, 1977");
    yield wait(30);
    yield caption("sub", "The booth faces the\nentrance. On purpose.");
    yield waitA();
    yield captionClear("sub");
    yield caption("card", "APPLE II");
    yield wait(70);
    yield captionClear("card");
    yield caption("sub", "Three finished units.\nBehind them, a bluff of");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "empty cases. $1,298 in\na home-friendly shell.");
    yield waitA();
    yield captionClear("all");
    yield letterbox(14, 25);
    yield caption("chip", "DEC 12, 1980: THE IPO");
    yield caption("sub", "Around 300 people became\nmillionaires that day.");
    yield waitA();
    yield captionClear("all");
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 8 · THE GOLDMINE — Xerox PARC, December 1979 (world)
// ---------------------------------------------------------------------------
const parc = defineScene({
  id: "parc",
  main: image("art/map_parc.png"),
  backdrop: "#181418",
  actors: {
    hero: sprite("art/spr_hero.png", { w: 32, h: 32, frames: 12, walkFpd: 4 }),
    res: sprite("art/spr_res.png", { w: 32, h: 32, frames: 3, walkFpd: 1 }),
  },
  world: {
    grid: [
      "####################",
      "####################",
      "####################",
      "####################",
      "###.....####ddd..###",
      "###.....##.......###",
      "###..r...........###",
      "..................#.",
      ".................##.",
      "##...............##.",
      "##..................",
      "##..................",
      "##..................",
      "##................##",
      "##..................",
    ],
    player: { actor: "hero", at: [10, 11], dir: "up" },
    npcs: {
      res: {
        actor: "res",
        at: "r",
        dir: "down",
        talk: cue(function* () {
          if (yield hasFlag("res79")) {
            yield dialog("RESEARCHER", "The suits upstairs have\nno idea what this is.");
          } else {
            yield dialog("RESEARCHER", "Corporate sold you this\ndemo. A million dollars");
            yield dialog("RESEARCHER", "of your pre-IPO shares\nfor a look. A look!");
            yield setFlag("res79");
          }
        }),
      },
    },
    spots: {
      alto: {
        at: [8, 2, 4, 4],
        run: cue(function* () {
          yield caption("sub", "A white screen. Windows.\nMenus. A little arrow");
          yield waitA();
          yield captionClear("sub");
          yield caption("sub", "that follows your hand\nacross the desk.");
          yield waitA();
          yield captionClear("all");
          yield shake(2, 25);
          yield dialog("YOU", "You're sitting on a\ngold mine! Why aren't");
          yield dialog("YOU", "you doing something\nwith this technology?");
          yield setFlag("alto");
          yield sfx("star");
        }),
      },
    },
    autos: {
      blinded: {
        at: [8, 8, 4, 2],
        run: cue(function* () {
          yield caption("sub", "They showed you three\nthings that day.");
          yield waitA();
          yield captionClear("sub");
          yield caption("sub", "You were so blinded by\nthe first, you missed two.");
          yield waitA();
          yield captionClear("all");
        }),
      },
    },
    exits: { door: { at: "d", value: 1 } },
  },
  play: cue(function* () {
    yield clrFlag("res79");
    yield clrFlag("alto");
    yield letterbox(12, 1);
    yield fadeIn(40);
    yield caption("chip", "XEROX PARC, DEC 1979");
    yield letterbox(0, 25);
    while (!(yield hasFlag("alto"))) {
      yield world();
      if (!(yield hasFlag("alto"))) {
        yield caption("sub", "Not yet. See the machine\nby the bookshelves first.");
        yield waitA();
        yield captionClear("all");
        yield warp(13, 5, "left");
      }
    }
    yield captionClear("all");
    yield caption("sub", "Ten minutes in, you knew\nhow all computers would");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "work, someday. Xerox\nnever did sell it.");
    yield waitA();
    yield captionClear("all");
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 9 · SUGARED WATER — San Remo terrace, March 1983 (encounter)
// ---------------------------------------------------------------------------
const sculley = defineScene({
  id: "sculley",
  main: image("art/bg_penthouse.png"),
  backdrop: "#181020",
  actors: {
    sc: sprite("art/port_sculley.png", { w: 64, h: 64, screen: true }),
    me: sprite("art/port_hero.png", { w: 64, h: 64, screen: true }),
  },
  play: cue(function* () {
    yield letterbox(14, 1);
    yield fadeIn(45);
    yield caption("chip", "SAN REMO TERRACE, 1983");
    yield wait(30);
    yield caption("sub", "The penthouse you're\nbuying. He runs Pepsi.");
    yield waitA();
    yield captionClear("all");
    yield show("sc", 168, 28);
    yield show("me", 8, 28);
    yield dialog("SCULLEY", "Pepsi is a good life,\nSteve. Why would I go?");
    yield setVar("conv", 2);
    yield meterShow(0, "conv", 88, 34, 8);
    while (yield varLt("conv", 8)) {
      const m = yield choice(["Talk numbers", "Paint the future", "The question"]);
      if (m === 0) {
        yield dialog("YOU", "Apple will do a billion\nin revenue by--");
        yield dialog("SCULLEY", "I run a company twice\nthat size. Next.");
        yield addVar("conv", -1);
      }
      if (m === 1) {
        if (yield varLe("conv", 3)) {
          yield dialog("YOU", "Computers will be\nbicycles for the mind.");
          yield sfx("blip");
        } else {
          yield dialog("YOU", "We're not selling boxes.\nWe're bending the curve");
          yield dialog("YOU", "of what a person\ncan do alone.");
          yield sfx("blip");
        }
        yield addVar("conv", 2);
      }
      if (m === 2) {
        if (yield varLt("conv", 6)) {
          yield dialog("SCULLEY", "Ask me when you mean\nit, Steve.");
        } else {
          yield shake(2, 30);
          yield dialog("YOU", "Do you want to spend\nthe rest of your life");
          yield dialog("YOU", "selling sugared water,\nor do you want a chance");
          yield dialog("YOU", "to change the world?");
          yield setVar("conv", 8);
        }
      }
    }
    yield sfx("star");
    yield wait(20);
    yield dialog("SCULLEY", "...");
    yield dialog("SCULLEY", "You're dangerous,\nSteve Jobs.");
    yield meterHide(0);
    yield caption("chip", "HE SAID YES IN APRIL.");
    yield wait(90);
    yield captionClear("all");
    yield fadeOut(45, "white");
  }),
});

// ---------------------------------------------------------------------------
// 10 · PIRATES — Bandley 3, August 1983 (world)
// ---------------------------------------------------------------------------
const bandley = defineScene({
  id: "bandley",
  main: image("art/map_bandley.png"),
  backdrop: "#101420",
  actors: {
    hero: sprite("art/spr_hero.png", { w: 32, h: 32, frames: 12, walkFpd: 4 }),
    team: sprite("art/spr_team.png", { w: 32, h: 32, frames: 3, walkFpd: 1 }),
    flag: sprite("art/spr_flag.png", { w: 32, h: 32 }),
    mac: sprite("art/spr_mac.png", { w: 32, h: 32 }),
  },
  world: {
    grid: [
      "####################",
      "####################",
      "####################",
      "####################",
      "####.#ddd#####.#####",
      "####.....####..#####",
      "####...........#####",
      "####...........#####",
      "...##...t.......####",
      ".####..........#####",
      ".####............###",
      ".####...............",
      "....................",
      "#..###.......###...#",
      "#..###.......###...#",
    ],
    player: { actor: "hero", at: [10, 10], dir: "up" },
    npcs: {
      team: {
        actor: "team",
        at: "t",
        dir: "down",
        talk: cue(function* () {
          if (yield hasFlag("team83")) {
            yield dialog("ENGINEER", "The Lisa folks will\nsteal that flag someday.");
          } else {
            yield dialog("ENGINEER", "90 hours a week and\nloving it. Mostly.");
            yield dialog("ENGINEER", "Ship date is January\n24th. Nobody sleeps.");
            yield setFlag("team83");
          }
        }),
      },
    },
    spots: {
      flagpole: {
        at: [16, 3, 3, 3],
        run: cue(function* () {
          yield caption("sub", "Capps sewed the flag.\nKare painted the skull.");
          yield waitA();
          yield captionClear("all");
          yield caption("card", "BETTER TO BE A PIRATE\nTHAN JOIN THE NAVY");
          yield wait(90);
          yield captionClear("all");
          yield setFlag("flag83");
          yield sfx("confirm");
        }),
      },
      macdesk: {
        at: [15, 6, 4, 4],
        run: cue(function* () {
          yield caption("sub", "The prototype. Nine-inch\nscreen. It says hello.");
          yield waitA();
          yield captionClear("all");
          yield dialog("YOU", "The Apple II is the\npast. This is the future.");
          yield setFlag("mac83");
        }),
      },
    },
    exits: { door: { at: "d", value: 1 } },
  },
  play: cue(function* () {
    yield clrFlag("team83");
    yield clrFlag("flag83");
    yield clrFlag("mac83");
    yield letterbox(12, 1);
    yield fadeIn(40);
    yield caption("chip", "BANDLEY 3, AUGUST 1983");
    yield letterbox(0, 25);
    yield show("flag", 272, 40);
    while (!(yield hasFlag("mac83"))) {
      yield world();
      if (!(yield hasFlag("mac83"))) {
        yield caption("sub", "Not yet. Look at the\nprototype on the desk.");
        yield waitA();
        yield captionClear("all");
        yield warp(7, 5, "down");
      }
    }
    yield captionClear("all");
    yield fadeOut(40);
  }),
});

// ---------------------------------------------------------------------------
// 11 · HELLO — Flint Center, January 24, 1984 (cine finale)
// ---------------------------------------------------------------------------
const keynote = defineScene({
  id: "keynote",
  main: image("art/bg_stage84.png"),
  backdrop: "#06070c",
  actors: {
    mac: sprite("art/spr_mac.png", { w: 32, h: 32, at: [112, 64], screen: true }),
  },
  play: cue(function* () {
    yield letterbox(16, 1);
    yield fadeIn(50);
    yield caption("chip", "FLINT CENTER, 1984");
    yield wait(30);
    yield caption("sub", "January 24. The annual\nshareholders meeting.");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "Black suit. Bow tie.\nYou recite Dylan.");
    yield waitA();
    yield captionClear("sub");
    yield caption("sub", "The Super Bowl ad plays\none more time. Press A!");
    yield setVar("claps", 0);
    yield counter("claps", 208, 24);
    yield mash("claps", 15);
    yield counterHide();
    yield captionClear("all");
    yield sfx("whoosh");
    yield letterbox(0, 30);
    yield caption("sub", "You pull it out of a\ncanvas bag. Insert floppy.");
    yield waitA();
    yield captionClear("all");
    yield show("mac");
    yield affineOn("mac");
    yield zoom(0.3, 1);
    yield zoom(1.0, 70, "out");
    yield waitTweens();
    yield caption("sub", "Chariots of Fire swells.\n(A 512K prototype. Shh.)");
    yield waitA();
    yield captionClear("all");
    yield wait(20);
    yield dialog("MACINTOSH", "Hello, I am Macintosh.\nIt sure is great to get");
    yield dialog("MACINTOSH", "out of that bag!");
    yield dialog("MACINTOSH", "Never trust a computer\nthat you can't lift!");
    yield shake(2, 30);
    yield dialog("MACINTOSH", "It is with considerable\npride that I introduce");
    yield dialog("MACINTOSH", "a man who's been like\na father to me:");
    yield dialog("MACINTOSH", "Steve Jobs!");
    yield sfx("star");
    yield shake(3, 60);
    yield caption("sub", "Five minutes of thunder.\nThe whole room, standing.");
    yield waitA();
    yield captionClear("all");
    yield caption("sub", "You are 28. You hold\nback tears. Barely.");
    yield waitA();
    yield captionClear("all");
    yield zoom(1.3, 120, "inout");
    yield fadeOut(70, "white");
  }),
});

// ---------------------------------------------------------------------------
// 12 · CREDITS (cine)
// ---------------------------------------------------------------------------
const credits = defineScene({
  id: "credits",
  main: image("art/bg_orchard.png"),
  backdrop: "#101018",
  play: cue(function* () {
    yield fadeIn(60, "white");
    yield caption("card", "REALITY DISTORTION");
    yield caption("chip", "PART ONE, 1955-1984");
    yield wait(140);
    yield captionClear("all");
    yield caption("sub", "Documented lines appear\nas recorded. The rest is");
    yield wait(120);
    yield captionClear("sub");
    yield caption("sub", "original fan writing.\nSources: game/dossier.md");
    yield wait(120);
    yield captionClear("all");
    yield caption("sub", "A tribute. Not affiliated\nwith or endorsed.");
    yield wait(120);
    yield captionClear("all");
    yield caption("card", "PART TWO:\nTHE WILDERNESS");
    yield wait(140);
    yield captionClear("all");
    yield caption("sub", "@pocketjs/saga engine.\nPixel art via PixelLab.");
    yield wait(120);
    yield captionClear("all");
    yield fadeOut(50);
    yield gotoScene("title");
  }),
});

export default defineFilm({
  title: "REALITY DISTORTION",
  scenes: [title, garage62, hewlett, bluebox, reed, atari, garage76, faire, parc, sculley, bandley, keynote, credits],
});
