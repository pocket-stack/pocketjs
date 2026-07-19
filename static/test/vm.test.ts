// static/test/vm.test.ts — reference VM semantics, pinned.
//
// These programs pin the ISA behavior that vm/core.c must reproduce
// bit-for-bit on all three consoles. If you change an expectation here you
// are changing the console contract — regenerate spec_gen.h and touch every
// runtime.

import { describe, expect, test } from "bun:test";
import { RNG_SEED, WAITING, rngNext } from "../spec/isa.ts";
import { assemble } from "../vm/asm.ts";
import { RefVM } from "../vm/ref.ts";
import { AutoRpgHost } from "../vm/rpg-host.ts";

function runProgram(program: Parameters<typeof assemble>[0], picks: number[] = []) {
  const code = assemble(program);
  const host = new AutoRpgHost(picks);
  const vm = new RefVM(code, [0], host);
  host.play(vm, 0);
  return { vm, host };
}

describe("core ops", () => {
  test("arithmetic folds and wraps at i16", () => {
    const { vm } = runProgram([
      ["PUSH16", 30000],
      ["PUSH16", 10000],
      ["ADD"], // 40000 -> -25536
      ["STV", 0],
      ["PUSH8", -7],
      ["PUSH8", 3],
      ["DIV"], // trunc toward zero -> -2
      ["STV", 1],
      ["PUSH8", -7],
      ["PUSH8", 3],
      ["MOD"], // sign of dividend -> -1
      ["STV", 2],
      ["PUSH8", 5],
      ["PUSH8", 0],
      ["DIV"], // div by zero -> 0
      ["STV", 3],
      ["END"],
    ]);
    expect(vm.getVar(0)).toBe(-25536);
    expect(vm.getVar(1)).toBe(-2);
    expect(vm.getVar(2)).toBe(-1);
    expect(vm.getVar(3)).toBe(0);
  });

  test("comparisons are signed", () => {
    const { vm } = runProgram([
      ["PUSH16", -1],
      ["PUSH16", 1],
      ["LT"],
      ["STV", 0], // -1 < 1 -> 1
      ["PUSH16", -32768],
      ["PUSH16", 32767],
      ["GT"],
      ["STV", 1], // 0
      ["END"],
    ]);
    expect(vm.getVar(0)).toBe(1);
    expect(vm.getVar(1)).toBe(0);
  });

  test("jumps, labels, loop", () => {
    // var0 = sum 1..5 via a while loop
    const { vm } = runProgram([
      ["PUSH8", 1],
      ["STL", 0], // i = 1
      "loop",
      ["LDL", 0],
      ["PUSH8", 5],
      ["GT"],
      ["JNZ", "done"],
      ["LDV", 0],
      ["LDL", 0],
      ["ADD"],
      ["STV", 0],
      ["LDL", 0],
      ["PUSH8", 1],
      ["ADD"],
      ["STL", 0],
      ["JMP", "loop"],
      "done",
      ["END"],
    ]);
    expect(vm.getVar(0)).toBe(15);
  });

  test("flags set/clear/store/read", () => {
    const { vm } = runProgram([
      ["SETF", 3],
      ["FLAG", 3],
      ["STV", 0],
      ["CLRF", 3],
      ["FLAG", 3],
      ["STV", 1],
      ["PUSH8", 42],
      ["STF", 200],
      ["FLAG", 200],
      ["STV", 2],
      ["END"],
    ]);
    expect(vm.getVar(0)).toBe(1);
    expect(vm.getVar(1)).toBe(0);
    expect(vm.getVar(2)).toBe(1);
  });

  test("RND sequence is the pinned xorshift16 stream", () => {
    let s = RNG_SEED;
    const expected: number[] = [];
    for (let i = 0; i < 4; i++) {
      s = rngNext(s);
      expected.push(s % 6);
    }
    const { vm } = runProgram([
      ["PUSH8", 6], ["RND"], ["STV", 0],
      ["PUSH8", 6], ["RND"], ["STV", 1],
      ["PUSH8", 6], ["RND"], ["STV", 2],
      ["PUSH8", 6], ["RND"], ["STV", 3],
      ["PUSH8", 0], ["RND"], ["STV", 4], // n<=0 -> 0, no state advance
      ["END"],
    ]);
    expect([vm.getVar(0), vm.getVar(1), vm.getVar(2), vm.getVar(3)]).toEqual(expected);
    expect(vm.getVar(4)).toBe(0);
    expect(vm.rng).toBe(s);
  });
});

