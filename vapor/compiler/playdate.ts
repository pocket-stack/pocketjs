// Build a generated Pocket Vapor application as native Playdate packages.
//
// pd-wasm4 proved the SDK boundary used here: Simulator is a host shared
// library, device is an ARM executable staged as pdex.elf, and pdc packages
// each one independently. WAMR/Lua/cart loading are deliberately absent.

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CompiledApp } from "./compile.ts";

const RUNTIME = resolve(import.meta.dir, "..", "runtime");
const PLAYDATE_RUNTIME = join(RUNTIME, "playdate");

export type PlaydateBuildMode = "simulator" | "device" | "both";
export type PlaydatePlatform = Exclude<PlaydateBuildMode, "both">;

export interface PlaydateSdkEnvironment {
  path: string;
  version: string;
  pdc: string;
  armToolchain: string;
}

export interface PlaydateArtifact {
  path: string;
  kind: "pdx";
  platform: PlaydatePlatform;
  bytes: number;
  buildId: string;
  projectDir: string;
  buildDir: string;
}

function requirePath(path: string, description: string): void {
  if (!existsSync(path)) throw new Error(`${description} not found: ${path}`);
}

function configuredSdkRoot(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  const config = readFileSync(configPath, "utf8");
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*SDKRoot(?:\t+|\s{2,})(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Resolve one observable SDK. An explicit invalid PLAYDATE_SDK_PATH is an
 * error and never falls through to a different local installation.
 */
export function resolvePlaydateSdk(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): PlaydateSdkEnvironment {
  const explicit = env.PLAYDATE_SDK_PATH?.trim();
  const configPath = join(home, ".Playdate", "config");
  const configured = explicit ? undefined : configuredSdkRoot(configPath);
  const sdkPath = explicit ?? configured;
  if (!sdkPath) {
    throw new Error(
      `Playdate SDK path not found: set PLAYDATE_SDK_PATH or add SDKRoot to ${configPath}`,
    );
  }

  const path = resolve(sdkPath);
  requirePath(path, explicit ? "PLAYDATE_SDK_PATH" : "configured Playdate SDK");
  requirePath(join(path, "C_API", "pd_api.h"), "Playdate C API header");
  requirePath(
    join(path, "C_API", "buildsupport", "playdate.cmake"),
    "Playdate CMake support",
  );
  const armToolchain = join(path, "C_API", "buildsupport", "arm.cmake");
  requirePath(armToolchain, "Playdate ARM toolchain");

  const versionPath = join(path, "VERSION.txt");
  requirePath(versionPath, "Playdate SDK version receipt");
  const version = readFileSync(versionPath, "utf8").trim();
  if (!version) throw new Error(`Playdate SDK version receipt is empty: ${versionPath}`);

  const pdc = [join(path, "bin", "pdc"), join(path, "bin", "pdc.exe")].find(existsSync);
  if (!pdc) throw new Error(`Playdate pdc not found under ${join(path, "bin")}`);
  return { path, version, pdc, armToolchain };
}

function simulatorExtension(platform = process.platform): "dylib" | "so" | "dll" {
  if (platform === "darwin") return "dylib";
  if (platform === "win32") return "dll";
  return "so";
}

function debugStateBytes(app: CompiledApp): number {
  const end = Math.max(1, ...app.debugSlots.map((slot) => slot.offset + slot.size));
  return (end + 3) & ~3;
}

/** Stable identity of generated C, runtime, build template, metadata and SDK. */
export async function playdateBuildId(
  app: CompiledApp,
  sdkVersion: string,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`playdate-sdk=${sdkVersion}\ntitle=${app.title}\n${app.c}\n`);
  hasher.update(await Bun.file(import.meta.path).arrayBuffer());
  for (const path of [
    join(RUNTIME, "vapor.h"),
    join(RUNTIME, "vapor_core.c"),
    join(PLAYDATE_RUNTIME, "framebuffer.h"),
    join(PLAYDATE_RUNTIME, "framebuffer.c"),
    join(PLAYDATE_RUNTIME, "vapor_playdate.c"),
    join(PLAYDATE_RUNTIME, "CMakeLists.txt"),
    join(PLAYDATE_RUNTIME, "pdxinfo.in"),
  ]) {
    hasher.update(await Bun.file(path).arrayBuffer());
  }
  return hasher.digest("hex").slice(0, 16);
}

function packageName(title: string): string {
  const name = title.replace(/[\r\n=]/g, " ").trim();
  return name || "POCKET VAPOR";
}

function bundleSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "app";
}

