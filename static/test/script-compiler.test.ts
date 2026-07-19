// static/test/script-compiler.test.ts — the script compiler, proven against
// the reference VM. Every test: TypeScript source -> bytecode -> ref VM run
// with the auto-playing RPG host -> assert on VM state + event transcript.
// No emulator, no consoles — this is the layer that makes the console
// runtimes boring.

import { describe, expect, test } from "bun:test";
import { compileScriptSource } from "../compiler/compile-scripts.ts";
import { RefVM } from "../vm/ref.ts";
import { AutoRpgHost, type RpgEvent } from "../vm/rpg-host.ts";

function run(source: string, picks: number[] = [], scriptId = 0) {
  const r = compileScriptSource(source);
  const host = new AutoRpgHost(picks);
  const vm = new RefVM(r.blob, r.table, host);
  host.play(vm, scriptId);
  return { vm, host, ctx: r.ctx };
}

/** Text of the page shown by the i-th say event. */
const sayPages = (host: AutoRpgHost, ctx: { textDebug: string[] }): string[] =>
  host.events.filter((e): e is Extract<RpgEvent, { kind: "say" }> => e.kind === "say").map((e) => ctx.textDebug[e.textId]);

describe("expressions and locals", () => {
  test("arithmetic with locals, vars, precedence", () => {
    const { vm, ctx } = run(`
      const S = script(function* (s, v, f) {
        let a = 2 + 3 * 4;         // 14
        let b = (a - 4) / 5;       // 2
        v.result = a * 10 + b % 2; // 140
        v.neg = -b;
      });
    `);
    expect(vm.getVar(ctx.varNames.result)).toBe(140);
    expect(vm.getVar(ctx.varNames.neg)).toBe(-2);
  });

  test("&& || ! short-circuit with JS value semantics", () => {
    const { vm, ctx } = run(`
      const S = script(function* (s, v, f) {
        v.a = 0 || 7;
        v.b = 3 && 5;
        v.c = 0 && 9;
        v.d = !0;
        v.e = !!42;
        f.armed = true;
        v.g = f.armed && 11;
      });
    `);
    expect(vm.getVar(ctx.varNames.a)).toBe(7);
    expect(vm.getVar(ctx.varNames.b)).toBe(5);
    expect(vm.getVar(ctx.varNames.c)).toBe(0);
    expect(vm.getVar(ctx.varNames.d)).toBe(1);
    expect(vm.getVar(ctx.varNames.e)).toBe(1);
    expect(vm.getVar(ctx.varNames.g)).toBe(11);
  });

  test("ternary", () => {
    const { vm, ctx } = run(`
      const S = script(function* (s, v, f) {
        let hp = 3;
        v.msg = hp > 5 ? 100 : 200;
      });
    `);
    expect(vm.getVar(ctx.varNames.msg)).toBe(200);
  });

  test("compound assignment and ++/--", () => {
    const { vm, ctx } = run(`
      const S = script(function* (s, v, f) {
        v.n = 10;
        v.n += 5;
        v.n -= 2;
        v.n *= 3;
        v.n /= 2;   // trunc
        let i = 0;
        i++;
        i++;
        i--;
        v.i = i;
      });
    `);
    expect(vm.getVar(ctx.varNames.n)).toBe(19); // ((10+5-2)*3)/2 = 19.5 -> 19
    expect(vm.getVar(ctx.varNames.i)).toBe(1);
  });
});

