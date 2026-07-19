#!/usr/bin/env bun
// static/games/boardroom/test/e2e.ts — the full BOARDROOM playthrough on
// every console.
//
// The reference VM is the story oracle: one persistent RefVM plays the whole
// beat list (scripts in encounter order, flags/vars/RNG carried across), and
// its event log becomes the console input script — one A per say page,
// cursor moves + A per choice, advances for waits. If a console's debug
// block disagrees with the oracle at the checkpoints, that console is wrong.
//
//   bun static/games/boardroom/test/e2e.ts          # all targets
//   bun static/games/boardroom/test/e2e.ts gba nes  # subset

import { $ } from "bun";
import { join } from "node:path";
import { compileGame, type CompileOutput } from "../../../compiler/index.ts";
import { buildGba } from "../../../compiler/targets/gba.ts";
import { buildGb } from "../../../compiler/targets/gb.ts";
import { buildNes } from "../../../compiler/targets/nes.ts";
import { DBG, KEYS, TARGETS, dbgFlagAddr, dbgVarAddr, type KeyName, type TargetName } from "../../../spec/isa.ts";
import { RefVM } from "../../../vm/ref.ts";
import { AutoRpgHost, type RpgEvent } from "../../../vm/rpg-host.ts";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..", "..");
const DIST = join(ROOT, "dist");
const SHOTS = join(DIST, "shots");
const ENTRY = join(HERE, "..", "game.ts");
const RUNNER = join(ROOT, "test", "harness", "mgba_runner");
const NES_RUNNER = join(ROOT, "test", "harness", "nes_runner.ts");

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}: ${got}${ok ? "" : ` (want ${want})`}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------
const REVEAL = 80;

class Scenario {
  lines: string[] = [];
  advance(frames: number): this {
    this.lines.push(`A ${frames}`);
    return this;
  }
  press(keys: KeyName[], hold = 2, release = 6): this {
    const mask = keys.reduce((m, k) => m | KEYS[k], 0);
    this.lines.push(`P ${mask.toString(16)} ${hold} ${release}`);
    return this;
  }
  read(name: string, addr: number, size: 1 | 2 | 4): this {
    this.lines.push(`R ${name} 0x${addr.toString(16)} ${size}`);
    return this;
  }
  shot(path: string): this {
    this.lines.push(`S ${path}`);
    return this;
  }
  /** One grid step is 5 engine ticks; exact holds prevent overshoot. */
  walk(dir: KeyName, steps: number): this {
    return this.press([dir], steps * 5, 6);
  }
  /** Face + talk to an adjacent solid actor. */
  talk(dir: KeyName): this {
    this.press([dir], 3, 4); // blocked step just turns
    return this.press(["A"], 2, 8);
  }
  /** Replay an oracle beat's events as input. */
  beat(events: RpgEvent[]): this {
    for (const e of events) {
      if (e.kind === "say") this.advance(REVEAL).press(["A"], 2, 6);
      else if (e.kind === "choice") {
        this.advance(40);
        for (let i = 0; i < e.picked; i++) this.press(["DOWN"], 2, 4);
        this.press(["A"], 2, 8);
      } else if (e.kind === "wait") this.advance(e.frames + 8);
    }
    return this;
  }
}

async function run(target: TargetName, rom: string, sc: Scenario): Promise<Record<string, number>> {
  const file = join(DIST, `story-${target}.txt`);
  await Bun.write(file, sc.lines.join("\n") + "\n");
  const out =
    target === "nes" ? await $`bun ${NES_RUNNER} ${rom} ${file}`.text() : await $`${RUNNER} ${rom} ${file}`.text();
  const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`runner produced no JSON:\n${out}`);
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error(`runner error: ${line}`);
  return parsed.reads ?? {};
}

// ---------------------------------------------------------------------------
// The oracle: play the whole story beat list on one reference VM.
// ---------------------------------------------------------------------------
interface Beat {
  script: string;
  picks: number[];
  events: RpgEvent[];
}

