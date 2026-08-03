#!/usr/bin/env bun

// Experimental full-PocketJS bundle compiler for the Waveshare ESP32-P4 7B.
//
// This command stops at target-bound JavaScript + PAK artifacts. The native
// QuickJS/HostOps runtime, firmware build, flashing, and device verification
// remain separate host responsibilities.
//
//   bun tools/esp32p4.ts chrome
//   bun tools/esp32p4.ts apps/cards/pocket.json

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import {
  ESP32P4_WAVESHARE_7B_BOARD_ID,
  ESP32P4_WAVESHARE_7B_CONTENT_RECT,
  ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
  ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
  ESP32P4_WAVESHARE_7B_PANEL,
  resolveEsp32P4Waveshare7BBuildPlan,
} from "./esp32p4-profile.ts";

export const ESP32P4_FRAMEWORK_ROOT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
export const ESP32P4_BUNDLE_OUTPUT_DIRECTORY = join(
  ESP32P4_FRAMEWORK_ROOT,
  "dist/esp32p4",
);

export interface Esp32P4BundleArtifacts {
  readonly target: {
    readonly id: typeof ESP32P4_WAVESHARE_7B_DEV_TARGET_ID;
    readonly hostAbi: typeof ESP32P4_WAVESHARE_7B_DEV_HOST_ABI;
  };
  readonly board: {
    readonly id: typeof ESP32P4_WAVESHARE_7B_BOARD_ID;
    readonly panel: typeof ESP32P4_WAVESHARE_7B_PANEL;
    readonly contentRect: typeof ESP32P4_WAVESHARE_7B_CONTENT_RECT;
  };
  readonly manifestPath: string;
  readonly frameworkRoot: string;
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly planPath: string;
  readonly javascriptPath: string;
  readonly pakPath: string;
  readonly plan: ResolvedBuildPlan;
}

export interface Esp32P4BundlePlanOptions {
  /** Resolve explicit manifest paths from here. Stock app names ignore it. */
  readonly cwd?: string;
  /** Test-only checkout boundary; production callers use this repository. */
  readonly frameworkRoot?: string;
}

function isStockAppName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.endsWith(".json");
}

export function resolveEsp32P4ManifestPath(
  input: string,
  options: Esp32P4BundlePlanOptions = {},
): string {
  const value = input.trim();
  if (!value) throw new Error("pocket esp32p4: an app name or pocket.json path is required");
  const frameworkRoot = resolve(options.frameworkRoot ?? ESP32P4_FRAMEWORK_ROOT);
  const cwd = resolve(options.cwd ?? process.cwd());
  const manifestPath = isStockAppName(value)
    ? join(frameworkRoot, "apps", value, "pocket.json")
    : resolve(cwd, value);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    const description = isStockAppName(value)
      ? `stock app ${JSON.stringify(value)}`
      : `manifest ${JSON.stringify(value)}`;
    throw new Error(
      `pocket esp32p4: cannot find ${description} at ${manifestPath}`,
    );
  }
  return manifestPath;
}

/** Find the root against which the manifest's repository-relative entry lives. */
export function inferEsp32P4ProjectRoot(
  manifestPath: string,
  entry: string,
): string {
  let candidate = dirname(manifestPath);
  while (true) {
    const entryPath = resolve(candidate, entry);
    if (existsSync(entryPath) && statSync(entryPath).isFile()) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(
        `pocket esp32p4: cannot find entry ${JSON.stringify(entry)} above ${manifestPath}`,
      );
    }
    candidate = parent;
  }
}

/**
 * Resolve the target plan and every deterministic output path without writing.
 * The native host can consume the same verified plan through
 * `extractHostBuildInputs()` once its runtime lands.
 */
export function planEsp32P4Bundle(
  input: string,
  options: Esp32P4BundlePlanOptions = {},
): Esp32P4BundleArtifacts {
  const frameworkRoot = resolve(options.frameworkRoot ?? ESP32P4_FRAMEWORK_ROOT);
  const manifestPath = resolveEsp32P4ManifestPath(input, {
    ...options,
    frameworkRoot,
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`pocket esp32p4: invalid JSON in ${manifestPath}`, {
      cause: error,
    });
  }
  const plan = resolveEsp32P4Waveshare7BBuildPlan(manifest);
  const projectRoot = inferEsp32P4ProjectRoot(manifestPath, plan.app.entry);
  const outputDirectory = frameworkRoot === ESP32P4_FRAMEWORK_ROOT
    ? ESP32P4_BUNDLE_OUTPUT_DIRECTORY
    : join(frameworkRoot, "dist/esp32p4");
  const basename = plan.app.output;
  return {
    target: {
      id: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
      hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
    },
    board: {
      id: ESP32P4_WAVESHARE_7B_BOARD_ID,
      panel: ESP32P4_WAVESHARE_7B_PANEL,
      contentRect: ESP32P4_WAVESHARE_7B_CONTENT_RECT,
    },
    manifestPath,
    frameworkRoot,
    projectRoot,
    outputDirectory,
    planPath: join(outputDirectory, `${basename}.plan.json`),
    javascriptPath: join(outputDirectory, `${basename}.js`),
    pakPath: join(outputDirectory, `${basename}.pak`),
    plan,
  };
}

export async function buildEsp32P4Bundle(
  input: string,
  options: Esp32P4BundlePlanOptions = {},
): Promise<Esp32P4BundleArtifacts> {
  const artifacts = planEsp32P4Bundle(input, options);
  mkdirSync(artifacts.outputDirectory, { recursive: true });
  writeFileSync(
    artifacts.planPath,
    JSON.stringify(artifacts.plan, null, 2) + "\n",
  );

  const bun = Bun.which("bun") ?? process.execPath;
  const build = Bun.spawn(
    [
      bun,
      join(artifacts.frameworkRoot, "tools/build.ts"),
      `--plan=${artifacts.planPath}`,
      `--project-root=${artifacts.projectRoot}`,
      `--outdir=${artifacts.outputDirectory}`,
    ],
    {
      cwd: artifacts.projectRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`pocket esp32p4: compiler failed with exit ${exitCode}`);
  }
  for (const output of [artifacts.javascriptPath, artifacts.pakPath]) {
    if (!existsSync(output) || !statSync(output).isFile()) {
      throw new Error(`pocket esp32p4: compiler did not produce ${output}`);
    }
  }

  console.log(
    `PocketJS ESP32-P4 bundle: ${artifacts.plan.app.output} -> ` +
      `${relative(artifacts.frameworkRoot, artifacts.outputDirectory)}/`,
  );
  console.log(
    `  host ${artifacts.target.id} ABI ${artifacts.target.hostAbi}; ` +
      `panel ${artifacts.board.panel[0]}x${artifacts.board.panel[1]}, ` +
      `content ${artifacts.board.contentRect.width}x${artifacts.board.contentRect.height}` +
      `+${artifacts.board.contentRect.x}+${artifacts.board.contentRect.y}`,
  );
  return artifacts;
}

function usage(message?: string): never {
  if (message) console.error(`pocket esp32p4: ${message}`);
  console.error("usage: bun tools/esp32p4.ts <stock-app | path/to/pocket.json>");
  process.exit(1);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    usage(args.length > 1 ? "expected exactly one app or manifest" : undefined);
  }
  await buildEsp32P4Bundle(args[0]);
}
