// tests/e2e/launcher-ppsspp.ts — the app-switch protocol on the REAL PSP
// host, in PPSSPPHeadless (docs/LAUNCHER.md). Companion to tests/e2e/ppsspp.ts
// (same driver shape), but liveness-shaped rather than golden-shaped:
//
// Deliberately NO goldens/psp PNGs. The deck's covers are live sim renders
// of the other demos, so a committed launcher golden would break on ANY
// demo's visual change (see tests/launcher-sim.test.ts for the same call).
// What this run proves instead:
//   - the multi-app EBOOT boots the launcher guest,
//   - CIRCLE launches Café (guest swap #1: teardown + fresh boot),
//   - SELECT summons the launcher back (swap #2, frozen shot captured),
//   - RIGHT browses, CIRCLE launches Chrome (swap #3),
// all under a baked input script, with the frame loop never wedging. The
// capture signature is exact: a switch discards precisely one frame, so a
// 220-frame window crossed by 3 switches yields 217 files with gaps at the
// three switch frames and nowhere else.
//
// Run: bun tests/e2e/launcher-ppsspp.ts   (npm: e2e:launcher)
// Host deps: ~/ppsspp-src/build/PPSSPPHeadless (or PPSSPP_HEADLESS).

import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const ROOT = new URL("../..", import.meta.url).pathname;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
const dccap = `${homedir()}/.ppsspp/dc_cap`;
const eboot = `${ROOT}hosts/psp/target/mipsel-sony-psp/debug/EBOOT.PBP`;

// The journey, in global frames (launcher registry order: Café, Chrome, …).
// Level-triggered script (capture_input_mask holds the last entry's mask),
// so every press carries an explicit release. CIRCLE (0x2000) confirms —
// the deck's console-convention mapping.
const LAUNCH_CAFE = 90;
const SELECT_SUMMON = 180;
const RIGHT_BROWSE = 240;
const LAUNCH_CHROME = 270;
const INPUT = [
  "0:0",
  `${LAUNCH_CAFE}:0x2000`,
  `${LAUNCH_CAFE + 1}:0`,
  `${SELECT_SUMMON}:0x0001`,
  `${SELECT_SUMMON + 1}:0`,
  `${RIGHT_BROWSE}:0x0020`,
  `${RIGHT_BROWSE + 1}:0`,
  `${LAUNCH_CHROME}:0x2000`,
  `${LAUNCH_CHROME + 1}:0`,
].join(",");
const CAP_START = 80;
const CAP_N = 220;
// A switch at frame N discards frame N itself (the list is never kicked);
// relative to CAP_START these indices must be the ONLY missing files.
const EXPECTED_GAPS = new Set(
  [LAUNCH_CAFE, SELECT_SUMMON, LAUNCH_CHROME].map((f) => f - CAP_START),
);

if (!existsSync(headless)) {
  console.error(`PPSSPPHeadless not found at ${headless} (set PPSSPP_HEADLESS)`);
  process.exit(1);
}

console.log("# registry + covers (cached when fresh) ...");
await $`bun tools/launcher.ts covers`.cwd(ROOT).quiet();

console.log("# build multi-app capture EBOOT ...");
await $`bun tools/pocket.ts build --target psp --manifest apps/launcher/pocket.json --project-root . -- --capture --launcher-registry=dist/launcher-registry.tsv`
  .cwd(ROOT)
  .env({
    ...process.env,
    POCKETJS_CAPTURE_INPUT: INPUT,
    POCKETJS_CAP_START: String(CAP_START),
    POCKETJS_CAP_N: String(CAP_N),
  })
  .quiet();

console.log("# PPSSPPHeadless (software renderer) ...");
rmSync(dccap, { recursive: true, force: true });
rmSync(`${ROOT}hosts/psp/target/mipsel-sony-psp/debug/pocketjs-dbg`, { recursive: true, force: true });
const timeout = Number(process.env.E2E_PPSSPP_TIMEOUT || 180);
const run = await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`
  .cwd("/tmp")
  .nothrow()
  .quiet();

let failed = false;
const produced = existsSync(dccap)
  ? readdirSync(dccap)
      .filter((f) => /^f\d{4}\.raw$/.test(f))
      .map((f) => Number(f.slice(1, 5)))
      .sort((a, b) => a - b)
  : [];

// 1. Exact capture signature: every window frame except the three switch
//    frames, no extras — proves each swap happened at its scripted frame
//    and the loop ran the whole window.
const missing: number[] = [];
const unexpected: number[] = [];
for (let i = 0; i < CAP_N; i++) {
  const has = produced.includes(i);
  if (!has && !EXPECTED_GAPS.has(i)) missing.push(i);
  if (has && EXPECTED_GAPS.has(i)) unexpected.push(i);
}
if (missing.length || unexpected.length || produced.length !== CAP_N - EXPECTED_GAPS.size) {
  console.error(
    `FAIL: capture signature mismatch — produced ${produced.length}/${CAP_N} ` +
      `(want ${CAP_N - EXPECTED_GAPS.size}), missing beyond gaps: [${missing.join(", ")}], ` +
      `dumped at expected gaps: [${unexpected.join(", ")}]. PPSSPP output:\n${run.stdout}${run.stderr}`,
  );
  failed = true;
}

// 2. The guests really swapped: frames from different phases must differ
//    (launcher deck vs Café vs summoned deck vs Chrome), and the summoned
//    deck must differ from the pre-launch deck (frozen shot + badge).
function frame(rel: number): Buffer {
  return readFileSync(`${dccap}/f${String(rel).padStart(4, "0")}.raw`);
}
if (!failed) {
  const launcher = frame(9); // global 89: settled deck, pre-launch
  const cafe = frame(99); // global 179: Café, pre-summon
  const summoned = frame(102); // global 182+: deck again, shot + badge
  const chrome = frame(215); // global 295: Chrome settled
  const pairs: [string, Buffer, Buffer][] = [
    ["launcher vs cafe", launcher, cafe],
    ["cafe vs summoned", cafe, summoned],
    ["summoned vs launcher", summoned, launcher],
    ["chrome vs cafe", chrome, cafe],
  ];
  for (const [label, a, b] of pairs) {
    if (a.equals(b)) {
      console.error(`FAIL: ${label}: frames are byte-identical — a swap did not happen`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(
  `PASS: ${produced.length}/${CAP_N} frames, gaps exactly at ` +
    `[${[...EXPECTED_GAPS].sort((a, b) => a - b).join(", ")}] — 3 guest swaps verified`,
);