async function writePdxInfo(stageDir: string, app: CompiledApp): Promise<void> {
  const template = await Bun.file(join(PLAYDATE_RUNTIME, "pdxinfo.in")).text();
  const content = template
    .replaceAll("@NAME@", packageName(app.title))
    .replaceAll("@BUNDLE_ID@", `dev.pocketjs.vapor.${bundleSlug(app.title)}`);
  await Bun.write(join(stageDir, "pdxinfo"), content);
}

function commandText(args: readonly string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

async function run(args: string[], cwd?: string): Promise<void> {
  console.log(`[playdate] ${commandText(args)}`);
  const child = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Playdate command failed (${exitCode}): ${commandText(args)}`);
  }
}

async function directoryBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(child);
    else if (entry.isFile()) bytes += Bun.file(child).size;
  }
  return bytes;
}

async function requireNonEmptyFile(path: string, description: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${description} not found: ${path}`);
  if (file.size === 0) throw new Error(`${description} is empty: ${path}`);
}

async function validatePackage(
  path: string,
  platform: PlaydatePlatform,
): Promise<number> {
  requirePath(path, `${platform} Playdate package`);
  await requireNonEmptyFile(join(path, "pdxinfo"), `${platform} package metadata`);
  if (platform === "device") {
    await requireNonEmptyFile(join(path, "pdex.bin"), "Playdate device binary");
  } else {
    await requireNonEmptyFile(
      join(path, `pdex.${simulatorExtension()}`),
      "Playdate Simulator library",
    );
  }
  const bytes = await directoryBytes(path);
  if (bytes === 0) throw new Error(`${platform} Playdate package is empty: ${path}`);
  return bytes;
}

async function buildOne(
  app: CompiledApp,
  outputBase: string,
  platform: PlaydatePlatform,
  sdk: PlaydateSdkEnvironment,
  buildId: string,
): Promise<PlaydateArtifact> {
  const outputDir = dirname(outputBase);
  const name = basename(outputBase).replace(/\.pdx$/, "");
  const projectDir = join(outputDir, `gen-playdate-${name}`);
  const buildDir = join(projectDir, `build-${platform}`);
  const stageDir = join(projectDir, `stage-${platform}`);
  const output = `${outputBase}.playdate-${platform}.pdx`;

  await mkdir(projectDir, { recursive: true });
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  await Bun.write(join(projectDir, "gen_app.c"), app.c);
  await copyFile(
    join(PLAYDATE_RUNTIME, "CMakeLists.txt"),
    join(projectDir, "CMakeLists.txt"),
  );
  await writePdxInfo(stageDir, app);

  const cmake = Bun.which("cmake");
  if (!cmake) throw new Error("cmake not found in PATH");
  const configure = [
    cmake,
    "-S",
    projectDir,
    "-B",
    buildDir,
    `-DSDK=${sdk.path}`,
    `-DVP_RUNTIME_DIR=${RUNTIME}`,
    `-DVP_GEN_APP=${join(projectDir, "gen_app.c")}`,
    `-DVP_STAGE_DIR=${stageDir}`,
    `-DVP_BUILD_ID=${buildId}`,
    `-DVP_DEBUG_STATE_BYTES=${debugStateBytes(app)}`,
    "-DCMAKE_BUILD_TYPE=Release",
  ];
  if (platform === "device") {
    configure.push(`-DCMAKE_TOOLCHAIN_FILE=${sdk.armToolchain}`);
  }

  await run(configure);
  await run([cmake, "--build", buildDir, "--config", "Release"]);

  if (platform === "device") {
    await requireNonEmptyFile(join(stageDir, "pdex.elf"), "staged Playdate device ELF");
  } else {
    await requireNonEmptyFile(
      join(stageDir, `pdex.${simulatorExtension()}`),
      "staged Playdate Simulator library",
    );
  }

  await rm(output, { recursive: true, force: true });
  await run([sdk.pdc, "-sdkpath", sdk.path, stageDir, output]);
  const bytes = await validatePackage(output, platform);
  return { path: output, kind: "pdx", platform, bytes, buildId, projectDir, buildDir };
}

export async function buildPlaydatePackages(
  app: CompiledApp,
  outputBase: string,
  mode: PlaydateBuildMode = "simulator",
  sdk = resolvePlaydateSdk(),
): Promise<PlaydateArtifact[]> {
  const base = resolve(outputBase).replace(/\.pdx$/, "");
  const buildId = await playdateBuildId(app, sdk.version);
  console.log(`[playdate] SDK ${sdk.version}: ${sdk.path}`);
  console.log(`[playdate] build ${buildId}, mode=${mode}`);

  const platforms: PlaydatePlatform[] =
    mode === "both" ? ["simulator", "device"] : [mode];
  const artifacts: PlaydateArtifact[] = [];
  for (const platform of platforms) {
    artifacts.push(await buildOne(app, base, platform, sdk, buildId));
  }
  return artifacts;
}