describe("control flow", () => {
  test("if/else chains on runtime values", () => {
    const src = (n: number) => `
      const S = script(function* (s, v, f) {
        v.n = ${n};
        if (v.n > 10) { v.r = 1; }
        else if (v.n > 5) { v.r = 2; }
        else { v.r = 3; }
      });
    `;
    expect(run(src(20)).vm.getVar(1)).toBe(1);
    expect(run(src(7)).vm.getVar(1)).toBe(2);
    expect(run(src(1)).vm.getVar(1)).toBe(3);
  });

  test("while with break/continue", () => {
    const { vm, ctx } = run(`
      const S = script(function* (s, v, f) {
        let i = 0;
        while (true) {
          i += 1;
          if (i === 3) { continue; }
          if (i >= 6) { break; }
          v.sum += i;
        }
        v.i = i;
      });
    `);
    expect(vm.getVar(ctx.varNames.sum)).toBe(1 + 2 + 4 + 5);
    expect(vm.getVar(ctx.varNames.i)).toBe(6);
  });

  test("classic for loop", () => {
    const { vm, ctx } = run(`
      const S = script(function* (s, v, f) {
        for (let i = 1; i <= 5; i++) { v.sum += i; }
      });
    `);
    expect(vm.getVar(ctx.varNames.sum)).toBe(15);
  });

  test("switch over numbers with default + fallthrough", () => {
    const src = (n: number) => `
      const S = script(function* (s, v, f) {
        v.n = ${n};
        switch (v.n) {
          case 1:
          case 2: v.r = 12; break;
          case 3: v.r = 3; break;
          default: v.r = 99;
        }
      });
    `;
    expect(run(src(1)).vm.getVar(1)).toBe(12);
    expect(run(src(2)).vm.getVar(1)).toBe(12);
    expect(run(src(3)).vm.getVar(1)).toBe(3);
    expect(run(src(7)).vm.getVar(1)).toBe(99);
  });
});

describe("rpg ops", () => {
  test("say wraps to pages per target", () => {
    const long = "The board no longer has confidence in his ability to continue leading the company forward.";
    const { host, ctx } = run(`
      const S = script(function* (s, v, f) {
        yield* s.say(${JSON.stringify(long)});
      });
    `);
    const pages = sayPages(host, ctx);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      for (const line of p.split("\n")) expect(line.length).toBeLessThanOrEqual(28);
      expect(p.split("\n").length).toBeLessThanOrEqual(3);
    }
    expect(pages.join(" ").replace(/\n/g, " ")).toBe(long);
  });

  test("choice drives branches; string comparison sugar", () => {
    const src = `
      const S = script(function* (s, v, f) {
        const pick = yield* s.choose(["Push back", "Stay calm"]);
        if (pick === "Push back") { v.r = 1; } else { v.r = 2; }
      });
    `;
    expect(run(src, [0]).vm.getVar(0)).toBe(1);
    expect(run(src, [1]).vm.getVar(0)).toBe(2);
  });

  test("switch over choice with string labels", () => {
    const src = `
      const S = script(function* (s, v, f) {
        switch (yield* s.choose(["Fight", "Talk", "Leave"])) {
          case "Fight": v.r = 1; break;
          case "Talk": v.r = 2; break;
          case "Leave": v.r = 3; break;
        }
      });
    `;
    expect(run(src, [0]).vm.getVar(0)).toBe(1);
    expect(run(src, [1]).vm.getVar(0)).toBe(2);
    expect(run(src, [2]).vm.getVar(0)).toBe(3);
  });

  test("template interpolation: static folds, runtime becomes FMT slot", () => {
    const { host, ctx } = run(`
      const S = script(function* (s, v, f) {
        const WHO = "SAM";
        let resolve = 40 + 2;
        yield* s.say(\`\${WHO}: resolve at \${resolve} percent\`);
      });
    `);
    const pages = sayPages(host, ctx);
    expect(pages[0]).toContain("SAM: resolve at {v60}");
    // scratch var 60 holds the runtime value at say-time
    expect(run(`
      const S = script(function* (s, v, f) {
        let x = 42;
        yield* s.say(\`n=\${x}\`);
      });
    `).vm.getVar(60)).toBe(42);
  });

  test("flags, sfx, lock/release, wait, warp fixup recorded", () => {
    const { host, ctx } = run(`
      const S = script(function* (s, v, f) {
        yield* s.lock();
        f.fired = true;
        if (f.fired) { yield* s.sfx("fanfare"); }
        yield* s.wait(30);
        yield* s.warp("hq:door");
        yield* s.release();
      });
    `);
    const kinds = host.events.map((e) => e.kind);
    expect(kinds).toEqual(["lock", "sfx", "wait", "warp", "release"]);
    expect(ctx.warpFixups).toHaveLength(1);
    expect(ctx.warpFixups[0].dest).toBe("hq:door");
  });

  test("rnd in expressions is deterministic", () => {
    const a = run(`
      const S = script(function* (s, v, f) {
        v.d = 1 + (yield* s.rnd(6)) + (yield* s.rnd(6));
      });
    `).vm.getVar(0);
    const b = run(`
      const S = script(function* (s, v, f) {
        v.d = 1 + (yield* s.rnd(6)) + (yield* s.rnd(6));
      });
    `).vm.getVar(0);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(11);
  });
});

