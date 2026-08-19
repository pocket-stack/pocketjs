// Sim-side coverage for per-realm tick rates (docs/DETERMINISM.md): the
// engine/wasm `ui_set_tick_rate` export with its declare-before-first-tick
// lifecycle, and a 120 Hz-baked realm driven end to end through runScenario —
// deterministic, and (for the café app, which is inside the subsampling
// theorem's scope: JS state changes only on events and virtual time) strictly
// subsampled by lower presentation rates, exactly like tests/sim.test.ts
// proves for the 60 Hz realm.
//
// Stage prep (tools/test.ts) rebuilds pocketjs.wasm and bakes the 120 Hz café
// bundle into dist/tick-rate-120/; this file re-ensures both so it also runs
// standalone.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { runScenario, treeHasText, type Trace } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WASM_PATH = join(ROOT, "hosts/web/pocketjs.wasm");
const APP = "tick-rate-120/cafe-main"; // dist path fragment; baked --hz=120
const APP_JS = join(ROOT, "dist/tick-rate-120/cafe-main.js");

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`tick-rate-sim: ${cmd.join(" ")} failed`);
}

async function freshUi() {
  return createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
}

// A stale on-disk pocketjs.wasm predates the export on long-lived dev
// machines — rebuild once, exactly what the bootWorld error would ask for.
if (!existsSync(WASM_PATH) || !(await freshUi()).ops.setTickRate) {
  run([process.execPath, "tools/wasm.ts"]);
}
if (!existsSync(APP_JS)) {
  run([process.execPath, "tools/build.ts", "cafe-main", "--hz=120", "--outdir=dist/tick-rate-120"]);
}

describe("wasm ui_set_tick_rate", () => {
  test("declares before the first tick and publishes ops.__tickHz", async () => {
    const ui = await freshUi();
    expect(ui.ops.setTickRate(120)).toBe(true);
    expect(ui.ops.__tickHz).toBe(120);
  });

  test("rejects 0, above-240, and post-tick declarations", async () => {
    const ui = await freshUi();
    expect(ui.ops.setTickRate(0)).toBe(false);
    expect(ui.ops.setTickRate(241)).toBe(false);
    expect(ui.ops.__tickHz).toBeUndefined();
    ui.tick();
    expect(ui.ops.setTickRate(120)).toBe(false);
    expect(ui.ops.__tickHz).toBeUndefined();
  });

  test("init resets the core to the spec 60 and retracts the published rate", async () => {
    const ui = await freshUi();
    expect(ui.ops.setTickRate(120)).toBe(true);
    ui.init();
    expect(ui.ops.__tickHz).toBeUndefined();
    expect(ui.ops.setTickRate(90)).toBe(true);
    expect(ui.ops.__tickHz).toBe(90);
  });
});

// The café journey from tests/sim.test.ts — the 0.5 s grid lands on an exact
// frame at 120/60/30 Hz the same way it does at 60/4/2.
const JOURNEY = [
  { at: 1.0, press: BTN.CIRCLE },
  { at: 1.5, press: BTN.DOWN },
  { at: 2.0, press: BTN.CIRCLE },
  { at: 3.0, press: BTN.CIRCLE },
  { at: 3.5, press: BTN.START },
];
const SECONDS = 6.5;

const scenario = (hz?: number) => ({
  app: APP,
  tickHz: 120,
  hz,
  seconds: SECONDS,
  script: JOURNEY,
});

describe("a 120 Hz realm through the sim", () => {
  test("reaches the core, runs deterministically, and the journey lands", async () => {
    const a: Trace = await runScenario(scenario());
    const b: Trace = await runScenario(scenario());
    expect(a.hz).toBe(120);
    expect(a.frames).toBe(SECONDS * 120);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.effects).toEqual(b.effects);
    expect(treeHasText(a.tree, "ORDERS PLACED 1")).toBe(true);
  }, 30000);

  test("lower presentation rates strictly subsample the 120 Hz trajectory", async () => {
    const full: Trace = await runScenario(scenario());
    for (const hz of [60, 30]) {
      const sub: Trace = await runScenario(scenario(hz));
      const k = 120 / hz;
      expect(sub.frames).toBe(SECONDS * hz);
      for (let m = 0; m < sub.frames; m++) {
        expect(sub.hashes[m]).toBe(full.hashes[k * (m + 1) - 1]);
      }
      expect(Buffer.from(sub.finalFrame).equals(Buffer.from(full.finalFrame))).toBe(true);
      const seconds = (t: Trace) => t.effects.map((e) => ({ kind: e.kind, sec: e.frame / t.hz }));
      expect(seconds(sub)).toEqual(seconds(full));
    }
  }, 30000);

  test("refuses an hz that does not divide the declared rate", async () => {
    await expect(runScenario({ app: APP, tickHz: 120, hz: 50, seconds: 1 })).rejects.toThrow(
      /divide/,
    );
  });
});
