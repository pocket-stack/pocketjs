// site/record-sim-clips.ts — records clean "emulator" clips of the in-repo
// demos for the hero demo wall: no camera, no hands, no hardware. The wasm
// core renders every frame headlessly (the same deterministic boot as
// tools/tape.ts / tests/golden.ts), driven by a scripted button tape, and
// the raw RGBA frames are piped straight into ffmpeg.
//
//   bun site/record-sim-clips.ts             # record every wall clip
//   bun site/record-sim-clips.ts hero-main   # record one app
//
// Output: site/.cache/demo-wall/sim/<app>.mp4 — 480x272, 24 s @ 30 fps
// (every 2nd sim frame of the fixed-60 Hz clock), near-lossless so the wall
// bake (site/bake-demo-wall.ts) is the only lossy generation.
//
// Each app runs in a SUBPROCESS: eval'ing one bundle per process keeps the
// runtimes from ever sharing globals.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { BTN, SCREEN_H, SCREEN_W } from "../spec/spec.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = ROOT + "site/";
const SIM_DIR = SITE + ".cache/demo-wall/sim/";
const BUILD_DIST = SITE + ".cache/demo-wall/sim-build/";
const WASM_PATH = ROOT + "hosts/web/pocketjs.wasm";

const DUR_S = 24; // must match bake-demo-wall.ts DUR
const SIM_HZ = 60;
const OUT_FPS = 30; // every 2nd sim frame
const FRAMES = DUR_S * SIM_HZ;

// 24-second interaction scripts, one per app — golden-specs.ts pulses
// stretched to a full loop. A returned mask applies to THAT frame only, so
// holds are expressed as ranges (exactly like tests/golden-specs.ts).
type Script = (f: number) => number;
export const WALL_APPS: Record<string, Script> = {
  // "JSX at 60 FPS" card: focus the button, then keep the counter ticking.
  "hero-main": (f) =>
    f === 8 ? BTN.DOWN : f >= 60 && f <= 1380 && (f - 60) % 90 === 0 ? BTN.CIRCLE : 0,
  // EVERGREEN grid -> play a track -> browse -> next track via the trigger.
  "music-main": (f) =>
    f === 60 ? BTN.DOWN
    : f === 120 ? BTN.CIRCLE
    : f === 420 || f === 480 ? BTN.DOWN
    : f === 540 ? BTN.CIRCLE
    : f === 840 ? BTN.RTRIGGER
    : f === 1080 ? BTN.DOWN
    : f === 1200 ? BTN.RTRIGGER
    : 0,
  // Photo gallery: pick a tile, then page with the shoulders.
  "gallery-main": (f) =>
    f === 100 ? BTN.RIGHT
    : f === 160 ? BTN.CIRCLE
    : f === 320 || f === 560 || f === 800 ? BTN.RTRIGGER
    : f === 1040 ? BTN.LTRIGGER
    : f === 1280 ? BTN.RTRIGGER
    : 0,
  // Settings: walk the list, flip toggles, ride the brightness slider.
  "settings-main": (f) => {
    const step = f % 720; // run the golden walk twice
    return step === 40 ? BTN.DOWN
      : step === 100 ? BTN.CIRCLE
      : step === 160 ? BTN.DOWN
      : step === 220 ? BTN.CIRCLE
      : step === 280 ? BTN.DOWN
      : step === 340 ? BTN.CIRCLE
      : step === 400 || step === 440 || step === 480 ? BTN.DOWN
      : step === 540 ? BTN.CIRCLE
      : step === 620 ? BTN.UP
      : 0;
  },
  // Mission Control: tab across the dashboard panels.
  "stats-main": (f) => (f > 0 && f % 300 === 0 ? BTN.RIGHT : 0),
  // Game Library: browse covers, open a game, back out, open another.
  "library-main": (f) =>
    f === 60 || f === 120 ? BTN.RIGHT
    : f === 240 ? BTN.CIRCLE
    : f === 640 ? BTN.TRIANGLE
    : f === 720 ? BTN.RIGHT
    : f === 840 ? BTN.CIRCLE
    : f === 1240 ? BTN.TRIANGLE
    : 0,
  // Feature Cards: slide focus across the cards, expanding as we go.
  "cards-main": (f) =>
    f === 60 || f === 120 ? BTN.RIGHT
    : f === 260 ? BTN.CIRCLE
    : f === 500 ? BTN.RIGHT
    : f === 640 ? BTN.CIRCLE
    : f === 880 ? BTN.RIGHT
    : f === 1020 ? BTN.CIRCLE
    : f === 1260 ? BTN.RIGHT
    : 0,
  // Notifications: walk the feed, act on one, keep walking.
  "notifications-main": (f) => {
    const step = f % 800;
    return step === 100 || step === 200 ? BTN.DOWN
      : step === 300 ? BTN.CIRCLE
      : step === 500 ? BTN.DOWN
      : step === 620 ? BTN.CIRCLE
      : 0;
  },
  // Pocket Talk: open a thread, scroll history, then type on the OSK and
  // send — the delivery receipt lands before the loop cut.
  "im-main": (f) =>
    f === 200 ? BTN.CIRCLE
    : f >= 300 && f < 480 ? BTN.UP
    : f === 560 ? BTN.SELECT
    : f === 660 ? BTN.TRIANGLE
    : f === 720 ? BTN.DOWN
    : f === 760 ? BTN.CIRCLE
    : f === 820 ? BTN.RIGHT
    : f === 860 ? BTN.CIRCLE
    : f === 920 ? BTN.RIGHT
    : f === 960 ? BTN.CIRCLE
    : f === 1160 ? BTN.START
    : 0,
};

