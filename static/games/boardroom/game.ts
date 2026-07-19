// static/games/boardroom/game.ts — BOARDROOM
//
// Five days in November 2023, playable. You are Sam Altman; the speedrun
// category is "fired to rehired". A satirical adaptation of the OpenAI board
// crisis — events, dates and quoted lines follow the public record
// (see dossier.md for sources); all other dialogue is original parody.
//
// One TypeScript module in, three cartridges out: GBA, Game Boy, NES.

import { defineGame, defineMap, npc, script, trigger, warp, type Flags, type Ops, type Vars } from "@pocketjs/static/rpg";
import { battle } from "@pocketjs/static/rpg/battle";
import { board, emmett, employee, greg, ilya, mira, office, sam, satya } from "./assets.ts";

// ---------------------------------------------------------------------------
// Chapter 1 — THE CALL (Fri Nov 17, a Las Vegas hotel room)
// ---------------------------------------------------------------------------
const TheCall = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.sfx("deny");
  yield* s.say("FRIDAY, NOV 17. LAS VEGAS. F1 weekend. You are SAM ALTMAN, and your laptop is ringing at noon.");
  yield* s.say("A Google Meet. The whole board, minus Greg. ILYA does the talking.");
  yield* s.say("ILYA: Sam, the board has reviewed. You were, quote, not consistently candid in your communications.");
  yield* s.say("ILYA: You are fired. The blog post is already up.");
  const pick = yield* s.choose(["Ask why", "Stay calm", "Refresh X"]);
  if (pick === "Ask why") {
    yield* s.say("SAM: Candid about WHAT, exactly?");
    yield* s.say("The call has ended.");
  } else if (pick === "Stay calm") {
    yield* s.say("You are confused beyond belief, but your face does inbox-zero.");
    yield* s.say("The call has ended.");
  } else {
    yield* s.say("Too late. Everyone else already knows. Microsoft got one minute of warning.");
  }
  yield* s.say("Your phone melts: 4 percent battery, 611 unread. MIRA is interim CEO. She found out last night.");
  yield* s.wait(30);
  yield* s.sfx("confirm");
  yield* s.say("GREG (12:23 PM): removed as chairman, quote, keeping my role.");
  yield* s.say("GREG (evening): based on today's news, i quit.");
  yield* s.say("Three senior researchers follow him out the door before midnight.");
  yield* s.say("You type: i loved my time at openai. You add the salute. o7");
  f.fired = true;
  yield* s.release();
});

const HotelDoor = script(function* (s, v, f) {
  if (f.fired) {
    yield* s.say("Vegas can wait. San Francisco cannot.");
    yield* s.say("SUNDAY, NOV 19. OPENAI HQ. You are holding a GUEST badge.");
    yield* s.say("SAM: first and last time i ever wear one of these.");
    f.badge = true;
    yield* s.warp("hq:lobby");
  } else {
    yield* s.say("The laptop is still ringing. Better answer it first.");
  }
});

// ---------------------------------------------------------------------------
// HQ cast
// ---------------------------------------------------------------------------
const MiraTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("MIRA: Back to CTO, thank goodness. Ship something.");
  } else if (f.letter_active) {
    if (f.mira_boost) {
      yield* s.say("MIRA: The letter is out. Go collect the rest of us.");
    } else {
      yield* s.say("MIRA: I posted five words this morning.");
      yield* s.say("MIRA: OpenAI is nothing without its people.");
      yield* s.say("The reposts stack up like a DDoS. Hearts everywhere. <3 <3 <3");
      v.sigs += 200;
      f.mira_boost = true;
      yield* s.sfx("fanfare");
      yield* s.say(`Signatures: ${v.sigs} of 770.`);
    }
  } else if (f.ms_open) {
    yield* s.say("MIRA: Go see Satya. Then come back for the part where we save this place.");
  } else if (f.shear_met) {
    yield* s.say("MIRA: Your phone. Redmond is calling, and it is not about Teams.");
    yield* s.say("SATYA (on the phone): We remain committed to our partnership with OpenAI...");
    yield* s.say("SATYA: ...and Sam and Greg will be joining Microsoft to lead a new advanced AI research team.");
    yield* s.say("SAM (replying): one team, one mission.");
    f.ms_open = true;
    yield* s.sfx("confirm");
    yield* s.say("Microsoft's office is now open, across town. (West door.)");
  } else {
    yield* s.say("MIRA: They told me the night before. Only me.");
    yield* s.say("MIRA: The memo says it was NOT malfeasance. Just, quote, a breakdown in communication.");
    yield* s.say("MIRA: The board is holed up in the BOARDROOM, east. They picked an interim CEO who is not me. Again.");
  }
  yield* s.release();
});