describe("subroutines and macros", () => {
  test("s.call() runs another script and returns", () => {
    const { vm, ctx } = run(
      `
      const Greet = script(function* (s, v, f) {
        v.calls += 1;
      });
      const Main = script(function* (s, v, f) {
        yield* s.call(Greet);
        yield* s.call(Greet);
        v.done = 1;
      });
    `,
      [],
      1,
    );
    expect(vm.getVar(ctx.varNames.calls)).toBe(2);
    expect(vm.getVar(ctx.varNames.done)).toBe(1);
  });

  test("macro inlining with static config, for...of unroll, static if fold", () => {
    const { vm, host, ctx } = run(`
      function* fanfare(s, v, cfg) {
        for (const step of cfg.steps) {
          if (step.loud) { yield* s.sfx("fanfare"); }
          v.total += step.n;
        }
      }
      const S = script(function* (s, v, f) {
        yield* fanfare(s, v, { steps: [ { n: 1, loud: true }, { n: 2, loud: false }, { n: 3, loud: true } ] });
      });
    `);
    expect(vm.getVar(ctx.varNames.total)).toBe(6);
    expect(host.events.filter((e) => e.kind === "sfx")).toHaveLength(2);
  });

  test("value macro: return value via result slot, early return", () => {
    const src = (pick: number) => `
      function* damage(s, base) {
        const crit = yield* s.rnd(2);
        if (crit === 1) { return base * 2; }
        return base;
      }
      const S = script(function* (s, v, f) {
        const pick = yield* s.choose(["hit", "skip"]);
        if (pick === 0) { v.dmg = yield* damage(s, 10); }
        else { v.dmg = -1; }
      });
    `;
    const { vm } = run(src(0), [0]);
    expect([10, 20]).toContain(vm.getVar(0));
    expect(run(src(1), [1]).vm.getVar(0)).toBe(-1);
  });

  test("a battle loop written as plain DSL survives compilation", () => {
    // The shape the boardroom finale uses: menus, RNG damage, HP vars.
    const { vm, host, ctx } = run(
      `
      const Battle = script(function* (s, v, f) {
        v.board = 12;
        v.sam = 10;
        while (v.board > 0 && v.sam > 0) {
          const move = yield* s.choose(["Tender offer", "Heart emoji"]);
          if (move === "Tender offer") { v.board -= 2 + (yield* s.rnd(3)); }
          else { v.board -= 1; v.sam += 1; }
          if (v.board > 0) { v.sam -= 1 + (yield* s.rnd(2)); }
        }
        if (v.sam > 0) { f.won = true; yield* s.say("The board folds."); }
        else { yield* s.say("Resolve exhausted."); }
      });
    `,
      Array(40).fill(0),
    );
    expect(vm.status).toBe("done");
    const flags = ctx.flagNames;
    // Deterministic RNG: this exact playthrough always lands the same way.
    expect(vm.getFlag(flags.won)).toBe(1);
    expect(host.events.some((e) => e.kind === "say")).toBe(true);
  });

  test("recursive macros are rejected", () => {
    expect(() =>
      run(`
        function* loop(s) { yield* loop(s); }
        const S = script(function* (s, v, f) { yield* loop(s); });
      `),
    ).toThrow(/recursive macro/);
  });
});

describe("diagnostics", () => {
  test("unknown identifier errors with location", () => {
    expect(() =>
      run(`
      const S = script(function* (s, v, f) {
        v.x = mystery;
      });
    `),
    ).toThrow(/unknown identifier "mystery"/);
  });

  test("string case label without choice metadata errors", () => {
    expect(() =>
      run(`
      const S = script(function* (s, v, f) {
        switch (v.x) { case "nope": break; }
      });
    `),
    ).toThrow(/string case labels/);
  });

  test("non-ASCII text is rejected in v1", () => {
    expect(() =>
      run(`
      const S = script(function* (s, v, f) {
        yield* s.say("你好");
      });
    `),
    ).toThrow(/ASCII/);
  });

  test("too many locals errors", () => {
    const decls = Array.from({ length: 20 }, (_, i) => `let x${i} = v.n + ${i};`).join("\n");
    expect(() => run(`const S = script(function* (s, v, f) { ${decls} });`)).toThrow(/too many locals/);
  });
});
