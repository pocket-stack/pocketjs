// scripts/dev.ts — one-shot dev loop: build the wasm backend, build the demo
// bundle(s), then serve the browser host.
//
//   bun scripts/dev.ts                 # wasm + hero-main + serve
//   bun scripts/dev.ts hero-main cards # build specific demos instead
//   PORT=9000 bun scripts/dev.ts
//
// Rebuild-on-change is deliberately manual (dev-tool simplicity): re-run
// `bun scripts/build.ts <app>` (or this script) and reload the page.

const ROOT = new URL("..", import.meta.url).pathname; // psp-ui/

function run(cmd: string[]): void {
  console.log(`dev: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
}

const demos = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (demos.length === 0) demos.push("hero-main");

run(["bun", "scripts/wasm.ts"]);
for (const demo of demos) {
  run(["bun", "scripts/build.ts", demo]);
}

await import("../host-web/serve.ts");
