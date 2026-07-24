// vapor/compiler/playdate.ts — package a generated Pocket Vapor app for the
// official Playdate Simulator using Panic's C SDK build support.

import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { VAPOR_TARGETS, type CompiledApp } from "./compile.ts";

const RUNTIME = join(import.meta.dir, "..", "runtime");

function configuredSdkRoot(): string | null {
  const config = join(homedir(), ".Playdate", "config");
  if (!existsSync(config)) return null;
  const match = readFileSync(config, "utf8").match(/^\s*SDKRoot\s+(.+?)\s*$/m);
  return match?.[1]?.replace(/^["']|["']$/g, "") ?? null;
}

function isPlaydateSdk(path: string): boolean {
  return (
    existsSync(join(path, "bin", "pdc")) &&
    existsSync(join(path, "C_API", "pd_api.h")) &&
    existsSync(join(path, "C_API", "buildsupport", "common.mk"))
  );
}

export function resolvePlaydateSdk(): string {
  const candidates = [
    process.env.PLAYDATE_SDK_PATH,
    configuredSdkRoot(),
    join(homedir(), "Developer", "PlaydateSDK"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = resolve(candidate);
    if (isPlaydateSdk(path)) return path;
  }
  throw new Error(
    "Playdate SDK not found. Install the official macOS SDK from https://play.date/dev/ " +
      "and set PLAYDATE_SDK_PATH (default: ~/Developer/PlaydateSDK).",
  );
}

export function playdateSimulatorApp(sdk = resolvePlaydateSdk()): string {
  const app = join(sdk, "bin", "Playdate Simulator.app");
  if (!existsSync(app)) throw new Error(`Playdate Simulator not found in SDK: ${app}`);
  return app;
}

export function playdateSdkVersion(sdk = resolvePlaydateSdk()): string {
  const version = join(sdk, "VERSION.txt");
  return existsSync(version) ? readFileSync(version, "utf8").trim() : "unknown";
}

export function safePlaydateProductName(outPdx: string): string {
  const stem = basename(outPdx, ".pdx")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return `${stem || "app"}.pdx`;
}

function metadata(value: string): string {
  return value.replace(/[\r\n=]+/g, " ").trim();
}

async function directoryBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(child);
    else if (entry.isFile()) bytes += (await stat(child)).size;
  }
  return bytes;
}

export interface PreparedPlaydateProject {
  projectDir: string;
  product: string;
}

export async function preparePlaydateProject(
  app: CompiledApp,
  outPdx: string,
  sdk = resolvePlaydateSdk(),
): Promise<PreparedPlaydateProject> {
  const target = VAPOR_TARGETS.playdate;
  const outDir = dirname(outPdx);
  const projectDir = join(outDir, "gen-playdate");
  const srcDir = join(projectDir, "src");
  const sourceDir = join(projectDir, "Source");
  const sdkLink = join(projectDir, "sdk");
  const product = safePlaydateProductName(outPdx);

  await rm(projectDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  // common.mk expands SDK and PRODUCT through unquoted Make/shell contexts.
  // A stable relative SDK symlink and a strict product basename keep valid
  // custom SDK paths working without making those expansions executable.
  await symlink(sdk, sdkLink, "dir");

  await Bun.write(join(srcDir, "gen_app.c"), app.c);
  await Bun.write(join(srcDir, "vapor.h"), Bun.file(join(RUNTIME, "vapor.h")));
  await Bun.write(join(srcDir, "vapor_core.c"), Bun.file(join(RUNTIME, "vapor_core.c")));
  await Bun.write(
    join(srcDir, "vapor_playdate.c"),
    Bun.file(join(RUNTIME, "playdate", "vapor_playdate.c")),
  );

  const slug = basename(outPdx, ".pdx")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  await Bun.write(
    join(sourceDir, "pdxinfo"),
    [
      `name=${metadata(app.title)}`,
      "author=PocketJS",
      "description=Pocket Vapor native app for Playdate",
      `bundleID=dev.pocketjs.vapor.${slug || "app"}`,
      "version=1.0.0",
      "buildNumber=1",
      "",
    ].join("\n"),
  );

  await Bun.write(
    join(projectDir, "Makefile"),
    [
      "HEAP_SIZE = 8388208",
      "STACK_SIZE = 61800",
      `PRODUCT = ${product}`,
      "SDK = sdk",
      "",
      "VPATH += src",
      "SRC = src/vapor_core.c src/vapor_playdate.c src/gen_app.c",
      "UINCDIR = src",
      `UDEFS = -DVP_GRID_W=${target.width} -DVP_GRID_H=${target.height} -DVP_STR_CAP=${target.strCap} -DVP_VIEW_CAP=${target.poolCap}`,
      "UASRC =",
      "UADEFS =",
      "ULIBDIR =",
      "ULIBS =",
      "",
      "include $(SDK)/C_API/buildsupport/common.mk",
      "SIMCOMPILER += $(UDEFS)",
      "",
    ].join("\n"),
  );

  return { projectDir, product };
}

export async function buildPlaydatePdx(
  app: CompiledApp,
  outPdx: string,
): Promise<{ romBytes: number; sdkVersion: string }> {
  const sdk = resolvePlaydateSdk();
  const { projectDir, product } = await preparePlaydateProject(app, outPdx, sdk);
  await $`make -C ${projectDir} simulator`;

  const built = join(projectDir, product);
  await rm(outPdx, { recursive: true, force: true });
  await rename(built, outPdx);
  return { romBytes: await directoryBytes(outPdx), sdkVersion: playdateSdkVersion(sdk) };
}