function playOracle(out: CompileOutput): { beats: Record<string, RpgEvent[][]>; sigs: number; won: number } {
  const code = out.linked.blobs[out.linked.scriptBlobIndex].bytes;
  const S = out.debug.scripts;
  // Beat order mirrors the playthrough below. Choice picks are the story's
  // "canonical run": Ask why, Join MSFT, Negotiate, THE LETTER repeated.
  const plan: [string, number[]][] = [
    ["TheCall", [0]],
    ["HotelDoor", []],
    ["HqEnter", []],
    ["MiraTalk", []],
    ["AdamTalk", []],
    ["EmmettTalk", []],
    ["HqEastDoor", []],
    ["BoardroomDoor", []],
    ["HqEnter", []],
    ["MiraTalk", []],
    ["HqWestDoor", []],
    ["SatyaTalk", [0]],
    ["GregTalk", []],
    ["MsDoor", []],
    ["HqEnter", []],
    ["Emp1Talk", []],
    ["MiraTalk", []],
    ["HqEastDoor", []],
    ["IlyaTalk", []],
    ["AdamTalk", Array(40).fill(2).map((v, i) => (i === 0 ? 0 : 2))],
  ];
  const beats: Record<string, RpgEvent[][]> = {};
  let vm: RefVM | null = null;
  for (const [name, picks] of plan) {
    const host = new AutoRpgHost(picks);
    const next = new RefVM(code, out.linked.scriptTable, host);
    if (vm) {
      next.vars.set(vm.vars);
      next.flags.set(vm.flags);
      next.rng = vm.rng;
    }
    host.play(next, S[name]);
    (beats[name] ??= []).push(host.events);
    vm = next;
  }
  return {
    beats,
    sigs: vm!.getVar(out.debug.vars.sigs),
    won: vm!.getFlag(out.debug.flags.won),
  };
}

