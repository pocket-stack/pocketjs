// saga/test/e2e.ts — build REALITY DISTORTION and play it headlessly in mGBA,
// asserting the debug-block contract: title menu, world roaming + gates
// (workbench), the Breakout night, the sugared-water conviction battle, the
// Bandley -> Flint Center chain with the Mac's documented line, and the
// credits -> title loop.
//
//   bun test/e2e.ts

import { $ } from "bun";
import { compileFilm } from "../compiler/index.ts";
import { emitGenData } from "../compiler/emit.ts";
import { buildRom } from "../compiler/rom.ts";
import { DEBUG_ADDR, DBG, DBG_MAGIC, WAITING, SCENE_WORLD, SCENE_CINE } from "../spec/saga.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = HERE + "../";
const RUNNER = ROOT + "../aot/test/harness/mgba_runner";
const ROM = ROOT + "dist/reality-distortion.gba";
const SHOTS = ROOT + "dist/shots";

type Step =
  | { op: "advance"; frames: number }
  | { op: "press"; buttons: string[]; frames: number; release?: number }
  | { op: "read"; name: string; addr: number; size: 1 | 2 | 4 }
  | { op: "screenshot"; path: string };

const A = (n = 8): Step => ({ op: "press", buttons: ["A"], frames: 1, release: n });
const DOWN: Step = { op: "press", buttons: ["DOWN"], frames: 1, release: 6 };
const hold = (b: string, frames: number): Step => ({ op: "press", buttons: [b], frames, release: 4 });
const adv = (frames: number): Step => ({ op: "advance", frames });
const rd = (name: string, off: number, size: 1 | 2 | 4 = 1): Step => ({ op: "read", name, addr: DEBUG_ADDR + off, size });
const shot = (n: string): Step => ({ op: "screenshot", path: `${SHOTS}/${n}.ppm` });

