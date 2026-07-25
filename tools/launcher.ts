#!/usr/bin/env bun

// The launcher artifact chain (docs/LAUNCHER.md "Build pipeline").
//
//   bun tools/launcher.ts scan [--target psp|vita|symbian] registry only
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
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { encodePNG } from "../tests/png.ts";
import { SHOT_W, SHOT_H, downscaleShot } from "../hosts/sim/shot.ts";
import {
  SYMBIAN_E7_DEFAULT_VIEWPORT,
  SYMBIAN_E7_DEV_CONTRACTS,
  SYMBIAN_E7_DEV_TARGET_ID,
  SYMBIAN_E7_MAX_VIEWPORT,
  SYMBIAN_E7_MIN_VIEWPORT,
} from "./symbian-profile.ts";
import {
  buildApp as buildSymbianApp,
  withSymbianBuildTransaction,
  type SymbianBuildTransaction,
} from "./symbian.ts";
import {
  SYMBIAN_TOOLCHAIN,
  withSymbianGuestBuildLock,
} from "./symbian-toolchain.ts";
import {
  pocketStackCacheRoot,
  withArtifactLock,
} from "./psp-toolchain.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const APPS_DIR = join(ROOT, "apps");
const LAUNCHER_DIR = join(APPS_DIR, "launcher");
const COVERS_DIR = join(LAUNCHER_DIR, "covers");
const IMAGES_JSON = join(LAUNCHER_DIR, "images.json");
const REGISTRY_TS = join(LAUNCHER_DIR, "registry.generated.ts");
const LAUNCHER_MANIFEST = join(LAUNCHER_DIR, "pocket.json");

/**
 * registry.generated.ts and images.json are shared source-tree inputs for every
 * target. Hold one checkout-wide lock across scan/cover/compile/package work so
 * a concurrent PSP/Vita command cannot replace a Symbian external-app registry
 * between its catalog and launcher bundle steps.
 */
export async function withLauncherSourceLock<T>(
  operation: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const checkoutId = createHash("sha256").update(ROOT).digest("hex");
  return await withArtifactLock(
    join(
      pocketStackCacheRoot(env),
      "launcher/.locks",
      checkoutId,
      "generated-source.lock",
    ),
    operation,
    {
      timeoutMs: 60 * 60_000,
      staleMs: 2 * 60 * 60_000,
    },
  );
}

let generatedSourceBackup:
  | { registry: Uint8Array; images: Uint8Array }
  | undefined;

function backupGeneratedSources(): void {
  if (generatedSourceBackup) return;
  generatedSourceBackup = {
    registry: new Uint8Array(readFileSync(REGISTRY_TS)),
    images: new Uint8Array(readFileSync(IMAGES_JSON)),
  };
}

function restoreGeneratedSources(): void {
  if (!generatedSourceBackup) return;
  writeFileSync(REGISTRY_TS, generatedSourceBackup.registry);
  writeFileSync(IMAGES_JSON, generatedSourceBackup.images);
  generatedSourceBackup = undefined;
}

export type LauncherTarget = "psp" | "vita" | typeof SYMBIAN_E7_DEV_TARGET_ID;