function* employeeLine(s: Ops, v: Vars, f: Flags, line: string) {
  yield* s.lock();
  yield* s.face();
  if (f.letter_active && !f.letter_first) {
    yield* s.say(line);
    yield* s.say("EMP: quote, We are unable to work for people who lack competence, judgement and care. unquote.");
    v.sigs += 505;
    f.letter_first = true;
    yield* s.sfx("fanfare");
    yield* s.say(`Signatures: ${v.sigs} of 770.`);
  } else if (f.letter_active) {
    yield* s.say(line);
    yield* s.say(`EMP: Counter says ${v.sigs}. Ilya has not signed. Yet.`);
  } else if (f.fired) {
    yield* s.say(line);
  } else {
    yield* s.say("EMP: Heads down. Shipping.");
  }
  yield* s.release();
}

const Emp1Talk = script(function* (s, v, f) {
  yield* employeeLine(s, v, f, "EMP: The Slack is just heart emojis now. It means we walk if you do.");
});
const Emp2Talk = script(function* (s, v, f) {
  yield* employeeLine(s, v, f, "EMP: Three CEOs in three days. I stopped updating the org chart.");
});
const Emp3Talk = script(function* (s, v, f) {
  yield* employeeLine(s, v, f, "EMP: The tender offer was at 86 billion. WAS.");
});

const HqEnter = script(function* (s, v, f) {
  if (f.fired && !f.hq_seen) {
    f.hq_seen = true;
    yield* s.lock();
    yield* s.say("OPENAI HQ. The espresso machine is the only thing still operating normally.");
    yield* s.say("MIRA waits by the desks. The BOARDROOM is east.");
    yield* s.release();
  }
});

const HqWestDoor = script(function* (s, v, f) {
  if (f.ms_open) {
    yield* s.warp("msoffice:door");
  } else {
    yield* s.say("Across town: Microsoft. No reason to go. Yet.");
  }
});

const HqEastDoor = script(function* (s, v, f) {
  yield* s.warp("boardroom:door");
});

// ---------------------------------------------------------------------------
// Boardroom cast
// ---------------------------------------------------------------------------
const AdamTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("ADAM: For the record, I never left the board. Continuity matters.");
  } else if (f.letter_full) {
    yield* s.say("ADAM: You brought a letter to a governance fight?");
    const go = yield* s.choose(["Negotiate", "Not yet"]);
    if (go === "Negotiate") {
      yield* s.say("TUESDAY, NOV 21. 10 PM. Final session. The BOARD digs in.");
      yield* battle(s, v, f, {
        foe: "THE BOARD",
        foeHp: 14,
        myName: "CRED",
        myHp: 10,
        foeDmg: 1,
        foeBonus: 2,
        foeQuip: "THE BOARD cites governance structure.",
        winFlag: "won",
        labels: ["TENDER OFFER", "HEART EMOJIS", "THE LETTER"],
        moves: [
          {
            i: 0,
            label: "TENDER OFFER",
            dmg: 2,
            bonus: 3,
            heal: 0,
            gate: "",
            fizzle: "",
            quip: "You mention the 86B tender offer, gently.",
          },
          {
            i: 1,
            label: "HEART EMOJIS",
            dmg: 1,
            bonus: 0,
            heal: 2,
            gate: "",
            fizzle: "",
            quip: "The timeline floods with hearts.",
          },
          {
            i: 2,
            label: "THE LETTER",
            dmg: 4,
            bonus: 3,
            heal: 0,
            gate: "letter_full",
            fizzle: "The letter is missing signatures. It reads as a group chat.",
            quip: "743 of 770 names. Ilya's is on it.",
          },
        ],
      });
      if (f.won) {
        yield* s.call(Ending);
      } else {
        yield* s.say("THE BOARD holds. Rest, then talk to Adam again.");
      }
    } else {
      yield* s.say("ADAM: The offer expires when the news cycle does.");
    }
  } else if (f.shear_met) {
    yield* s.say("ADAM: An agreement needs leverage, Sam. Bring some.");
  } else {
    yield* s.say("ADAM: The board has full confidence in its process.");
    yield* s.say("HELEN: The process was the deliberative review.");
    yield* s.say("TASHA: The review was the process.");
  }
  yield* s.release();
});

