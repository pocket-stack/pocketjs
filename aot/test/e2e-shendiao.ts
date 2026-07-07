// aot/test/e2e-shendiao.ts — full-story E2E for the 神雕旧事 demo: one long
// session per target that plays ALL THREE segments back to back through the
// title menu (segment 1 exploration+item, segment 2 dialogue+choice+jump,
// segment 3 the 7-turn boss battle), then checks the epilogue unlock.
//
//   bun aot/test/e2e-shendiao.ts            # gba + gb + nes
//   bun aot/test/e2e-shendiao.ts gb         # subset

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

async function testTarget(target: TargetName): Promise<void> {
  console.log(`\n=== ${target.toUpperCase()} — 神雕旧事 ===`);
  const built: CompileOutput = await compile(ROOT + "aot/demo-shendiao/game.tsx", target);
  const rom = ROOT + `aot/dist/shendiao${TARGETS[target].ext}`;
  await buildTarget(built, rom);
  const di = debugInfo(built) as {
    debugAddr: number;
    flags: Record<string, { byteAddr: number; bit: number }>;
    texts: string[];
    maps: Record<string, number>;
  };
  await $`mkdir -p ${SHOTS}`.quiet();

  const addr = (f: keyof typeof DBG): number => di.debugAddr + DBG[f];
  const R = {
    X: addr("PLAYER_X"),
    Y: addr("PLAYER_Y"),
    MAP: addr("CUR_MAP"),
    TEXT: addr("TEXT_ACTIVE"),
    SCRIPT: addr("SCRIPT_ACTIVE"),
    CUR: addr("CUR_TEXT"),
    BOOT: addr("BOOTED"),
  };
  const rd = (name: string, a: number, size: 1 | 2 | 4): Step => ({ op: "read", name, addr: a, size });
  const press = (b: string, frames: number, release = 6): Step => ({ op: "press", buttons: [b], frames, release });
  const shot = (n: string): Step => ({ op: "screenshot", path: `${SHOTS}/sd_${target}_${n}.ppm` });

  const pageIds = (s: string): number[] =>
    wrapPages(s, TARGETS[target]).map((p) => {
      const i = di.texts.indexOf(p);
      if (i < 0) throw new Error(`page not in text bank: ${JSON.stringify(p)} (of ${JSON.stringify(s)})`);
      return i;
    });
  /** One A per page of each text, in order. */
  const dismiss = (...textsToClear: string[]): Step[] =>
    textsToClear.flatMap((s) => pageIds(s).map(() => press("A", 1, 12)));
  /** Move the choice cursor to `idx` and confirm. */
  const pick = (idx: number): Step[] => [
    ...Array.from({ length: idx }, () => press("DOWN", 1, 6)),
    press("A", 1, 14),
  ];
  const walk = (dir: string, tiles: number): Step => press(dir, tiles * 4, 6);
  const face = (dir: string): Step => press(dir, 2, 6);

  const steps: Step[] = [];
  const F = di.flags;

  // ---- boot: title menu auto-opens (map onEnter) ----
  steps.push({ op: "advance", frames: 60 });
  steps.push(rd("boot", R.BOOT, 1), rd("m0", R.MAP, 1), rd("t0", R.TEXT, 1), rd("cur0", R.CUR, 2));
  steps.push(shot("01_title"));

  // =====================================================================
  // Segment 1 — 剑冢神雕 (menu option 0)
  // =====================================================================
  steps.push(...dismiss("神雕旧事，三段可看。"));
  steps.push(...pick(0));
  steps.push(...dismiss("断臂之痛，深谷之中。"));
  steps.push(rd("s1_map", R.MAP, 1), rd("s1_x", R.X, 2), rd("s1_y", R.Y, 2));

  // condor phase 1 (snake gall): spawn (13,12) -> (13,10), face right at (14,10)
  steps.push(walk("UP", 2), face("RIGHT"), press("A", 1, 12));
  steps.push(...dismiss("雕：……！", "神雕飞来，放下蛇胆。", "杨过：多谢雕兄！", "雕兄看了看石门。"));
  steps.push(rd("gall", F.s1_gall.byteAddr, 1));

  // to the tomb door: (13,10) UP4 -> (13,6), RIGHT3 -> (16,6), UP5 -> (16,1)
  steps.push(walk("UP", 4), walk("RIGHT", 3), walk("UP", 5), face("UP"), press("A", 1, 12));
  steps.push(...dismiss("石门之后，正是剑冢。"));
  steps.push(rd("tomb_map", R.MAP, 1));
  steps.push(shot("02_tomb"));

  // heavy sword mound: tomb spawn (9,8) UP5 -> (9,3), RIGHT3 -> (12,3), face mound (12,2)
  steps.push(walk("UP", 5), walk("RIGHT", 3), face("UP"), press("A", 1, 12));
  steps.push(...dismiss("黑铁大剑，重不可当。"));
  steps.push(...pick(0)); // 拔剑
  steps.push(...dismiss("杨过运力，重剑离石！", "杨过：好剑，好重的剑！"));
  steps.push(rd("sword", F.s1_sword.byteAddr, 1));
  steps.push(shot("03_sword"));

  // back out: (12,3) LEFT3, DOWN5, face door (9,9)
  steps.push(walk("LEFT", 3), walk("DOWN", 5), face("DOWN"), press("A", 1, 16));
  steps.push(rd("valley_map", R.MAP, 1));

  // to the condor: door_front (16,1) DOWN5 -> (16,6), LEFT3 -> (13,6), DOWN4 -> (13,10), face right
  steps.push(walk("DOWN", 5), walk("LEFT", 3), walk("DOWN", 4), face("RIGHT"), press("A", 1, 12));
  steps.push(...dismiss("雕：……！", "神雕跃入山洪之中。", "杨过：要我在洪水中练剑？"));
  // torrent training: 挥剑 x3
  steps.push(...pick(0), ...dismiss("水势如山，剑要脱手。"));
  steps.push(...pick(0), ...dismiss("双足生根，剑势渐定。"));
  steps.push(...pick(0), ...dismiss("一剑挥出，山洪为之分开！"));
  steps.push(...dismiss("杨过：剑重如山，心定如铁。", "从此江湖，有一神雕侠。", "剑冢神雕，到此为止。"));
  steps.push({ op: "advance", frames: 30 });
  steps.push(rd("s1_done", F.s1_done.byteAddr, 1), rd("back1_map", R.MAP, 1), rd("menu1", R.TEXT, 1));

  // =====================================================================
  // Segment 2 — 断肠之约 (menu option 1)
  // =====================================================================
  steps.push(...dismiss("神雕旧事，三段可看。"));
  steps.push(...pick(1));
  steps.push(...dismiss("十六年后，断肠崖前。", "杨过：龙儿，我来了。"));
  steps.push(rd("s2_map", R.MAP, 1));

  // cliff spawn (8,1) DOWN8 -> (8,9), face the edge (8,10)
  steps.push(walk("DOWN", 8), face("DOWN"), press("A", 1, 12));
  steps.push(...dismiss("崖下深谷，深不见底。", "日出日落，无人前来。"));
  steps.push(shot("04_cliff"));
  steps.push(...pick(2)); // 纵身一跃
  steps.push(...dismiss("杨过：问世间，情是何物！", "龙儿不来，我何必独活！", "纵身一跃，直坠深谷。", "谷底寒潭，白花满谷。", "潭边有人，一身白衣。"));
  steps.push(rd("pool_map", R.MAP, 1));

  // pool spawn (9,2) RIGHT4 -> (13,2), DOWN2 -> (13,4), face 小龙女 (13,5)
  steps.push(walk("RIGHT", 4), walk("DOWN", 2), face("DOWN"), press("A", 1, 12));
  steps.push(...dismiss("小龙女：过儿。", "杨过：龙儿！真的是你！", "小龙女：我等了你十六年。", "小龙女：寒潭之下，", "我用古墓功法活了下来。", "杨过：我以为今生，再见不到你。", "小龙女：过儿，你可恨我？"));
  steps.push(shot("05_reunion"));
  steps.push(...pick(0)); // 不恨
  steps.push(...dismiss("杨过：不恨。你在，就好。", "小龙女：此后生死，再不分离。", "杨过：好。回古墓，回家去。", "断肠之约，到此为止。"));
  steps.push({ op: "advance", frames: 30 });
  steps.push(rd("s2_done", F.s2_done.byteAddr, 1), rd("back2_map", R.MAP, 1));

  // =====================================================================
  // Segment 3 — 襄阳大战 (menu option 2)
  // =====================================================================
  steps.push(...dismiss("神雕旧事，三段可看。"));
  steps.push(...pick(2));
  steps.push(...dismiss("蒙古大军，围困襄阳。", "高台烈火，郭襄在上。", "杨过：襄儿，我来了！"));
  steps.push(rd("s3_map", R.MAP, 1));
  steps.push(shot("06_xiangyang"));

  // spawn (12,3) DOWN4 -> (12,7), RIGHT2 -> (14,7), face 法王 (15,7)
  steps.push(walk("DOWN", 4), walk("RIGHT", 2), face("RIGHT"), press("A", 1, 12));
  steps.push(...dismiss("法王：杨过！十六年不见，", "今日再分高下！", "杨过：放了襄儿，再分高下！", "重掌要气，调息回气。"));

  const ZH_HIT = ["黯然销魂，一掌击出！", "法王中掌，连退三步！"];
  const JIAN = ["重剑一挥，势如山洪！"];
  const XI = ["杨过调息，气力渐回。"];
  const E_WHEEL = ["法王：金轮，去！", "金轮飞来，火光四起！"];
  const E_DRAGON = ["法王：龙象神功！", "力大如山，杨过连退三步！"];
  const turn = (idx: number, ...texts: string[]): void => {
    steps.push(...pick(idx), ...dismiss(...texts));
  };
  // The deterministic winning line (fw: 60→44→35→26→26→10→1→-8):
  turn(0, ...ZH_HIT, ...E_WHEEL); // T1 掌
  turn(1, ...JIAN, ...E_WHEEL); // T2 剑
  turn(1, ...JIAN, ...E_DRAGON); // T3 剑 (enemy 3rd turn)
  turn(2, ...XI, ...E_WHEEL); // T4 息
  turn(0, ...ZH_HIT, "法王气息渐乱！", ...E_WHEEL); // T5 掌 (low-HP telegraph)
  turn(1, ...JIAN, ...E_DRAGON); // T6 剑
  steps.push(...pick(1)); // T7 剑 — the finishing blow
  steps.push(shot("07_battle"));
  steps.push(
    ...dismiss(
      "重剑一挥，势如山洪！",
      "黯然销魂掌，天下无双！",
      "法王：好掌法……我败了。",
      "法王坠地，高台火起！",
      "杨过飞身上台，救下郭襄。",
      "郭襄：我就知道，大哥哥会来！",
      "军前一人，正是大汗蒙哥。",
      "杨过飞起一石，正中大汗！",
      "大汗坠马，蒙古退兵！",
      "郭靖：为国为民，才是真大侠。",
      "杨过：有郭伯伯在，襄阳不亡。",
      "襄阳大战，到此为止。",
    ),
  );
  steps.push({ op: "advance", frames: 30 });
  steps.push(rd("s3_done", F.s3_done.byteAddr, 1), rd("back3_map", R.MAP, 1));

  // ---- epilogue unlock: all three done -> the farewell lines ----
  steps.push(rd("epi_text", R.TEXT, 1), rd("epi_cur", R.CUR, 2));
  steps.push(shot("08_epilogue"));

  // ---- run ----
  const scenario = ROOT + `aot/dist/sd-scenario-${target}.json`;
  await Bun.write(scenario, JSON.stringify({ steps }));
  const r = await runScenario(target, rom, scenario);

  const M = di.maps;
  const bit = (v: number, f: { bit: number }): number => (v >> f.bit) & 1;
  check("booted", r.boot, 1);
  check("boot map = title", r.m0, M.title);
  check("title menu auto-opened", r.t0, 1);
  check("title greeting shown", r.cur0, pageIds("神雕旧事，三段可看。")[0]);
  check("segment 1: warped to valley", r.s1_map, M.valley);
  check("segment 1: spawn x", r.s1_x, 13);
  check("segment 1: spawn y", r.s1_y, 12);
  check("segment 1: got snake gall (s1_gall)", bit(r.gall, F.s1_gall), 1);
  check("segment 1: entered the tomb", r.tomb_map, M.tomb);
  check("segment 1: pulled the heavy sword (s1_sword)", bit(r.sword, F.s1_sword), 1);
  check("segment 1: back to valley", r.valley_map, M.valley);
  check("segment 1: completed (s1_done)", bit(r.s1_done, F.s1_done), 1);
  check("segment 1: returned to title", r.back1_map, M.title);
  check("title menu reopened", r.menu1, 1);
  check("segment 2: warped to cliff", r.s2_map, M.cliff);
  check("segment 2: the leap reached the pool", r.pool_map, M.pool);
  check("segment 2: completed (s2_done)", bit(r.s2_done, F.s2_done), 1);
  check("segment 2: returned to title", r.back2_map, M.title);
  check("segment 3: warped to xiangyang", r.s3_map, M.xiangyang);
  check("segment 3: battle won (s3_done)", bit(r.s3_done, F.s3_done), 1);
  check("segment 3: returned to title", r.back3_map, M.title);
  check("epilogue textbox up", r.epi_text, 1);
  check("epilogue first line", r.epi_cur, pageIds("三段旧事，到此为止。")[0]);
}

const args = process.argv.slice(2) as TargetName[];
const targets: TargetName[] = args.length ? args : (["gba", "gb", "nes"] as TargetName[]);
for (const target of targets) {
  await testTarget(target);
}
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
