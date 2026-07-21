// Reproducible pocketjs.dev build from a fresh checkout. Keep local preview,
// main deploys, and tag releases on the same prerequisite chain.
import { existsSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const generatedStyles = ROOT + "src/styles.generated.ts";

// scripts/build.ts imports this gitignored module during its first pass. Seed a
// positive resolution before Bun can cache the missing path; each app build
// immediately replaces the stub with its real style table.
if (!existsSync(generatedStyles)) {
  writeFileSync(
    generatedStyles,
    `export const STYLE_IDS: Record<string, number> = {};
export const STYLE_COUNT = 0;
export const FONT_SLOTS: Record<number, { px: number; bold: boolean }> = {};
export const DEFAULT_FONT_SLOT = 2;
`,
  );
}

async function run(...args: string[]) {
  const child = Bun.spawn(["bun", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

await run("scripts/wasm.ts");
// The homepage stage ships the Pocket Launcher + every admitted app
// (LAUNCHER.md): registry scan, per-app bundles, deterministic sim-rendered
// covers, then the launcher bundle itself.
await run("scripts/launcher.ts", "covers");
await run(
  "scripts/pocket.ts",
  "compile",
  "--target",
  "psp",
  "--manifest",
  "demos/launcher/pocket.json",
  "--project-root",
  ".",
);
// Restore the site's canonical hero table for the generic browser runtime.
await run("scripts/build.ts", "hero");
await run("site/build.ts");