function buildApp(app: string): string {
  const dist = BUILD_DIST + app + "/";
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const p = Bun.spawnSync(["bun", "tools/build.ts", app, `--outdir=${dist}`], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (p.exitCode !== 0 || !existsSync(dist + app + ".js")) {
    throw new Error(`record-sim: build failed for ${app}`);
  }
  return dist;
}

/** Same boot dance as tools/tape.ts — fresh core, bundle installs frame(). */
async function boot(app: string, dist: string) {
  if (!existsSync(WASM_PATH)) {
    const p = Bun.spawnSync(["bun", "tools/wasm.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) throw new Error("record-sim: wasm build failed");
  }
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops;
  g.__pak = existsSync(dist + app + ".pak") ? await Bun.file(dist + app + ".pak").arrayBuffer() : undefined;
  g.frame = undefined;
  g.__pocketApp = app;
  (0, eval)(await Bun.file(dist + app + ".js").text());
  const frame = g.frame as ((buttons: number) => void) | undefined;
  if (typeof frame !== "function") throw new Error(`record-sim: ${app} did not install globalThis.frame`);
  return { frame, tick: wasm.tick, render: () => wasm.render() };
}

async function recordOne(app: string): Promise<void> {
  const script = WALL_APPS[app];
  if (!script) throw new Error(`record-sim: no wall script for ${app} (known: ${Object.keys(WALL_APPS).join(", ")})`);
  const out = SIM_DIR + app + ".mp4";
  mkdirSync(SIM_DIR, { recursive: true });
  const dist = buildApp(app);
  const b = await boot(app, dist);

  const ff = Bun.spawn(
    ["ffmpeg", "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${SCREEN_W}x${SCREEN_H}`, "-framerate", String(OUT_FPS), "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", out],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  for (let f = 0; f < FRAMES; f++) {
    b.frame(script(f));
    b.tick();
    if (f % (SIM_HZ / OUT_FPS) === 0) {
      ff.stdin.write(b.render().slice());
      if (f % 120 === 0) await ff.stdin.flush();
    }
  }
  await ff.stdin.end();
  if ((await ff.exited) !== 0) throw new Error(`record-sim: ffmpeg failed for ${app}`);
  console.log(`record-sim: ${out.slice(SITE.length)} (${(Bun.file(out).size / 1024).toFixed(0)} KiB)`);
}

/** Used by bake-demo-wall.ts: subprocess-per-app so eval'd bundles never share globals. */
export function ensureSimClip(app: string): string {
  const out = SIM_DIR + app + ".mp4";
  if (existsSync(out)) return out;
  const p = Bun.spawnSync(["bun", import.meta.path, app], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(out)) throw new Error(`record-sim: recording ${app} failed`);
  return out;
}

if (import.meta.main) {
  const apps = process.argv[2] ? [process.argv[2]] : Object.keys(WALL_APPS);
  if (apps.length === 1) {
    await recordOne(apps[0]);
  } else {
    for (const app of apps) ensureSimClip(app);
  }
}
