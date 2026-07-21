// scripts/hw-bench.ts — build each demo, run it on the connected PSP, and
// collect the always-on perf probe's steady-state window.
//
//   bun scripts/hw-bench.ts rally snake dogfight runner
//
// Assumes usbhostfs_pc is already serving native/target/mipsel-sony-psp/release
// and PSPLINK is up (scripts/hw.ts owns that dance for interactive use; this
// script is for sweeping several demos unattended).
//
// The probe writes host0:/PocketJS-perf.txt, which lands in the served target
// dir — that is the channel to read, NOT the PSPLINK tty, which only reaches a
// shell that was connected when the module started.
import { $ } from "bun";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const target = `${root}native/target/mipsel-sony-psp/release`;
const perfPath = `${target}/PocketJS-perf.txt`;
const port = process.env.PSP_HW_PORT ?? "10000";

const demos = Bun.argv.slice(2).filter((a) => !a.startsWith("-"));
if (demos.length === 0) {
  console.error("usage: bun scripts/hw-bench.ts <demo>...");
  process.exit(1);
}

/** Windows to wait for; the first one carries boot skew, so read a later one. */
const WINDOWS = 3;

async function pspsh(command: string, timeoutMs = 15000): Promise<string> {
  const child = Bun.spawn(["pspsh", "-p", port, "-e", command], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return (out + err).trim();
}

async function waitForLink(seconds = 25): Promise<boolean> {
  for (let i = 0; i < seconds; i += 1) {
    if ((await pspsh("ls host0:/pocketjs-psp.prx", 5000)).includes("pocketjs-psp.prx")) return true;
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * A `reset` sometimes leaves usbhostfs_pc holding a link the console has
 * already dropped, and every later pspsh just gets ECONNREFUSED. Restarting
 * the host process re-handshakes. Only the PSP being off or PSPLINK not
 * running needs a human, and this tells them which.
 */
async function relink(): Promise<boolean> {
  console.log("  link stalled — restarting usbhostfs_pc");
  await $`pkill -f usbhostfs_pc`.quiet().nothrow();
  await Bun.sleep(2000);
  Bun.spawn(["usbhostfs_pc", "-b", port, target], { stdout: "ignore", stderr: "ignore" });
  return waitForLink(40);
}

function windows(): string[] {
  if (!existsSync(perfPath)) return [];
  return readFileSync(perfPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("pocketjs perf"));
}

const results: { demo: string; line: string }[] = [];
for (const demo of demos) {
  console.log(`\n=== ${demo}: building`);
  const build = await $`bun ${root}scripts/psp.ts ${demo} --release`.quiet().nothrow();
  if (build.exitCode !== 0) {
    console.error(`  build failed, skipping`);
    continue;
  }
  if (existsSync(perfPath)) unlinkSync(perfPath);

  await pspsh("reset");
  if (!(await waitForLink()) && !(await relink())) {
    console.error("  PSPLINK never came back — relaunch it from the XMB (Game -> PSPLINK).");
    break;
  }
  console.log(`  ${await pspsh(`ldstart host0:/pocketjs-psp.prx`)}`);

  // 300 frames per window; a slow demo can take minutes to fill three.
  const deadline = Date.now() + 8 * 60_000;
  while (windows().length < WINDOWS && Date.now() < deadline) await Bun.sleep(2000);
  const w = windows();
  if (w.length === 0) {
    console.error("  no perf output — did the app boot?");
    continue;
  }
  const line = w[w.length - 1];
  results.push({ demo, line });
  console.log(`  ${line}`);
}

console.log("\n=== steady-state windows");
for (const r of results) {
  const num = (k: string) => Number(/(?:^|\s)#(\d+)/.exec(r.line.replace(k, "#"))?.[1] ?? NaN);
  const work = num("avg_work_us=");
  const wait = num("avg_gu_wait_us=");
  const over = num("over_budget=");
  const critical = work + wait;
  const verdict = critical <= 16667 && over < 15 ? "60fps" : critical <= 16667 ? "60fps w/ hitches" : "OVER";
  console.log(
    `${r.demo.padEnd(10)} work=${String(work).padStart(6)}µs wait=${String(wait).padStart(5)}µs ` +
      `critical=${String(critical).padStart(6)}µs over=${String(over).padStart(3)}/300  ${verdict}`,
  );
}
