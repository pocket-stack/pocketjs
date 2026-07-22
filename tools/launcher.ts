#!/usr/bin/env bun

// The launcher artifact chain (docs/LAUNCHER.md "Build pipeline").
//
//   bun tools/launcher.ts scan [--target psp|vita]    registry only
//   bun tools/launcher.ts covers [--target ...]       + render target-neutral covers
//   bun tools/launcher.ts build [--target ...]        + multi-app console package
//
// The embedded set is COMPUTED, never curated: every apps/*/pocket.json
// that resolves against the selected target profile (the same admission gate
// `pocket build` runs) is in, minus explicit --exclude. Covers are rendered by
// the deterministic PSP-flavored sim host, so they remain target-neutral and
// cover-bearing goldens stay stable. Vita's density-2 bundles/packages live in
// their own output tree and never overwrite the PSP/sim artifacts in dist/.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { encodePNG } from "../tests/png.ts";
import { SHOT_W, SHOT_H, downscaleShot } from "../hosts/sim/shot.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const APPS_DIR = join(ROOT, "apps");
const LAUNCHER_DIR = join(APPS_DIR, "launcher");
const COVERS_DIR = join(LAUNCHER_DIR, "covers");
const IMAGES_JSON = join(LAUNCHER_DIR, "images.json");
const REGISTRY_TS = join(LAUNCHER_DIR, "registry.generated.ts");
const LAUNCHER_MANIFEST = join(LAUNCHER_DIR, "pocket.json");

export type LauncherTarget = "psp" | "vita";

interface LauncherPaths {
  /** Target-flavored JS/pak output. PSP stays in dist/ for sim/site compatibility. */
  output: string;
  /** Target-thinned .pocket files consumed verbatim by the native host. */
  packages: string;
  registryJson: string;
  registryTsv: string;
}

function launcherPaths(target: LauncherTarget): LauncherPaths {
  if (target === "psp") {
    return {
      output: join(ROOT, "dist"),
      packages: join(ROOT, "dist/packages"),
      registryJson: join(ROOT, "dist/launcher-registry.json"),
      registryTsv: join(ROOT, "dist/launcher-registry.tsv"),
    };
  }
  const output = join(ROOT, "dist/launcher/vita");
  return {
    output,
    packages: join(output, "packages"),
    registryJson: join(output, "launcher-registry.json"),
    registryTsv: join(output, "launcher-registry.tsv"),
  };
}

/** Frames the sim settles before the cover render: boot springs and stagger
 *  animations land, steady state does not drift (fixed dt, mask 0). */
const COVER_SETTLE_FRAMES = 90;

/** Fade the outer 2 px of a cover to transparent. With bilinear sampling on,
 *  the card's polygon edge then blends out through the ring instead of
 *  cutting a hard aliased line — the poor console's MSAA. */