const BoardMember1 = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("HELEN: I am leaving the board. My paper stands.");
  } else {
    yield* s.say("HELEN: My CSET paper praised a competitor's safety posture. You tried to remove me for it.");
  }
  yield* s.release();
});

const BoardMember2 = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("TASHA: Governance is a marathon. We sprinted.");
  } else {
    yield* s.say("TASHA: This is fine.");
  }
  yield* s.release();
});

const EmmettTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("EMMETT: Shortest CEO stint of my life, and I co-founded a streaming site.");
  } else if (!f.shear_met) {
    yield* s.say("Sunday, near midnight: the board appoints EMMETT SHEAR, of Twitch, interim CEO. The third CEO in three days.");
    yield* s.say("EMMETT: Before I took this job, I checked. The board did NOT remove Sam over any specific safety disagreement.");
    yield* s.say("EMMETT: My 30-day plan has one bullet in bold: hire an independent investigator.");
    f.shear_met = true;
    yield* s.say("EMMETT: Between us? Go make my job unnecessary. Mira has your phone.");
  } else {
    yield* s.say("EMMETT: I am not a caretaker CEO without evidence. Bring me an ending.");
  }
  yield* s.release();
});

const IlyaTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.ilya_flipped) {
    yield* s.say("ILYA: The board seat mattered less than the lab. Go finish it.");
  } else if (f.letter_active) {
    yield* s.say("ILYA stares at the table for a long time.");
    yield* s.say("Anna Brockman stood right here yesterday, in tears. Ilya officiated her wedding at this office.");
    yield* s.say("ILYA: I deeply regret my participation in the board's actions. I never intended to harm OpenAI.");
    yield* s.say("He signs the letter. Number 738 through 743 sign with him.");
    v.sigs += 38;
    f.ilya_flipped = true;
    f.letter_full = true;
    yield* s.sfx("fanfare");
    yield* s.say(`Signatures: ${v.sigs} of 770. The letter is ready. ADAM is waiting.`);
  } else {
    yield* s.say("ILYA: The board acted with... deliberation.");
    yield* s.say("He does not look deliberate. He looks miserable.");
  }
  yield* s.release();
});

const BoardroomDoor = script(function* (s, v, f) {
  yield* s.warp("hq:eastdoor");
});

// ---------------------------------------------------------------------------
// Microsoft office
// ---------------------------------------------------------------------------
const SatyaTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("SATYA: The partnership endures. Also we get a board observer seat now.");
  } else if (!f.ms_done) {
    yield* s.say("SATYA: Welcome. Badges are printing. A new advanced AI research team, funded on day one.");
    const pick = yield* s.choose(["Join MSFT", "Stall politely"]);
    if (pick === "Join MSFT") {
      yield* s.say("SATYA: Excellent. Although, between us, I would rather you fix OpenAI. That is where the GPUs already are.");
    } else {
      yield* s.say("SATYA: Good instinct. This offer works best as leverage anyway.");
    }
    f.ms_done = true;
    f.letter_active = true;
    yield* s.say("GREG: The letter is circulating at HQ right now. Everyone is waiting for you.");
  } else {
    yield* s.say("SATYA: Every OpenAI employee has a guaranteed seat here. All seven hundred. We remain committed.");
  }
  yield* s.release();
});

const GregTalk = script(function* (s, v, f) {
  yield* s.lock();
  yield* s.face();
  if (f.won) {
    yield* s.say("GREG: un-quit. one commit, force pushed.");
  } else if (f.letter_active) {
    yield* s.say("GREG: Anna went to see Ilya at HQ. I have never seen her that determined.");
  } else {
    yield* s.say("GREG: i quit at 12:19 and had a new org chart by 12:23. efficiency.");
  }
  yield* s.release();
});