// ---------------------------------------------------------------------------
// Per-target playthrough
// ---------------------------------------------------------------------------
async function testTarget(target: TargetName): Promise<void> {
  console.log(`\n=== ${target.toUpperCase()} ===`);
  const out = await compileGame(ENTRY, target);
  const rom = join(DIST, `boardroom${TARGETS[target].ext}`);
  if (target === "gba") await buildGba(out.linked, rom);
  else if (target === "gb") await buildGb(out.linked, rom);
  else await buildNes(out.linked, rom);
  await $`mkdir -p ${SHOTS}`.quiet();

  const oracle = playOracle(out);
  const nextBeat: Record<string, number> = {};
  const beat = (name: string): RpgEvent[] => {
    const runs = oracle.beats[name];
    const i = nextBeat[name] ?? 0;
    nextBeat[name] = i + 1;
    if (!runs || !runs[i]) throw new Error(`oracle has no run ${i} for beat ${name}`);
    return runs[i];
  };

  const A = (f: keyof typeof DBG) => TARGETS[target].debugAddr + DBG[f];
  const F = (name: string) => dbgFlagAddr(target, out.debug.flags[name]);
  const { maps, vars } = out.debug;
  const shot = (n: string) => join(SHOTS, `${target}_br_${n}.ppm`);

  const sc = new Scenario();
  // --- Ch.1: the call -------------------------------------------------------
  sc.advance(30)
    .read("bootMap", A("CUR_MAP"), 1)
    .walk("LEFT", 1) // onto the laptop trigger
    .beat(beat("TheCall"))
    .advance(10)
    .read("fired", F("fired").addr, 1)
    .shot(shot("01_vegas"));
  // to the hotel door: right 4, down 3 -> trigger -> badge scene -> hq lobby
  sc.walk("RIGHT", 4).walk("DOWN", 3).beat(beat("HotelDoor")).beat(beat("HqEnter")).advance(10);
  sc.read("hqMap", A("CUR_MAP"), 1).read("hqX", A("PLAYER_X"), 2).read("hqY", A("PLAYER_Y"), 2);
  // --- Ch.2: Mira, the board, Emmett ---------------------------------------
  sc.walk("LEFT", 1).walk("UP", 1).talk("UP").beat(beat("MiraTalk")); // Mira #1
  sc.walk("DOWN", 1).walk("RIGHT", 10).beat(beat("HqEastDoor")).advance(10); // east door -> boardroom
  sc.read("brMap", A("CUR_MAP"), 1).shot(shot("02_boardroom"));
  sc.walk("UP", 5).walk("RIGHT", 3).talk("RIGHT").beat(beat("AdamTalk")); // Adam (stonewall)
  // around the table, along row 4, to Emmett (Ilya blocks row 5)
  sc.walk("LEFT", 1).walk("DOWN", 2).walk("RIGHT", 7).walk("DOWN", 1).talk("RIGHT").beat(beat("EmmettTalk"));
  sc.walk("DOWN", 2).walk("LEFT", 9).walk("LEFT", 1).beat(beat("BoardroomDoor")).beat(beat("HqEnter")).advance(10);
  sc.walk("LEFT", 9).walk("UP", 1).talk("UP").beat(beat("MiraTalk")); // Mira: the Satya call
  sc.read("msOpen", F("ms_open").addr, 1);
  // --- Ch.3: Microsoft + the letter -----------------------------------------
  sc.walk("DOWN", 1).walk("LEFT", 9).beat(beat("HqWestDoor")).advance(10); // west door
  sc.read("msMap", A("CUR_MAP"), 1);
  sc.walk("UP", 4).walk("RIGHT", 3).talk("RIGHT").beat(beat("SatyaTalk")).shot(shot("03_satya")); // Satya
  // Satya's desk blocks row 4 — go over the top to Greg, exit down the right
  sc.walk("UP", 1).walk("RIGHT", 6).walk("DOWN", 2).talk("DOWN").beat(beat("GregTalk")); // Greg
  sc.walk("RIGHT", 1).walk("DOWN", 3).walk("LEFT", 10).walk("LEFT", 1).beat(beat("MsDoor")).beat(beat("HqEnter")).advance(10);
  sc.walk("UP", 3).talk("RIGHT").beat(beat("Emp1Talk")); // employee signatures
  sc.read("sigs1", dbgVarAddr(target, vars.sigs), 2);
  sc.walk("DOWN", 2).walk("RIGHT", 8).talk("UP").beat(beat("MiraTalk")); // Mira boost
  sc.read("sigs2", dbgVarAddr(target, vars.sigs), 2);
  sc.walk("DOWN", 1).walk("RIGHT", 10).beat(beat("HqEastDoor")).advance(10); // boardroom again
  sc.walk("UP", 2).walk("RIGHT", 3).talk("RIGHT").beat(beat("IlyaTalk")).shot(shot("04_ilya")); // Ilya flips
  sc.read("sigs3", dbgVarAddr(target, vars.sigs), 2).read("full", F("letter_full").addr, 1);
  // --- Ch.4: the negotiation ------------------------------------------------
  sc.walk("LEFT", 1).walk("UP", 3).walk("RIGHT", 1).talk("RIGHT").beat(beat("AdamTalk")).shot(shot("05_end"));
  sc.advance(20)
    .read("won", F("won").addr, 1)
    .read("sigsEnd", dbgVarAddr(target, vars.sigs), 2)
    .read("endMap", A("CUR_MAP"), 1)
    .read("scriptEnd", A("SCRIPT_ACTIVE"), 1)
    .read("textEnd", A("TEXT_ACTIVE"), 1);

  const r = await run(target, rom, sc);

  check("boots in the hotel", r.bootMap, maps.hotel);
  check("ch1: fired", (r.fired >> F("fired").bit) & 1, 1);
  check("badge warp to hq", r.hqMap, maps.hq);
  check("hq lobby x", r.hqX, 10);
  check("hq lobby y", r.hqY, 6);
  check("east door to boardroom", r.brMap, maps.boardroom);
  check("mira takes the satya call", (r.msOpen >> F("ms_open").bit) & 1, 1);
  check("west door to microsoft", r.msMap, maps.msoffice);
  check("letter first batch (505)", (r.sigs1 << 16) >> 16, 505);
  check("mira boost (705)", (r.sigs2 << 16) >> 16, 705);
  check("ilya flips (743)", (r.sigs3 << 16) >> 16, oracle.sigs);
  check("letter full", (r.full >> F("letter_full").bit) & 1, 1);
  check("the board folds", (r.won >> F("won").bit) & 1, oracle.won);
  check("signatures final", (r.sigsEnd << 16) >> 16, oracle.sigs);
  check("ends in the boardroom", r.endMap, maps.boardroom);
  check("no script running", r.scriptEnd, 0);
  check("no textbox", r.textEnd, 0);
}

const requested = process.argv.slice(2) as TargetName[];
const targets: TargetName[] = requested.length ? requested : (["gba", "gb", "nes"] as TargetName[]);
for (const t of targets) await testTarget(t);
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