interface LauncherPaths {
  /** Target-flavored JS/pak output. PSP stays in dist/ for sim/site compatibility. */
  output: string;
  /** Target-thinned .pocket files consumed verbatim by the native host. */
  packages: string;
  registryJson: string;
  registryTsv: string;
  catalogIndex?: string;
  catalogBlob?: string;
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
  const targetDirectory = target === "vita" ? "vita" : "symbian";
  const output = join(ROOT, "dist/launcher", targetDirectory);
  return {
    output,
    packages: join(output, "packages"),
    registryJson: join(output, "launcher-registry.json"),
    registryTsv: join(output, "launcher-registry.tsv"),
    ...(target === SYMBIAN_E7_DEV_TARGET_ID
      ? {
          catalogIndex: join(output, "catalog.tsv"),
          catalogBlob: join(output, "catalog.bin"),
        }
      : {}),
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
  /** Build root for an explicitly included external manifest. Omitted for
   * repository-owned apps so committed/default registries stay portable. */
  projectRoot?: string;
}

export interface LauncherRegistry {
  apps: LauncherRegistryEntry[];
}

function usage(message?: string): never {
  if (message) console.error(`launcher: ${message}`);
  console.error(
    "usage: bun tools/launcher.ts <scan|covers|pack|build> [--target psp|vita|symbian] [--exclude <output>]... [--include-manifest <external/pocket.json>]... [--force] [-- backend args]",
  );
  process.exit(1);
}

function manifestPath(entry: Pick<LauncherRegistryEntry, "manifest" | "projectRoot">): string {
  return isAbsolute(entry.manifest)
    ? entry.manifest
    : resolve(entry.projectRoot ?? ROOT, entry.manifest);
}

function projectRoot(entry: Pick<LauncherRegistryEntry, "manifest" | "projectRoot">): string {
  return resolve(entry.projectRoot ?? ROOT);
}

function launcherManifestForTarget(target: LauncherTarget): unknown {
  const manifest = JSON.parse(readFileSync(LAUNCHER_MANIFEST, "utf8")) as {
    engine: {
      capabilities: {
        enhances?: string[];
      };
    };
    app: {
      viewport: Record<string, unknown>;
    };
  };
  if (target === SYMBIAN_E7_DEV_TARGET_ID) {
    manifest.engine.capabilities.enhances = [
      ...(manifest.engine.capabilities.enhances ?? []),
      "display.viewport.live",
      "input.touch",
    ];
    manifest.app.viewport.dynamic = {
      default: SYMBIAN_E7_DEFAULT_VIEWPORT,
      min: SYMBIAN_E7_MIN_VIEWPORT,
      max: SYMBIAN_E7_MAX_VIEWPORT,
    };
  }
  return manifest;
}

function launcherBuildEntry(
  target: LauncherTarget,
  paths: LauncherPaths,
): Pick<LauncherRegistryEntry, "manifest" | "projectRoot"> {
  if (target !== SYMBIAN_E7_DEV_TARGET_ID) {
    return { manifest: relative(ROOT, LAUNCHER_MANIFEST) };
  }
  const generatedManifest = join(
    paths.output,
    ".manifests",
    "launcher.symbian.pocket.json",
  );
  mkdirSync(dirname(generatedManifest), { recursive: true });
  writeFileSync(
    generatedManifest,
    JSON.stringify(launcherManifestForTarget(target), null, 2) + "\n",
  );
  return { manifest: generatedManifest, projectRoot: ROOT };
}

function inferExternalProjectRoot(
  absoluteManifest: string,
  entry: string,
): string {
  let candidate = dirname(absoluteManifest);
  while (true) {
    if (existsSync(resolve(candidate, entry))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(
        `launcher: cannot find external entry ${entry} above ${absoluteManifest}`,
      );
    }
    candidate = parent;
  }
}

function resolveForTarget(
  manifest: unknown,
  target: LauncherTarget,
): ReturnType<typeof validateAndResolveBuildPlan> {
  return validateAndResolveBuildPlan(
    manifest,
    { target },
    target === SYMBIAN_E7_DEV_TARGET_ID
      ? SYMBIAN_E7_DEV_CONTRACTS
      : undefined,
  );
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
    const resolution = resolveForTarget(manifest, target);
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

export function includeExternalManifests(
  registry: LauncherRegistry,
  manifests: readonly string[],
  exclude: ReadonlySet<string>,
  target: LauncherTarget,
  launcher?: Pick<LauncherRegistryEntry, "manifest" | "projectRoot">,
): LauncherRegistry {
  const apps = [...registry.apps];
  const seen = new Map(apps.map((app) => [app.output, app.manifest]));
  const seenIds = new Map(apps.map((app) => [app.id, app.manifest]));
  const launcherManifest = launcher
    ? JSON.parse(readFileSync(manifestPath(launcher), "utf8"))
    : launcherManifestForTarget(target);
  const launcherResolution = resolveForTarget(launcherManifest, target);
  if (!launcherResolution.ok) {
    throw new Error(`launcher: launcher manifest does not admit ${target}`);
  }
  seen.set(
    launcherResolution.plan.app.output,
    relative(ROOT, LAUNCHER_MANIFEST),
  );
  seenIds.set(
    launcherResolution.plan.app.id,
    relative(ROOT, LAUNCHER_MANIFEST),
  );
  for (const requested of manifests) {
    const absoluteManifest = resolve(requested);
    if (!existsSync(absoluteManifest)) {
      throw new Error(`launcher: external manifest is missing: ${absoluteManifest}`);
    }
    const manifest: unknown = JSON.parse(readFileSync(absoluteManifest, "utf8"));
    const resolution = resolveForTarget(manifest, target);
    if (!resolution.ok) {
      const codes = resolution.diagnostics.map((diagnostic) => diagnostic.code).join(", ");
      throw new Error(
        `launcher: external manifest ${absoluteManifest} is not ${target}-admissible (${codes})`,
      );
    }
    const { output, id, title } = resolution.plan.app;
    if (exclude.has(output)) continue;
    const previous = seen.get(output);
    if (previous) {
      throw new Error(
        `launcher: external output ${output} duplicates ${previous}`,
      );
    }
    const previousId = seenIds.get(id);
    if (previousId) {
      throw new Error(
        `launcher: external id ${id} duplicates ${previousId}`,
      );
    }
    seen.set(output, absoluteManifest);
    seenIds.set(id, absoluteManifest);
    apps.push({
      output,
      id,
      title,
      manifest: absoluteManifest,
      projectRoot: inferExternalProjectRoot(
        absoluteManifest,
        resolution.plan.app.entry,
      ),
    });
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

function mergeDisplayRegistry(
  base: LauncherRegistry,
  additions: LauncherRegistry,
): LauncherRegistry {
  const apps = new Map(base.apps.map((app) => [app.output, app]));
  for (const app of additions.apps) apps.set(app.output, app);
  return {
    apps: [...apps.values()].sort((a, b) =>
      a.title < b.title
        ? -1
        : a.title > b.title
          ? 1
          : a.output < b.output
            ? -1
            : 1,
    ),
  };
}

/**
 * Display metadata is target-neutral and committed in one generated module.
 * Keep it as the PSP/Vita/Symbian union so running any target build can never
 * leave the common source tree in a target-only state. Each native host still
 * reports the target-admitted subset through appTable(), and the launcher
 * intersects it.
 */
export function scanDisplayRegistry(
  exclude: ReadonlySet<string>,
): LauncherRegistry {
  const byOutput = new Map<string, LauncherRegistryEntry>();
  for (const target of ["psp", "vita", SYMBIAN_E7_DEV_TARGET_ID] as const) {
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
    JSON.stringify({
      apps: targetRegistry.apps.map(({ projectRoot: externalRoot, ...app }) => ({
        ...app,
        manifest: externalRoot
          ? relative(externalRoot, manifestPath({ ...app, projectRoot: externalRoot }))
          : app.manifest,
      })),
    }, null, 2) + "\n",
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
    "// The display-side PSP/Vita/Symbian union: the launcher imports it for",
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

export function needsLauncherCompile(
  outputName: string,
  target: LauncherTarget,
  outputDirectory: string,
  force: boolean,
): boolean {
  if (force || target === SYMBIAN_E7_DEV_TARGET_ID) return true;
  return !existsSync(join(outputDirectory, `${outputName}.js`)) ||
    !existsSync(join(outputDirectory, `${outputName}.pak`));
}

async function compileApp(
  app: Pick<LauncherRegistryEntry, "manifest" | "projectRoot">,
  target: LauncherTarget,
  output: string,
): Promise<void> {
  await withSymbianGuestBuildLock(async () => {
    const absoluteManifest = manifestPath(app);
    const absoluteProjectRoot = projectRoot(app);
    if (target === SYMBIAN_E7_DEV_TARGET_ID) {
      const manifestBytes = readFileSync(absoluteManifest);
      const resolution = resolveForTarget(
        JSON.parse(manifestBytes.toString("utf8")),
        target,
      );
      if (!resolution.ok) {
        throw new Error(`launcher: compile failed to resolve ${absoluteManifest}`);
      }
      const planDirectory = join(output, ".plans");
      mkdirSync(planDirectory, { recursive: true });
      const planPath = join(
        planDirectory,
        `${resolution.plan.app.output}.json`,
      );
      writeFileSync(planPath, JSON.stringify(resolution.plan, null, 2) + "\n");
      const p = Bun.spawnSync(
        [
          "bun",
          "tools/build.ts",
          `--plan=${planPath}`,
          `--project-root=${absoluteProjectRoot}`,
          `--outdir=${output}`,
        ],
        { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
      );
      if (p.exitCode !== 0) {
        throw new Error(`launcher: compile failed for ${absoluteManifest}`);
      }
      return;
    }
    const p = Bun.spawnSync(
      [
        "bun",
        "tools/pocket.ts",
        "compile",
        "--target",
        target,
        "--manifest",
        absoluteManifest,
        "--project-root",
        absoluteProjectRoot,
        "--outdir",
        output,
      ],
      { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if (p.exitCode !== 0) {
      throw new Error(`launcher: compile failed for ${absoluteManifest}`);
    }
  });
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
      // same 256x128 PNG from its own density-2 launcher pak. Prefer PSP, then
      // Vita; a Symbian-only dynamic app uses its density-1 bundle through the
      // injected sim host without making the common registry target-specific.
      const manifest = JSON.parse(
        readFileSync(manifestPath(app), "utf8"),
      );
      const coverTarget: LauncherTarget = validateAndResolveBuildPlan(
        manifest,
        { target: "psp" },
      ).ok
        ? "psp"
        : validateAndResolveBuildPlan(manifest, { target: "vita" }).ok
          ? "vita"
          : SYMBIAN_E7_DEV_TARGET_ID;
      await compileApp(app, coverTarget, join(ROOT, "dist"));
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
  launcher: Pick<LauncherRegistryEntry, "manifest" | "projectRoot">,
): Promise<void> {
  const { makeVariant } = await import("./pocket-pack.ts");
  const { encodePocketPackage } = await import("../contracts/spec/pocket-package.ts");
  const { canonicalJson } = await import("../framework/src/manifest/plan.ts");
  mkdirSync(paths.packages, { recursive: true });
  const entries = [
    launcher,
    ...registry.apps,
  ];
  for (const entry of entries) {
    const absoluteManifest = manifestPath(entry);
    const manifestBytes = readFileSync(absoluteManifest);
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    const resolution = resolveForTarget(manifest, target);
    if (!resolution.ok) {
      throw new Error(
        `launcher pack: ${absoluteManifest} no longer admits ${target}`,
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

export interface SymbianCatalogEntry {
  plan: ResolvedBuildPlan;
  packageBytes: Uint8Array;
  liveViewport: boolean;
}

export interface EncodedSymbianCatalog {
  index: Uint8Array;
  blob: Uint8Array;
}

const alignCatalogOffset = (value: number) => Math.ceil(value / 16) * 16;

function assertCatalogField(value: string, label: string): void {
  if (!value || /[\t\r\n\0]/.test(value)) {
    throw new Error(`launcher: unsafe ${label} in Symbian catalog`);
  }
}

/** Concatenate target-thinned `.pocket` files without rewriting them.
 * `catalog.tsv` is deliberately tiny enough for the Qt 4 host to parse
 * without bringing a JSON implementation into the SIS. */
export function encodeSymbianCatalog(
  entries: readonly SymbianCatalogEntry[],
): EncodedSymbianCatalog {
  if (
    entries.length < 2 ||
    entries[0]?.plan.app.id !== "dev.pocket-stack.launcher"
  ) {
    throw new Error(
      "launcher: Symbian catalog must start with the launcher and contain an app",
    );
  }

  let length = 0;
  const offsets: number[] = [];
  for (const entry of entries) {
    length = alignCatalogOffset(length);
    if (entry.packageBytes.byteLength > 0x7fffffff - length) {
      throw new Error("launcher: Symbian catalog exceeds the 2 GiB host limit");
    }
    offsets.push(length);
    length += entry.packageBytes.byteLength;
  }

  const blob = new Uint8Array(length);
  const rows: string[] = [];
  entries.forEach((entry, index) => {
    const { app, viewport } = entry.plan;
    assertCatalogField(app.output, "output");
    assertCatalogField(app.id, "app id");
    assertCatalogField(app.title, "title");
    blob.set(entry.packageBytes, offsets[index]!);
    rows.push(
      [
        app.output,
        app.id,
        app.title,
        offsets[index],
        entry.packageBytes.byteLength,
        viewport.logical[0],
        viewport.logical[1],
        entry.liveViewport ? "live" : "fixed",
      ].join("\t"),
    );
  });
  return {
    index: new TextEncoder().encode(rows.join("\n") + "\n"),
    blob,
  };
}

async function writeSymbianCatalog(
  registry: LauncherRegistry,
  paths: LauncherPaths,
  launcher: Pick<LauncherRegistryEntry, "manifest" | "projectRoot">,
): Promise<void> {
  if (!paths.catalogIndex || !paths.catalogBlob) {
    throw new Error("launcher: Symbian catalog paths are missing");
  }
  const {
    decodeIdentity,
    decodePocketPackage,
    findVariant,
    POCKET_SECTION,
  } =
    await import("../contracts/spec/pocket-package.ts");
  const manifests = [
    launcher,
    ...registry.apps,
  ];
  const entries: SymbianCatalogEntry[] = [];
  for (const app of manifests) {
    const absoluteManifest = manifestPath(app);
    const manifest: unknown = JSON.parse(
      readFileSync(absoluteManifest, "utf8"),
    );
    const resolution = resolveForTarget(
      manifest,
      SYMBIAN_E7_DEV_TARGET_ID,
    );
    if (!resolution.ok) {
      throw new Error(
        `launcher: ${absoluteManifest} no longer admits ${SYMBIAN_E7_DEV_TARGET_ID}`,
      );
    }
    const packagePath = join(
      paths.packages,
      `${resolution.plan.app.output}.pocket`,
    );
    const packageBytes = new Uint8Array(readFileSync(packagePath));
    const decoded = decodePocketPackage(packageBytes);
    const variant = findVariant(decoded, SYMBIAN_E7_DEV_TARGET_ID);
    if (!variant || variant.hostAbi !== resolution.plan.target.hostAbi) {
      throw new Error(
        `launcher: ${packagePath} does not match its Symbian build plan`,
      );
    }
    const identitySection = variant.sections.find(
      (section) => section.kind === POCKET_SECTION.identity,
    );
    if (!identitySection) {
      throw new Error(`launcher: ${packagePath} has no identity section`);
    }
    const identity = decodeIdentity(identitySection.bytes);
    if (
      identity.output !== resolution.plan.app.output ||
      identity.id !== resolution.plan.app.id ||
      identity.title !== resolution.plan.app.title
    ) {
      throw new Error(
        `launcher: ${packagePath} identity does not match its Symbian plan`,
      );
    }
    entries.push({
      plan: resolution.plan,
      packageBytes,
      liveViewport:
        resolution.plan.features["display.viewport.live"] === true,
    });
  }
  const catalog = encodeSymbianCatalog(entries);
  writeFileSync(paths.catalogIndex, catalog.index);
  writeFileSync(paths.catalogBlob, catalog.blob);
  console.log(
    `launcher: ${entries.length} package(s) -> ${relative(ROOT, paths.catalogBlob)}`,
  );
}

function symbianBackendOptions(args: readonly string[]): {
  sisVersion: string;
  uid?: string;
} {
  let sisVersion = SYMBIAN_TOOLCHAIN.runtime.sisVersion;
  let uid: string | undefined;
  for (let index = 0; index < args.length; ++index) {
    const argument = args[index]!;
    if (argument === "--sis-version" || argument === "--uid") {
      const value = args[++index];
      if (!value) usage(`${argument} requires a value`);
      if (argument === "--sis-version") sisVersion = value;
      else uid = value;
    } else if (argument.startsWith("--sis-version=")) {
      sisVersion = argument.slice("--sis-version=".length);
    } else if (argument.startsWith("--uid=")) {
      uid = argument.slice("--uid=".length);
    } else {
      usage(`unknown Symbian backend option ${argument}`);
    }
  }
  return { sisVersion, uid };
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
  const externalManifests: string[] = [];
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
    } else if (arg === "--include-manifest") {
      const value = argv.shift();
      if (!value) usage("--include-manifest requires a pocket.json path");
      externalManifests.push(value);
    } else if (arg.startsWith("--include-manifest=")) {
      const value = arg.slice("--include-manifest=".length);
      if (!value) usage("--include-manifest requires a pocket.json path");
      externalManifests.push(value);
    } else if (arg === "--target") {
      const value = argv.shift();
      if (
        value !== "psp" &&
        value !== "vita" &&
        value !== "symbian" &&
        value !== SYMBIAN_E7_DEV_TARGET_ID
      )
        usage("--target must be psp, vita, or symbian");
      target = value === "symbian" ? SYMBIAN_E7_DEV_TARGET_ID : value;
    } else if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (
        value !== "psp" &&
        value !== "vita" &&
        value !== "symbian" &&
        value !== SYMBIAN_E7_DEV_TARGET_ID
      )
        usage("--target must be psp, vita, or symbian");
      target = value === "symbian" ? SYMBIAN_E7_DEV_TARGET_ID : value;
    } else if (arg === "--force") {
      force = true;
    } else {
      usage(`unknown option ${arg}`);
    }
  }

  const paths = launcherPaths(target);
  if (
    externalManifests.length > 0 &&
    target !== SYMBIAN_E7_DEV_TARGET_ID
  ) {
    usage("--include-manifest is currently limited to the Symbian launcher");
  }
  const execute = async (
    symbianTransaction?: SymbianBuildTransaction,
  ): Promise<void> => {
  const launcher = launcherBuildEntry(target, paths);
  console.log(
    `launcher: scanning apps/*/pocket.json against target ${target}`,
  );
  const registry = includeExternalManifests(
    scanRegistry(exclude, target),
    externalManifests,
    exclude,
    target,
    launcher,
  );
  const displayRegistry = mergeDisplayRegistry(
    scanDisplayRegistry(exclude),
    registry,
  );
  if (externalManifests.length > 0) backupGeneratedSources();
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
    if (needsLauncherCompile(app.output, target, paths.output, force)) {
      await compileApp(app, target, paths.output);
    }
  }
  console.log(`launcher: compiling the ${target} launcher app`);
  await compileApp(launcher, target, paths.output);
  console.log(`launcher: packing ${target} .pocket files`);
  await packPackages(registry, target, paths, launcher);
  if (target === SYMBIAN_E7_DEV_TARGET_ID) {
    console.log("launcher: assembling the Symbian package catalog");
    await writeSymbianCatalog(registry, paths, launcher);
  }
  if (command === "pack") return;

  if (target === "psp") {
    console.log("launcher: rendering XMB art");
    await renderXmbArt();
  }
  console.log(`launcher: building the multi-app ${
    target === "psp"
      ? "EBOOT"
      : target === "vita"
        ? "VPK"
        : "SIS"
  }`);
  if (target === SYMBIAN_E7_DEV_TARGET_ID) {
    const backend = symbianBackendOptions(backendArgs);
    const sis = await buildSymbianApp(
      manifestPath(launcher),
      backend.sisVersion,
      {
        projectRoot: ROOT,
        outputRoot: paths.output,
        uid: backend.uid,
        catalogIndex: paths.catalogIndex!,
        catalogBlob: paths.catalogBlob!,
        transaction: symbianTransaction,
      },
    );
    console.log(`PocketJS Symbian launcher: ${sis}`);
    return;
  }
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
  };

  await withLauncherSourceLock(async () => {
    if (target === SYMBIAN_E7_DEV_TARGET_ID) {
      await withSymbianBuildTransaction(paths.output, async (transaction) => {
        try {
          await execute(transaction);
        } finally {
          restoreGeneratedSources();
        }
      });
    } else {
      await execute();
    }
  });
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    restoreGeneratedSources();
  }
}