const MsDoor = script(function* (s, v, f) {
  yield* s.warp("hq:westdoor");
});

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------
const Ending = script(function* (s, v, f) {
  yield* s.say("10:02 PM: We have reached an agreement in principle for Sam Altman to return to OpenAI as CEO.");
  yield* s.say("New initial board: Bret Taylor, chair. Larry Summers. Adam D'Angelo.");
  yield* s.say("Helen Toner and Tasha McCauley depart. Ilya keeps the lab, not the seat.");
  yield* s.say("WEDNESDAY, NOV 29: it is official. Mira is CTO again. The tender offer is back on.");
  yield* s.say("Months later, the independent review lands: a breakdown of trust. Not safety. Not the products.");
  yield* s.say("Total time fired: 106 hours. CEOs consumed: 3. Signatures: 743 of 770.");
  yield* s.say("Slack, forever after: <3 <3 <3 <3 <3");
  yield* s.sfx("fanfare");
  yield* s.say("BOARDROOM - fin. Built with Pocket Static: one TypeScript file, three consoles.");
});

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------
const hotel = defineMap("hotel", {
  tileset: office,
  layout: `
    ############
    #..........#
    #.n........#
    #..........#
    #....c.....#
    #..........#
    ######d#####
  `,
  legend: { "#": "wall", ".": "carpet", n: "laptop", c: "chair", d: "door" },
  entrances: {
    start: { at: [3, 3], dir: "up" },
  },
  triggers: [
    trigger({ at: [2, 3], run: TheCall, once: true }),
    trigger({ at: [6, 6], run: HotelDoor }),
  ],
});

const hq = defineMap("hq", {
  tileset: office,
  layout: `
    ####w####w####w####w
    #..................#
    #.~n..~n......~n...#
    #..................#
    #.p..............p.#
    #..................#
    d..................D
    #..................#
    #...~n....~n.......#
    #..................#
    ####################
  `,
  legend: { "#": "wall", w: "window", ".": "floor", "~": "desk", n: "laptop", p: "plant", d: "door", D: "door" },
  entrances: {
    lobby: { at: [10, 6], dir: "up" },
    westdoor: { at: [1, 6], dir: "right" },
    eastdoor: { at: [18, 6], dir: "left" },
  },
  actors: [
    npc("mira", { sprite: mira, at: [9, 4], facing: "down", talk: MiraTalk }),
    npc("emp1", { sprite: employee, at: [2, 3], facing: "down", talk: Emp1Talk }),
    npc("emp2", { sprite: employee, at: [7, 3], facing: "down", talk: Emp2Talk }),
    npc("emp3", { sprite: employee, at: [11, 9], facing: "up", talk: Emp3Talk }),
  ],
  triggers: [
    trigger({ at: [0, 6], run: HqWestDoor }),
    trigger({ at: [19, 6], run: HqEastDoor }),
  ],
  onEnter: HqEnter,
});

const boardroom = defineMap("boardroom", {
  tileset: office,
  layout: `
    ######w##w######
    #..............#
    #..............#
    #...ttttttt....#
    #..............#
    #..............#
    #..............#
    d..............#
    ################
  `,
  legend: { "#": "wall", w: "window", ".": "carpet", t: "table", d: "door" },
  entrances: {
    door: { at: [1, 7], dir: "right" },
  },
  actors: [
    npc("adam", { sprite: board, at: [5, 2], facing: "down", talk: AdamTalk }),
    npc("helen", { sprite: board, at: [7, 2], facing: "down", talk: BoardMember1 }),
    npc("tasha", { sprite: board, at: [9, 2], facing: "down", talk: BoardMember2 }),
    npc("ilya", { sprite: ilya, at: [5, 5], facing: "down", talk: IlyaTalk }),
    npc("emmett", { sprite: emmett, at: [11, 5], facing: "left", talk: EmmettTalk }),
  ],
  triggers: [trigger({ at: [0, 7], run: BoardroomDoor })],
});

const msoffice = defineMap("msoffice", {
  tileset: office,
  layout: `
    ####ww####ww####
    #.ss.......gg..#
    #..............#
    #..............#
    #...tt.........#
    #..............#
    #..............#
    d..............#
    ################
  `,
  legend: { "#": "wall", w: "window", ".": "floor", t: "table", s: "server", g: "plant", d: "door" },
  entrances: {
    door: { at: [1, 7], dir: "right" },
  },
  actors: [
    npc("satya", { sprite: satya, at: [5, 3], facing: "down", talk: SatyaTalk }),
    npc("greg", { sprite: greg, at: [10, 5], facing: "down", talk: GregTalk }),
  ],
  triggers: [trigger({ at: [0, 7], run: MsDoor })],
});

defineGame({
  title: "BOARDROOM",
  start: "hotel:start",
  player: sam,
  maps: [hotel, hq, boardroom, msoffice],
});