async function run(steps: Step[]): Promise<Record<string, number>> {
  const scenario = ROOT + "dist/e2e-scenario.json";
  await Bun.write(scenario, JSON.stringify({ steps }));
  const out = await $`${RUNNER} ${ROM} ${scenario}`.text();
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("runner produced no JSON:\n" + out);
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error("runner error: " + JSON.stringify(parsed));
  return parsed.reads ?? {};
}

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}: got ${got}${ok ? "" : `, want ${want}`}`);
  ok ? passed++ : failed++;
}
function checkTrue(name: string, got: boolean, detail = ""): void {
  console.log(`  ${got ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${detail ? `: ${detail}` : ""}`);
  got ? passed++ : failed++;
}

// title menu: boot -> Play (A) or a chapter pick
const boot: Step[] = [adv(260)];
const play: Step[] = [...boot, A(), adv(40)];
const chapter = (page2: boolean, index: number): Step[] => {
  const s: Step[] = [...boot, DOWN, A(), adv(10)];
  const downs = page2 ? 4 : index;
  for (let i = 0; i < downs; i++) s.push(DOWN);
  s.push(A(), adv(10));
  if (page2) {
    for (let i = 0; i < index; i++) s.push(DOWN);
    s.push(A(), adv(10));
  }
  s.push(adv(60));
  return s;
};

async function main(): Promise<void> {
  console.log("Building REALITY DISTORTION...");
  const film = await compileFilm(ROOT + "game/reality-distortion.ts");
  const rom = await buildRom(emitGenData(film), ROM, "REALDISTORT");
  await $`mkdir -p ${SHOTS}`.quiet();
  console.log(`ROM: ${rom.size} bytes, ${film.scenes.length} scenes, ${film.debug.texts.length} texts\n`);

  const sc = film.debug.sceneIds;
  const varAddr = (name: string): number => {
    const idx = film.debug.vars[name];
    if (idx === undefined) throw new Error("unknown var " + name);
    return DBG.VARS + idx * 2;
  };
  const tid = (s: string): number => {
    const i = film.debug.texts.indexOf(s);
    if (i < 0) throw new Error("text not found: " + s);
    return i;
  };

  console.log("Scenario 1 — boot, title menu, workbench world + gate");
  {
    const r = await run([
      adv(80),
      rd("magic", DBG.MAGIC, 4),
      rd("booted", DBG.BOOTED),
      rd("scene0", DBG.SCENE),
      adv(180),
      rd("menu_wait", DBG.WAITING),
      shot("rd_title"),
      A(), // Play
      adv(120),
      rd("scene1", DBG.SCENE),
      rd("kind1", DBG.KIND),
      rd("waiting_world", DBG.WAITING),
      rd("cx0", DBG.PLAYER_CX),
      rd("cy0", DBG.PLAYER_CY),
      shot("rd_garage62"),
      // try to leave without the bench: down-left to the door
      hold("LEFT", 80),
      hold("DOWN", 60),
      adv(30), // gate dialog appears (DAD: not yet)
      rd("gate_dialog", DBG.WAITING),
      A(),
      adv(20),
      // now do it right: to the dad, then the bench
      hold("UP", 20),
      hold("RIGHT", 20),
      hold("UP", 40), // ends around (3..4, 8) area facing up
      adv(10),
      // walk to a bench-facing cell: left along row 8
      hold("LEFT", 60),
      hold("UP", 20),
      A(), // bench caption
      adv(60),
      rd("bench_wait", DBG.WAITING),
      A(), // dismiss caption -> dad dialogs
      adv(60),
      A(),
      adv(60),
      A(),
      adv(20),
      rd("back_world", DBG.WAITING),
      shot("rd_bench"),
      // leave through the door (bottom-left)
      hold("DOWN", 80),
      hold("LEFT", 80),
      hold("DOWN", 40),
      adv(80),
      rd("scene2", DBG.SCENE),
    ]);
    check("debug magic 'SAGA'", r.magic >>> 0, DBG_MAGIC);
    check("booted", r.booted, 1);
    check("boots into title", r.scene0, sc.title);
    check("title menu is a choice", r.menu_wait, WAITING.CHOICE);
    check("Play -> workbench", r.scene1, sc.garage62);
    check("workbench is a WORLD scene", r.kind1, SCENE_WORLD);
    check("roaming", r.waiting_world, WAITING.WORLD);
    check("kid starts at cx=10", r.cx0, 10);
    check("kid starts at cy=9", r.cy0, 9);
    check("door is gated (dad speaks)", r.gate_dialog, WAITING.DIALOG);
    check("bench caption waits for A", r.bench_wait, WAITING.A);
    check("bench cue returns to roam", r.back_world, WAITING.WORLD);
    check("door now exits to the call", r.scene2, sc.hewlett);
  }

  console.log("Scenario 2 — chapter: Breakout night at Atari");
  {
    const r = await run([
      ...chapter(false, 3),
      rd("scene", DBG.SCENE),
      adv(120),
      A(), // boss dialog
      adv(60),
      A(), // woz dialog
      adv(60),
      A(), // instructions caption
      adv(30),
      rd("mini_wait", DBG.WAITING),
      rd("bricks0", DBG.BRICKS),
      shot("rd_breakout"),
      A(), // launch
      adv(600),
      rd("bricks_mid", DBG.BRICKS),
      adv(3200), // budget expires
      rd("after", DBG.WAITING),
      rd("cleared", varAddr("bricks"), 2),
    ]);
    check("chapter menu -> atari", r.scene, sc.atari);
    check("breakout running", r.mini_wait, WAITING.MINIGAME);
    check("4 rows x 12 bricks", r.bricks0, 48);
    checkTrue("bricks fell", r.bricks_mid < 48, `bricks_mid=${r.bricks_mid}`);
    checkTrue("night ended", r.after !== WAITING.MINIGAME, `waiting=${r.after}`);
    checkTrue("cleared recorded", r.cleared >= 1, `cleared=${r.cleared}`);
  }

  console.log("Scenario 3 — chapter: Sugared Water conviction battle");
  {
    const r = await run([
      ...chapter(true, 2),
      rd("scene", DBG.SCENE),
      adv(160),
      A(), // "penthouse" caption
      adv(90),
      A(), // Sculley opener
      adv(40),
      rd("battle_wait", DBG.WAITING),
      rd("conv0", varAddr("conv"), 2),
      shot("rd_sculley"),
      // Paint the future x3 (2 -> 4 -> 6), then The question
      DOWN, A(), adv(80), A(), adv(30),
      DOWN, A(), adv(80), A(), adv(60), A(), adv(30),
      rd("conv_mid", varAddr("conv"), 2),
      DOWN, DOWN, A(), adv(80), A(), adv(60), A(), adv(60), A(), adv(30),
      rd("conv_end", varAddr("conv"), 2),
      adv(60),
      A(), // "..."
      adv(40),
      A(), // dangerous
      adv(240), // chip + white fade out
      rd("scene_after", DBG.SCENE),
    ]);
    check("chapter menu -> sculley", r.scene, sc.sculley);
    check("battle is a choice loop", r.battle_wait, WAITING.CHOICE);
    check("conviction starts at 2", r.conv0, 2);
    checkTrue("future pitches build conviction", r.conv_mid >= 4, `conv=${r.conv_mid}`);
    check("the question lands at 8", r.conv_end, 8);
    check("white fade chains into bandley", r.scene_after, sc.bandley);
  }

  console.log("Scenario 4 — Bandley 3 world -> Flint Center: the Mac speaks");
  {
    const r = await run([
      ...chapter(true, 3),
      rd("scene", DBG.SCENE),
      rd("kind", DBG.KIND),
      adv(30),
      // to the mac desk: up to row 7, right until the desk stops us
      hold("UP", 40),
      hold("RIGHT", 80),
      adv(10),
      A(), // prototype caption
      adv(70),
      A(), // dismiss caption -> dialog starts typing
      adv(60),
      A(), // dismiss "Apple II is the past"
      adv(20),
      shot("rd_bandley"),
      // to the door: left along row 7, up to row 5, right to the door column, up
      hold("LEFT", 100),
      hold("UP", 8), // exactly one step up, onto row 5 (row 4 has a plant)
      hold("RIGHT", 60),
      hold("UP", 20),
      adv(80),
      rd("scene_keynote", DBG.SCENE),
      rd("kind_keynote", DBG.KIND),
      adv(200),
      A(), // "January 24" caption
      adv(60),
      A(), // bow tie caption
      adv(60),
      A(6), A(6), A(6), A(6), A(6), A(6), A(6), A(6), A(6), A(6),
      A(6), A(6), A(6), A(6), A(6), A(6), A(6), // applause mash (15 + spares)
      adv(60),
      A(), // canvas bag caption
      adv(120),
      A(), // chariots caption
      adv(60),
      A(), // hello I am macintosh
      adv(60),
      A(), // out of that bag
      adv(60),
      rd("mac_line", DBG.CUR_TEXT, 2),
      shot("rd_keynote"),
      A(), // never trust
      adv(80),
      A(), A(6),
      adv(60),
      A(),
      adv(60),
      A(), // steve jobs!
      adv(120),
      A(), // thunder caption
      adv(60),
      A(), // tears caption
      adv(300), // zoom + white fade
      rd("scene_credits", DBG.SCENE),
    ]);
    check("chapter menu -> bandley", r.scene, sc.bandley);
    check("bandley is a WORLD scene", r.kind, SCENE_WORLD);
    check("door exits into the keynote", r.scene_keynote, sc.keynote);
    check("keynote is cinematic", r.kind_keynote, SCENE_CINE);
    check(
      "the Mac's documented line is on deck",
      r.mac_line,
      tid("Never trust a computer\nthat you can't lift!") + 1,
    );
    check("white-out chains into credits", r.scene_credits, sc.credits);
  }

  console.log("Scenario 5 — credits loop back to the title");
  {
    const r = await run([
      ...chapter(true, 3),
      // skip through bandley quickly: mac desk then door (same route)
      hold("UP", 40),
      hold("RIGHT", 80),
      adv(10),
      A(), adv(70), A(), adv(60), A(), adv(20),
      hold("LEFT", 100),
      hold("UP", 8), // exactly one step up, onto row 5 (row 4 has a plant)
      hold("RIGHT", 60),
      hold("UP", 20),
      adv(280),
      A(), adv(60), A(), adv(60),
      A(6), A(6), A(6), A(6), A(6), A(6), A(6), A(6), A(6), A(6),
      A(6), A(6), A(6), A(6), A(6), A(6), A(6),
      adv(60), A(), adv(120), A(), adv(60),
      A(), adv(60), A(), adv(60), A(), adv(80), A(), A(6), adv(60), A(), adv(60), A(),
      adv(120), A(), adv(60), A(), adv(300),
      rd("scene_credits", DBG.SCENE),
      adv(1100), // credit cards tick by
      rd("back_title", DBG.SCENE),
      rd("menu_again", DBG.WAITING),
      shot("rd_credits_loop"),
    ]);
    check("reached credits", r.scene_credits, sc.credits);
    check("credits loop to the title", r.back_title, sc.title);
    checkTrue(
      "title menu is live again",
      r.menu_again === WAITING.CHOICE || r.menu_again === WAITING.BUSY,
      `waiting=${r.menu_again}`,
    );
  }

  console.log("Scenario 6 — Fifty Boards: woz branch-talk, supplier meter battle, delivery");
  {
    const r = await run([
      ...chapter(true, 0),
      rd("scene", DBG.SCENE),
      adv(60), A(), adv(60), A(), adv(60), A(), adv(30), // intro captions
      rd("roam", DBG.WAITING),
      // woz stands at (3,7): up to the walkway, left until he blocks us
      hold("UP", 24),
      hold("LEFT", 80),
      A(), // talk (his cue starts with an if — the blob-absolute jump test)
      adv(70),
      rd("woz_dialog", DBG.WAITING),
      A(), // dismiss line 1
      adv(60),
      A(), // dismiss line 2
      adv(20),
      rd("woz_done", DBG.WAITING),
      // phone on the wall at (7,3..5): right to (7,7), up to (7,6), face up
      hold("RIGHT", 24),
      hold("UP", 8),
      hold("UP", 6),
      A(), // examine -> parts man caption
      adv(70),
      A(), // dismiss -> encounter opens
      adv(40),
      rd("battle", DBG.WAITING),
      shot("rd_supplier"),
      A(), // Mention the order
      adv(70), A(), adv(60), A(), adv(30),
      rd("trust1", varAddr("trust"), 2),
      DOWN, A(), // Promise net thirty
      adv(70), A(), adv(30),
      DOWN, A(), // and again -> trust >= 8
      adv(70), A(), adv(40),
      A(), // supplier: net thirty (closing dialog)
      adv(60), A(), adv(60), // parts-on-credit caption
      rd("credit", varAddr("credit"), 2),
      // deliver: to the door at (8..10, 5) — exactly three steps right
      hold("RIGHT", 20),
      hold("UP", 20),
      adv(140), // DAY 29 card
      A(), // apple I caption
      adv(120),
      rd("scene_after", DBG.SCENE),
    ]);
    check("chapter menu -> garage76", r.scene, sc.garage76);
    check("intro ends in roam", r.roam, WAITING.WORLD);
    check("woz talk opens (if-branch sub-cue)", r.woz_dialog, WAITING.DIALOG);
    check("woz talk returns to roam", r.woz_done, WAITING.WORLD);
    check("supplier battle is a choice loop", r.battle, WAITING.CHOICE);
    checkTrue("the order builds trust", r.trust1 >= 5, `trust=${r.trust1}`);
    check("net-thirty closes the deal", r.credit, 1);
    check("delivery chains into the faire", r.scene_after, sc.faire);
  }

  console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