function transparentRing(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const ring = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (d >= ring) continue;
      const o = (y * w + x) * 4;
      const a = d / ring; // 0 at the border, 1 at the ring's inner edge
      rgba[o] = Math.round(rgba[o] * a);
      rgba[o + 1] = Math.round(rgba[o + 1] * a);
      rgba[o + 2] = Math.round(rgba[o + 2] * a);
      rgba[o + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

export interface LauncherRegistryEntry {
  output: string;
  id: string;
  title: string;
  /** Manifest path, repo-root-relative (hosts/psp/build.rs never reads it —
   *  it is for humans and for `covers` to rebuild a stale dist). */
  manifest: string;
}

export interface LauncherRegistry {
  apps: LauncherRegistryEntry[];
}

function usage(message?: string): never {
  if (message) console.error(`launcher: ${message}`);
  console.error(
    "usage: bun tools/launcher.ts <scan|covers|pack|build> [--target psp|vita] [--exclude <output>]... [--force] [-- backend args]",
  );
  process.exit(1);
}

function scanRegistryForTarget(
  exclude: ReadonlySet<string>,
  target: LauncherTarget,
  logSkips: boolean,
): LauncherRegistry {
  const apps: LauncherRegistryEntry[] = [];
  const seen = new Map<string, string>();
  for (const dir of readdirSync(APPS_DIR).sort()) {
    if (dir === "launcher") continue; // the launcher never lists itself
    const manifestPath = join(APPS_DIR, dir, "pocket.json");
    if (!existsSync(manifestPath)) continue;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const resolution = validateAndResolveBuildPlan(manifest, { target });
    if (!resolution.ok) {
      const codes = resolution.diagnostics.map((d) => d.code).join(", ");
      if (logSkips)
        console.log(`  skip ${dir}: not ${target}-admissible (${codes})`);
      continue;
    }
    const { output, id, title } = resolution.plan.app;
    if (exclude.has(output)) {
      if (logSkips) console.log(`  skip ${dir}: excluded (${output})`);
      continue;
    }
    const prev = seen.get(output);
    if (prev) {
      if (logSkips)
        console.log(`  skip ${dir}: duplicate output ${output} (kept ${prev})`);
      continue;
    }
    seen.set(output, dir);
    apps.push({ output, id, title, manifest: relative(ROOT, manifestPath) });
  }
  apps.sort((a, b) =>
    a.title < b.title
      ? -1
      : a.title > b.title
        ? 1
        : a.output < b.output
          ? -1
          : 1,
  );
  return { apps };
}

/** Admission sweep: every app pocket.json that resolves for the target. */
export function scanRegistry(
  exclude: ReadonlySet<string>,
  target: LauncherTarget = "psp",
): LauncherRegistry {
  return scanRegistryForTarget(exclude, target, true);
}

/**
 * Display metadata is target-neutral and committed in one generated module.
 * Keep it as the PSP/Vita union so running a Vita build can never leave the
 * common source tree in a Vita-only state. Each native host still reports the
 * target-admitted subset through appTable(), and the launcher intersects it.
 */
export function scanDisplayRegistry(
  exclude: ReadonlySet<string>,
): LauncherRegistry {
  const byOutput = new Map<string, LauncherRegistryEntry>();
  for (const target of ["psp", "vita"] as const) {
    for (const app of scanRegistryForTarget(exclude, target, false).apps) {
      byOutput.set(app.output, app);
    }
  }
  const apps = [...byOutput.values()].sort((a, b) =>
    a.title < b.title
      ? -1
      : a.title > b.title
        ? 1
        : a.output < b.output
          ? -1
          : 1,
  );
  return { apps };
}

function writeRegistry(
  targetRegistry: LauncherRegistry,
  displayRegistry: LauncherRegistry,
  paths: LauncherPaths,
): void {
  mkdirSync(paths.output, { recursive: true });
  writeFileSync(
    paths.registryJson,
    JSON.stringify(targetRegistry, null, 2) + "\n",
  );
  // The native build's twin (hosts/psp/build.rs): output\tid\ttitle per line —
  // no JSON parser inside a build script.
  writeFileSync(
    paths.registryTsv,
    targetRegistry.apps
      .map((a) => `${a.output}\t${a.id}\t${a.title}\n`)
      .join(""),
  );
  const lines = [
    "// GENERATED by tools/launcher.ts scan — do not edit by hand; COMMIT",
    "// the regenerated file (tests/launcher-sim.test.ts asserts freshness).",
    "// The display-side PSP/Vita union: the launcher app imports it for",
    "// titles + cover asset keys; each host's target-specific appTable",
    "// (spec op 39) stays the runtime truth for what is embedded.",
    "",
    "export interface RegistryApp {",
    "  output: string;",
    "  id: string;",
    "  title: string;",
    "  /** Pak image asset of the 256×128 cover. The literal paths below are",
    "   *  what the build's asset collector picks up and bakes. */",
    "  cover: string;",
    "  /** The cover's baked reflection (mirrored + alpha falloff), drawn as",
    "   *  its own quad so the seam stays a geometric straight edge. */",
    "  refl: string;",
    "}",
    "",
    "export const REGISTRY: readonly RegistryApp[] = [",
    ...displayRegistry.apps.map(
      (a) =>
        `  { output: ${JSON.stringify(a.output)}, id: ${JSON.stringify(a.id)}, title: ${JSON.stringify(
          a.title,
        )}, cover: ${JSON.stringify(`covers/cover-${a.output}.png`)}, refl: ${JSON.stringify(
          `covers/refl-${a.output}.png`,
        )} },`,
    ),
    "] as const;",
    "",
  ];
  mkdirSync(LAUNCHER_DIR, { recursive: true });
  writeFileSync(REGISTRY_TS, lines.join("\n"));
  // Static-image meta for tools/build.ts: every cover samples bilinear
  // (IMG_FLAG_LINEAR) — the deck rotates and scales them, nearest shimmers.
  // Committed alongside registry.generated.ts, same freshness story.
  const images: Record<string, { linear: boolean }> = {
    "covers/launcher-bg.png": { linear: true },
  };
  for (const a of displayRegistry.apps) {
    images[`covers/cover-${a.output}.png`] = { linear: true };
    // Reflections stay 8888: their whole point is a smooth alpha ramp, and
    // PSM_4444's 4-bit alpha gives the 0.3→0 fade only ~5 steps — visible
    // horizontal banding on hardware. Quarter-res keeps them cheap (32 KB).
    images[`covers/refl-${a.output}.png`] = { linear: true };
  }
  writeFileSync(IMAGES_JSON, JSON.stringify(images, null, 2) + "\n");
}

async function compileApp(
  manifest: string,
  target: LauncherTarget,
  output: string,
): Promise<void> {
  const p = Bun.spawnSync(
    [
      "bun",
      "tools/pocket.ts",
      "compile",
      "--target",
      target,
      "--manifest",
      manifest,
      "--project-root",
      ".",
      "--outdir",
      relative(ROOT, output),
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0)
    throw new Error(`launcher: compile failed for ${manifest}`);
}

/** Deterministic stand-in for apps the sim cannot boot (today: vue-vapor
 *  bundles, whose runtime has no sim mount path): a hue keyed to the output
 *  name, vertical two-stop gradient, darker frame. */
function fallbackCover(output: string): Uint8Array {
  let h = 0x811c9dc5;
  for (let i = 0; i < output.length; i++) {
    h ^= output.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = ((h >>> 0) % 360) / 360;
  const rgb = (l: number): [number, number, number] => {
    // HSL with s=0.45, single-formula channel; enough for a placeholder.
    const s = 0.45;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const chan = (t: number) => {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [chan(hue + 1 / 3), chan(hue), chan(hue - 1 / 3)].map((v) =>
      Math.round(v * 255),
    ) as [number, number, number];
  };
  const top = rgb(0.32);
  const bottom = rgb(0.16);
  const out = new Uint8Array(SHOT_W * SHOT_H * 4);
  for (let y = 0; y < SHOT_H; y++) {
    const t = y / (SHOT_H - 1);
    const edge = y < 2 || y >= SHOT_H - 2;
    for (let x = 0; x < SHOT_W; x++) {
      const o = (y * SHOT_W + x) * 4;
      const dim = edge || x < 2 || x >= SHOT_W - 2 ? 0.6 : 1;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round((top[c] + (bottom[c] - top[c]) * t) * dim);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The deck's stage, baked: the Cover Flow-era look — black floor, a cool
 *  Aqua glow behind the center card, a faint sheen where the cards stand.
 *  Default 256×128 (stretched to the screen with bilinear — gradients
 *  survive that perfectly); full-res for the XMB PIC1. Pure math,
 *  deterministic. */
function stageBackground(w = SHOT_W, h = SHOT_H): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  // In stretched-screen space the deck centers at ~(240, 106)/480×272.
  const cx = (240 / 480) * w;
  const cy = (106 / 272) * h;
  const glowR = w * 0.52;
  const floorY = (160 / 272) * h;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    // Vertical base: near-black slate up top -> pure black floor.
    const base: [number, number, number] =
      t < 0.55
        ? [
            19 + (7 - 19) * (t / 0.55),
            26 + (10 - 26) * (t / 0.55),
            36 + (16 - 36) * (t / 0.55),
          ]
        : [
            7 * (1 - (t - 0.55) / 0.45),
            10 * (1 - (t - 0.55) / 0.45),
            16 * (1 - (t - 0.55) / 0.45),
          ];
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / glowR;
      const dy = (y - cy) / (glowR * 0.75);
      const glow = Math.max(0, 1 - (dx * dx + dy * dy));
      const g15 = glow * Math.sqrt(glow); // ^1.5 falloff, soft center
      // Floor sheen: a horizontal band fading down from the card line.
      const fy = (y - floorY) / (h - floorY);
      const sheen = y >= floorY ? (1 - fy) * (1 - fy) * (0.4 + 0.6 * glow) : 0;
      const o = (y * w + x) * 4;
      out[o] = Math.min(255, Math.round(base[0] + 26 * g15 + 12 * sheen));
      out[o + 1] = Math.min(255, Math.round(base[1] + 36 * g15 + 16 * sheen));
      out[o + 2] = Math.min(255, Math.round(base[2] + 52 * g15 + 24 * sheen));
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The classic Cover Flow reflection, BAKED as its OWN 256×128 texture: the
 *  cover vertically mirrored with an alpha falloff (≈30% at the seam, gone
 *  ~60% down). It is drawn as a SEPARATE quad stacked under the cover in
 *  the same rotating container — the seam is then a shared GEOMETRIC edge
 *  and stays a straight line. (Baking both halves into one tall quad put
 *  the seam mid-quad, where the GE's screen-space affine sampling bends
 *  texture lines at the triangle diagonal on tilted cards — a real-PSP
 *  find; the sim's centered card never shows it.) */
/** Reflections are faint by definition, so they ship QUARTER-res (128×64,
 *  32 KB a card instead of 128 KB — the full-res first cut OOM'd the PSP:
 *  ~2 MB of extra texture heap tipped the arena over and boot parked on the
 *  OOM handler; sim RAM never notices). They stay PSM_8888 though: the fade
 *  needs the 8-bit alpha ramp (4444 banded visibly on hardware). */
const REFL_W = SHOT_W / 2;
const REFL_H = SHOT_H / 2;

function reflectionOf(cover: Uint8Array): Uint8Array {
  const small = resizeBilinear(cover, SHOT_W, SHOT_H, REFL_W, REFL_H);
  const out = new Uint8Array(REFL_W * REFL_H * 4);
  const strength = 0.3;
  const fadeRows = 37;
  for (let k = 0; k < fadeRows; k++) {
    const f = strength * Math.pow(1 - k / fadeRows, 1.7);
    const src = (REFL_H - 1 - k) * REFL_W * 4;
    const dst = k * REFL_W * 4;
    for (let x = 0; x < REFL_W; x++) {
      out[dst + x * 4] = small[src + x * 4];
      out[dst + x * 4 + 1] = small[src + x * 4 + 1];
      out[dst + x * 4 + 2] = small[src + x * 4 + 2];
      out[dst + x * 4 + 3] = Math.round(small[src + x * 4 + 3] * f);
    }
  }
  return out;
}

async function renderCovers(
  registry: LauncherRegistry,
  force: boolean,
): Promise<void> {
  mkdirSync(COVERS_DIR, { recursive: true });
  const bgPath = join(COVERS_DIR, "launcher-bg.png");
  if (force || !existsSync(bgPath)) {
    await Bun.write(bgPath, encodePNG(stageBackground(), SHOT_W, SHOT_H));
    console.log(`  stage ${relative(ROOT, bgPath)}`);
  }
  // Import lazily: bootWorld pulls the wasm core + build machinery, which
  // `scan` alone must not need.
  const { bootWorld } = await import("../hosts/sim/sim.ts");
  for (const app of registry.apps) {
    const coverPath = join(COVERS_DIR, `cover-${app.output}.png`);
    const reflPath = join(COVERS_DIR, `refl-${app.output}.png`);
    if (!force && existsSync(coverPath) && existsSync(reflPath)) continue;
    if (force || !existsSync(join(ROOT, "dist", `${app.output}.js`))) {
      // The deterministic sim is the PSP-flavored 480x272 oracle. Covers are
      // distribution metadata, not a target raster variant; Vita consumes the
      // same 256x128 PNG from its own density-2 launcher pak. Prefer the PSP
      // bundle; a future Vita-only app still gets cover metadata through the
      // injected sim host without making the common registry target-specific.
      const manifest = JSON.parse(
        readFileSync(join(ROOT, app.manifest), "utf8"),
      );
      const coverTarget: LauncherTarget = validateAndResolveBuildPlan(
        manifest,
        { target: "psp" },
      ).ok
        ? "psp"
        : "vita";
      await compileApp(app.manifest, coverTarget, join(ROOT, "dist"));
    }
    let shot: Uint8Array;
    try {
      const world = await bootWorld(app.output, 60);
      for (let f = 0; f < COVER_SETTLE_FRAMES; f++) {
        world.frame(0);
        for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
      }
      shot = downscaleShot(world.render());
      console.log(`  cover ${app.output} -> ${relative(ROOT, coverPath)}`);
    } catch (error) {
      shot = fallbackCover(app.output);
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `  cover ${app.output} -> fallback gradient (sim boot failed: ${message})`,
      );
    }
    const ringed = transparentRing(shot, SHOT_W, SHOT_H);
    await Bun.write(coverPath, encodePNG(ringed, SHOT_W, SHOT_H));
    await Bun.write(
      join(COVERS_DIR, `refl-${app.output}.png`),
      encodePNG(reflectionOf(ringed), REFL_W, REFL_H),
    );
  }
}

/** Generic bilinear resample (art assets only — the deck textures use the
 *  fixed-size shot path). Also used by tools/psp.ts to bake the switch
 *  veil's logo texture. */
export function resizeBilinear(
  rgba: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.min(sh - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top =
          rgba[(y0 * sw + x0) * 4 + c] +
          (rgba[(y0 * sw + x1) * 4 + c] - rgba[(y0 * sw + x0) * 4 + c]) * fx;
        const bot =
          rgba[(y1 * sw + x0) * 4 + c] +
          (rgba[(y1 * sw + x1) * 4 + c] - rgba[(y1 * sw + x0) * 4 + c]) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return out;
}

/** XMB identity (cargo-psp packs apps/launcher/psp/Psp.toml): ICON0 is the
 *  REAL deck — a settled sim render resized to 144×80 — and PIC1 is the
 *  stage gradient at full 480×272. Deterministic; the outputs are committed
 *  (small, and single-app `bun run hw launcher` builds need them present). */
async function renderXmbArt(): Promise<void> {
  const pspDir = join(LAUNCHER_DIR, "psp");
  mkdirSync(pspDir, { recursive: true });
  const { bootWorld } = await import("../hosts/sim/sim.ts");
  const world = await bootWorld("launcher-main", 60);
  for (let f = 0; f < 60; f++) {
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  }
  const icon = resizeBilinear(world.render(), 480, 272, 144, 80);
  for (let i = 3; i < icon.length; i += 4) icon[i] = 255;
  await Bun.write(join(pspDir, "icon0.png"), encodePNG(icon, 144, 80));
  await Bun.write(
    join(pspDir, "pic1.png"),
    encodePNG(stageBackground(480, 272), 480, 272),
  );
  console.log("  xmb art: apps/launcher/psp/{icon0,pic1}.png");
}

/** Emit one target-thinned package per embedded app from ALREADY-BUILT dists.
 *  Native hosts embed these files verbatim and select their target variant
 *  through engine/core/src/package.rs. The standalone multi-target packer
 *  remains tools/pocket-pack.ts. */
async function packPackages(
  registry: LauncherRegistry,
  target: LauncherTarget,
  paths: LauncherPaths,
): Promise<void> {
  const { makeVariant } = await import("./pocket-pack.ts");
  const { encodePocketPackage } = await import("../contracts/spec/pocket-package.ts");
  const { canonicalJson } = await import("../framework/src/manifest/plan.ts");
  const { validateAndResolveBuildPlan } =
    await import("../framework/src/manifest/resolve.ts");
  mkdirSync(paths.packages, { recursive: true });
  const entries = [
    { manifest: relative(ROOT, LAUNCHER_MANIFEST) },
    ...registry.apps.map((a) => ({ manifest: a.manifest })),
  ];
  for (const entry of entries) {
    const manifestBytes = readFileSync(join(ROOT, entry.manifest));
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    const resolution = validateAndResolveBuildPlan(manifest, { target });
    if (!resolution.ok) {
      throw new Error(
        `launcher pack: ${entry.manifest} no longer admits ${target}`,
      );
    }
    const plan = resolution.plan;
    const js = new Uint8Array(
      readFileSync(join(paths.output, `${plan.app.output}.js`)),
    );
    const pakPath = join(paths.output, `${plan.app.output}.pak`);
    const pak = existsSync(pakPath)
      ? new Uint8Array(readFileSync(pakPath))
      : new Uint8Array(0);
    const coverPath = join(COVERS_DIR, `cover-${plan.app.output}.png`);
    const bytes = encodePocketPackage({
      manifest: new Uint8Array(manifestBytes),
      variants: [
        makeVariant({
          target,
          hostAbi: plan.target.hostAbi,
          planJson: canonicalJson(plan),
          identity: {
            output: plan.app.output,
            id: plan.app.id,
            title: plan.app.title,
          },
          js,
          pak,
          cover: existsSync(coverPath)
            ? new Uint8Array(readFileSync(coverPath))
            : undefined,
        }),
      ],
    });
    writeFileSync(join(paths.packages, `${plan.app.output}.pocket`), bytes);
  }
  console.log(
    `launcher: ${entries.length} ${target} package(s) -> ${relative(ROOT, paths.packages)}/`,
  );
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const command = argv.shift();
  if (
    command !== "scan" &&
    command !== "covers" &&
    command !== "pack" &&
    command !== "build"
  )
    usage();
  const exclude = new Set<string>();
  let force = false;
  let target: LauncherTarget = "psp";
  const separator = argv.indexOf("--");
  const backendArgs = separator >= 0 ? argv.splice(separator + 1) : [];
  if (separator >= 0) argv.splice(separator, 1);
  while (argv.length) {
    const arg = argv.shift()!;
    if (arg === "--exclude") {
      const value = argv.shift();
      if (!value) usage("--exclude requires an output name");
      exclude.add(value);
    } else if (arg === "--target") {
      const value = argv.shift();
      if (value !== "psp" && value !== "vita")
        usage("--target must be psp or vita");
      target = value;
    } else if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (value !== "psp" && value !== "vita")
        usage("--target must be psp or vita");
      target = value;
    } else if (arg === "--force") {
      force = true;
    } else {
      usage(`unknown option ${arg}`);
    }
  }

  const paths = launcherPaths(target);
  console.log(
    `launcher: scanning apps/*/pocket.json against target ${target}`,
  );
  const registry = scanRegistry(exclude, target);
  const displayRegistry = scanDisplayRegistry(exclude);
  writeRegistry(registry, displayRegistry, paths);
  console.log(
    `launcher: ${registry.apps.length} ${target} app(s) admitted -> ${relative(ROOT, paths.registryJson)}`,
  );
  for (const app of registry.apps) {
    const js = join(paths.output, `${app.output}.js`);
    const pak = join(paths.output, `${app.output}.pak`);
    const size = (p: string) => (existsSync(p) ? Bun.file(p).size : 0);
    const total = size(js) + size(pak);
    console.log(
      `  ${app.output.padEnd(24)} ${app.title.padEnd(28)} ${total ? (total / 1024).toFixed(0) + " KB" : "(not built)"}`,
    );
  }
  if (command === "scan") return;

  console.log(
    "launcher: rendering common covers (PSP-flavored sim, deterministic)",
  );
  await renderCovers(displayRegistry, force);
  if (command === "covers") return;

  console.log(
    `launcher: compiling ${target} app dists -> ${relative(ROOT, paths.output)}/`,
  );
  for (const app of registry.apps) {
    if (force || !existsSync(join(paths.output, `${app.output}.js`))) {
      await compileApp(app.manifest, target, paths.output);
    }
  }
  console.log(`launcher: compiling the ${target} launcher app`);
  await compileApp(relative(ROOT, LAUNCHER_MANIFEST), target, paths.output);
  console.log(`launcher: packing ${target} .pocket files`);
  await packPackages(registry, target, paths);
  if (command === "pack") return;

  if (target === "psp") {
    console.log("launcher: rendering XMB art");
    await renderXmbArt();
  }
  console.log(
    `launcher: building the multi-app ${target === "psp" ? "EBOOT" : "VPK"}`,
  );
  const targetBackendArgs =
    target === "vita"
      ? [
          `--launcher-packages=${relative(ROOT, paths.packages)}`,
          `--package-outdir=${relative(ROOT, join(ROOT, "dist/vita"))}`,
        ]
      : [];
  const p = Bun.spawnSync(
    [
      "bun",
      "tools/pocket.ts",
      "build",
      "--target",
      target,
      "--manifest",
      relative(ROOT, LAUNCHER_MANIFEST),
      "--project-root",
      ".",
      "--outdir",
      relative(ROOT, paths.output),
      "--",
      `--launcher-registry=${relative(ROOT, paths.registryTsv)}`,
      ...targetBackendArgs,
      ...backendArgs,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0)
    throw new Error(`launcher: ${target} backend build failed`);
}

if (import.meta.main) {
  await main();
}
