// aot/test/e2e.ts — end-to-end test: build the demo ROM, drive it headlessly in
// mGBA (via the libmgba runner), and assert real game state (player position,
// map, flags, dialogue) after scripted input. This is the "runs on GBA" proof.
//
//   bun aot/test/e2e.ts

import { $ } from "bun";
import { compile, debugInfo } from "../compiler/index.ts";
import { buildRom } from "../compiler/rom.ts";
import { DBG, DEBUG_ADDR } from "../spec/pjgb.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const RUNNER = ROOT + "aot/test/harness/mgba_runner";
const ROM = ROOT + "aot/dist/pocket-town.gba";
const SHOTS = ROOT + "aot/dist/shots";

const addr = (field: keyof typeof DBG): number => DEBUG_ADDR + DBG[field];

type Step =
  | { op: "advance"; frames: number }
  | { op: "press"; buttons: string[]; frames: number; release?: number }
  | { op: "read"; name: string; addr: number; size: 1 | 2 | 4 }
  | { op: "screenshot"; path: string };

async function run(steps: Step[]): Promise<Record<string, number>> {
  const scenario = ROOT + `aot/dist/scenario.json`;
  await Bun.write(scenario, JSON.stringify({ steps }));
  const out = await $`${RUNNER} ${ROM} ${scenario}`.text();
  const line = out
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("runner produced no JSON:\n" + out);
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error("runner error: " + JSON.stringify(parsed));
  return parsed.reads ?? {};
}

// --- assertions -------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}: got ${got}${ok ? "" : `, want ${want}`}`);
  ok ? passed++ : failed++;
}

const R = { X: addr("PLAYER_X"), Y: addr("PLAYER_Y"), DIR: addr("PLAYER_DIR"), MAP: addr("CUR_MAP"), TEXT: addr("TEXT_ACTIVE"), SCRIPT: addr("SCRIPT_ACTIVE"), CUR: addr("CUR_TEXT"), BOOT: addr("BOOTED") };
const rd = (name: string, a: number, size: 1 | 2 | 4): Step => ({ op: "read", name, addr: a, size });
const press = (b: string, frames: number, release = 4): Step => ({ op: "press", buttons: [b], frames, release });
const shot = (n: string): Step => ({ op: "screenshot", path: `${SHOTS}/${n}.ppm` });

async function main(): Promise<void> {
  console.log("Building demo ROM...");
  const built = await compile(ROOT + "aot/demo/game.tsx");
  const di = debugInfo(built) as { flags: Record<string, { byteAddr: number; bit: number }>; texts: string[]; maps: Record<string, number> };
  const rom = await buildRom(built.blob, ROM);
  await $`mkdir -p ${SHOTS}`.quiet();
  console.log(`ROM: ${rom.size} bytes\n`);

  const tid = (s: string): number => {
    const i = di.texts.indexOf(s);
    if (i < 0) throw new Error("text not found: " + s);
    return i;
  };
  const flagBeat = di.flags["beat_rival_1"];

  // === Scenario 1: boot ===
  console.log("Scenario 1 — boot & spawn");
  {
    const r = await run([{ op: "advance", frames: 15 }, rd("boot", R.BOOT, 1), rd("x", R.X, 2), rd("y", R.Y, 2), rd("map", R.MAP, 1), shot("01_boot")]);
    check("booted", r.boot, 1);
    check("spawn x", r.x, built.model.start.x);
    check("spawn y", r.y, built.model.start.y);
    check("start map", r.map, 0);
  }

  // === Scenario 2: walk to rival, dialogue, choose Battle, flag + item ===
  console.log("Scenario 2 — talk to rival, choose Battle, win, flag set");
  {
    const r = await run([
      { op: "advance", frames: 10 },
      press("RIGHT", 8), // -> (11,14)
      press("UP", 20), //   -> (11,9)
      press("RIGHT", 4), // face the rival (blocked, SOLID)
      rd("faceDir", R.DIR, 1),
      rd("faceX", R.X, 2),
      press("A", 1, 8), // interact -> "You made it!"
      rd("d1_script", R.SCRIPT, 1),
      rd("d1_text", R.TEXT, 1),
      rd("d1_cur", R.CUR, 2),
      shot("02_dialogue"),
      press("A", 1, 8), // dismiss -> choice menu
      rd("choice_script", R.SCRIPT, 1),
      rd("choice_text", R.TEXT, 1),
      shot("03_choice"),
      press("A", 1, 20), // pick Battle -> battle, setFlag, giveItem, "Take this Potion"
      rd("won_flag", flagBeat.byteAddr, 1),
      rd("won_cur", R.CUR, 2),
      rd("won_text", R.TEXT, 1),
      shot("04_reward"),
      press("A", 1, 12), // dismiss -> END
      rd("end_script", R.SCRIPT, 1),
      rd("end_text", R.TEXT, 1),
    ]);
    check("faces right at rival", r.faceDir, 3);
    check("blocked (x stays 11)", r.faceX, 11);
    check("dialogue: script active", r.d1_script, 1);
    check("dialogue: textbox up", r.d1_text, 1);
    check('dialogue: shows "You made it!"', r.d1_cur, tid("You made it! Want to test your first build?"));
    check("choice: script still active", r.choice_script, 1);
    check("choice: textbox flag cleared", r.choice_text, 0);
    check("Battle set beat_rival_1", (r.won_flag >> flagBeat.bit) & 1, 1);
    check('reward shows "Take this Potion"', r.won_cur, tid("Take this Potion. You will need it."));
    check("script ends after reward", r.end_script, 0);
    check("textbox closed at end", r.end_text, 0);
  }

  // === Scenario 3: warp town -> route101 ===
  console.log("Scenario 3 — warp from Littleroot to Route 101");
  {
    const r = await run([
      { op: "advance", frames: 10 },
      press("DOWN", 16), // (9,14) -> warp tile (9,17) -> route101
      rd("map", R.MAP, 1),
      rd("x", R.X, 2),
      shot("05_route"),
    ]);
    check("warped to route101 (map 1)", r.map, di.maps["route101"]);
    check("entered near entrance x", r.x, 9);
  }

  console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
