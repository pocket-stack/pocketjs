// aot/test/harness/run_scenario.ts — one place that knows which runner drives
// which target, shared by every e2e suite. All runners speak the same scenario
// JSON protocol (advance / press / read / screenshot) and print a final JSON
// line: {"reads": {...}, "ok": true}.

import { $ } from "bun";
import type { TargetName } from "../../spec/pjgb.ts";

const HERE = new URL(".", import.meta.url).pathname;
const MGBA_RUNNER = HERE + "mgba_runner"; // native binary (gba + gb)
const NES_RUNNER = HERE + "nes_runner.ts"; // jsnes
const HOST_RUNNER = HERE + "host_runner.ts"; // pj_frame cores over Bun FFI (3ds + nds)

/** Run one scenario file through the target's runner; returns the reads map. */
export async function runScenario(target: TargetName, rom: string, scenarioPath: string): Promise<Record<string, number>> {
  const out =
    target === "nes"
      ? await $`bun ${NES_RUNNER} ${rom} ${scenarioPath}`.text()
      : target === "3ds" || target === "nds"
        ? await $`bun ${HOST_RUNNER} ${rom} ${scenarioPath}`.text()
        : await $`${MGBA_RUNNER} ${rom} ${scenarioPath}`.quiet().text();
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("runner produced no JSON:\n" + out.slice(-2000));
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error("runner error: " + JSON.stringify(parsed));
  return parsed.reads ?? {};
}