describe("calls and locals", () => {
  test("CALL/RET with per-frame locals", () => {
    // script 1 clobbers ITS local 0; caller's local 0 survives.
    const code = assemble([
      // script 0 @0
      ["PUSH8", 7],
      ["STL", 0],
      ["CALL", 1],
      ["LDL", 0],
      ["STV", 0], // still 7
      ["END"],
      // script 1
      "sub",
      ["PUSH8", 99],
      ["STL", 0],
      ["LDL", 0],
      ["STV", 1], // 99
      ["RET"],
    ]);
    // entry of script 1 = offset of label "sub": compute by assembling prefix
    const prefix = assemble([
      ["PUSH8", 7],
      ["STL", 0],
      ["CALL", 1],
      ["LDL", 0],
      ["STV", 0],
      ["END"],
    ]);
    const host = new AutoRpgHost();
    const vm = new RefVM(code, [0, prefix.length], host);
    host.play(vm, 0);
    expect(vm.getVar(0)).toBe(7);
    expect(vm.getVar(1)).toBe(99);
  });

  test("call stack overflow throws (depth 4)", () => {
    // script 0 calls itself forever
    const code = assemble([["CALL", 0], ["END"]]);
    const vm = new RefVM(code, [0], new AutoRpgHost());
    expect(() => vm.start(0)).toThrow(/call stack overflow/);
  });
});

describe("suspension + rpg syscalls", () => {
  test("SAY suspends and resumes; transcript ordered", () => {
    const { host } = runProgram([
      ["SAY", 5],
      ["SAY", 6],
      ["END"],
    ]);
    expect(host.events).toEqual([
      { kind: "say", textId: 5 },
      { kind: "say", textId: 6 },
    ]);
  });

  test("CHOICE pushes the picked index on resume", () => {
    const { vm, host } = runProgram(
      [
        ["CHOICE", 10, 11, 12],
        ["STV", 0],
        ["END"],
      ],
      [2],
    );
    expect(vm.getVar(0)).toBe(2);
    expect(host.events[0]).toEqual({ kind: "choice", textIds: [10, 11, 12], picked: 2 });
  });

  test("WAIT suspends with frame count; WAIT 0 does not", () => {
    const { vm, host } = runProgram([
      ["PUSH8", 30],
      ["WAIT"],
      ["PUSH8", 0],
      ["WAIT"],
      ["END"],
    ]);
    expect(host.events).toEqual([{ kind: "wait", frames: 30 }]);
    expect(vm.status).toBe("done");
  });

  test("full syscall surface round-trips operands", () => {
    const { host } = runProgram([
      ["LOCK"],
      ["FACE", 0xff],
      ["AVIS", 3, 0],
      ["SFX", 2],
      ["WARP", 1, 12, 9, 1],
      ["RELEASE"],
      ["END"],
    ]);
    expect(host.events).toEqual([
      { kind: "lock" },
      { kind: "face", slot: 0xff },
      { kind: "avis", slot: 3, visible: false },
      { kind: "sfx", id: 2 },
      { kind: "warp", map: 1, x: 12, y: 9, dir: 1 },
      { kind: "release" },
    ]);
  });
});

describe("strictness", () => {
  test("stack underflow throws", () => {
    const vm = new RefVM(assemble([["POP"], ["END"]]), [0], new AutoRpgHost());
    expect(() => vm.start(0)).toThrow(/underflow/);
  });

  test("illegal opcode throws", () => {
    const vm = new RefVM(Uint8Array.from([0x3f]), [0], new AutoRpgHost());
    expect(() => vm.start(0)).toThrow(/illegal opcode/);
  });

  test("runaway loop trips the guard", () => {
    const vm = new RefVM(assemble(["top", ["JMP", "top"], ["END"]]), [0], new AutoRpgHost());
    expect(() => vm.start(0)).toThrow(/runaway/);
  });
});
