// aot/test/e2e-multi.ts — the cross-target contract suite: build the SAME
// game (demo/game.tsx) for each requested target and drive the SAME logical
// scenarios through each platform's headless emulator (mGBA for gba/gb,
// jsnes for nes). Identical debug-block layout on every target makes the
// assertions portable; only text pagination differs (computed per target).
//
//   bun aot/test/e2e-multi.ts            # all built targets
//   bun aot/test/e2e-multi.ts gb nes     # subset

import { $ } from "bun";
import { compile, debugInfo, type CompileOutput } from "../compiler/index.ts";
import { buildTarget } from "../compiler/targets/index.ts";
import { wrapPages } from "../compiler/text.ts";
import { runScenario } from "./harness/run_scenario.ts";
import { DBG, TARGETS, type TargetName } from "../spec/pjgb.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const SHOTS = ROOT + "aot/dist/shots";

type Step =
  | { op: "advance"; frames: number }
  | { op: "press"; buttons: string[]; frames: number; release?: number }
  | { op: "read"; name: string; addr: number; size: 1 | 2 | 4 }
  | { op: "screenshot"; path: string };

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}: got ${got}${ok ? "" : `, want ${want}`}`);
  ok ? passed++ : failed++;
}

interface TargetCtx {
  target: TargetName;
  rom: string;
  built: CompileOutput;
  di: {
    debugAddr: number;
    flags: Record<string, { byteAddr: number; bit: number }>;
    texts: string[];
    maps: Record<string, number>;
  };
}

async function run(t: TargetCtx, steps: Step[]): Promise<Record<string, number>> {
  const scenario = ROOT + `aot/dist/scenario-${t.target}.json`;
  await Bun.write(scenario, JSON.stringify({ steps }));
  return runScenario(t.target, t.rom, scenario);
}

async function testTarget(target: TargetName): Promise<void> {
  console.log(`\n=== ${target.toUpperCase()} ===`);
  const built = await compile(ROOT + "aot/demo/game.tsx", target);
  const rom = ROOT + `aot/dist/pocket-town${TARGETS[target].ext}`;
  await buildTarget(built, rom);
  const di = debugInfo(built) as TargetCtx["di"];
  const t: TargetCtx = { target, rom, built, di };
  await $`mkdir -p ${SHOTS}`.quiet();

  const addr = (field: keyof typeof DBG): number => di.debugAddr + DBG[field];
  const R = {
    X: addr("PLAYER_X"),
    Y: addr("PLAYER_Y"),
    DIR: addr("PLAYER_DIR"),
    MAP: addr("CUR_MAP"),
    TEXT: addr("TEXT_ACTIVE"),
    SCRIPT: addr("SCRIPT_ACTIVE"),
    CUR: addr("CUR_TEXT"),
    BOOT: addr("BOOTED"),
  };
  const rd = (name: string, a: number, size: 1 | 2 | 4): Step => ({ op: "read", name, addr: a, size });
  const press = (b: string, frames: number, release = 4): Step => ({ op: "press", buttons: [b], frames, release });
  const shot = (n: string): Step => ({ op: "screenshot", path: `${SHOTS}/${target}_${n}.ppm` });

  // Per-target pagination of a logical text; returns page text ids.
  const pageIds = (s: string): number[] => {
    const pages = built.mode === "cjk16" ? wrapPages(s, TARGETS[target]) : [s];
    return pages.map((p) => {
      const i = di.texts.indexOf(p);
      if (i < 0) throw new Error(`page not found in text bank: ${JSON.stringify(p)}`);
      return i;
    });
  };
  // A presses that dismiss all pages of a text.
  const dismiss = (s: string): Step[] => pageIds(s).map(() => press("A", 1, 10));

  const HELLO = "You made it! Want to test your first build?";
  const REWARD = "Take this Potion. You will need it.";
  const AGAIN = "The road ahead is tougher than it looks.";
  const flagBeat = di.flags["beat_rival_1"];

  console.log("boot & spawn");
  {
    const r = await run(t, [
      { op: "advance", frames: 30 },
      rd("boot", R.BOOT, 1),
      rd("x", R.X, 2),
      rd("y", R.Y, 2),
      rd("map", R.MAP, 1),
      shot("01_boot"),
    ]);
    check("booted", r.boot, 1);
    check("spawn x", r.x, built.model.start.x);
    check("spawn y", r.y, built.model.start.y);
    check("start map", r.map, 0);
  }

  console.log("rival: dialogue, choice, battle flag, re-talk branch");
  {
    const r = await run(t, [
      { op: "advance", frames: 30 },
      press("RIGHT", 8),
      press("UP", 20),
      press("RIGHT", 4),
      rd("faceDir", R.DIR, 1),
      rd("faceX", R.X, 2),
      press("A", 1, 10), // open dialogue (page 1)
      rd("d1_script", R.SCRIPT, 1),
      rd("d1_text", R.TEXT, 1),
      rd("d1_cur", R.CUR, 2),
      shot("02_dialogue"),
      ...dismiss(HELLO), // one A per page -> choice menu
      rd("choice_script", R.SCRIPT, 1),
      rd("choice_text", R.TEXT, 1),
      shot("03_choice"),
      press("A", 1, 20), // pick "Battle"
      rd("won_flag", flagBeat.byteAddr, 1),
      rd("won_cur", R.CUR, 2),
      shot("04_reward"),
      ...dismiss(REWARD),
      rd("end_script", R.SCRIPT, 1),
      rd("end_text", R.TEXT, 1),
      press("A", 1, 10), // talk again -> flag branch
      rd("again_cur", R.CUR, 2),
      rd("again_text", R.TEXT, 1),
    ]);
    check("faces right at rival", r.faceDir, 3);
    check("blocked by rival (x stays 11)", r.faceX, 11);
    check("dialogue: script active", r.d1_script, 1);
    check("dialogue: textbox up", r.d1_text, 1);
    check("dialogue shows page 1", r.d1_cur, pageIds(HELLO)[0]);
    check("choice: script still active", r.choice_script, 1);
    check("Battle set beat_rival_1", (r.won_flag >> flagBeat.bit) & 1, 1);
    check("reward text shown", r.won_cur, pageIds(REWARD)[0]);
    check("script ends after reward", r.end_script, 0);
    check("textbox closed at end", r.end_text, 0);
    check("re-talk shows flag branch", r.again_cur, pageIds(AGAIN)[0]);
    check("re-talk textbox up", r.again_text, 1);
  }

  console.log("warp to route101");
  {
    const r = await run(t, [
      { op: "advance", frames: 30 },
      press("DOWN", 16, 8),
      rd("map", R.MAP, 1),
      rd("x", R.X, 2),
      shot("05_route"),
    ]);
    check("warped to route101", r.map, di.maps["route101"]);
    check("entrance x", r.x, 9);
  }
}

const args = process.argv.slice(2) as TargetName[];
const targets: TargetName[] = args.length ? args : (["gba", "gb"] as TargetName[]);
for (const target of targets) {
  await testTarget(target);
}
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
