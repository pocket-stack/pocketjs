import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hostDir = resolve(root, "hosts/switch");
const args = Bun.argv.slice(2);

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = args.findIndex((value) => value.startsWith(prefix));
  if (index < 0) return undefined;
  return args.splice(index, 1)[0]!.slice(prefix.length);
}

function flag(name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function usage(message?: string): never {
  if (message) console.error(`PocketJS Switch: ${message}`);
  console.error(
    "usage: bun tools/switch.ts --plan=<plan.json> --project-root=<dir> --outdir=<dir> [--skip-build]",
  );
  process.exit(2);
}

const planPath = option("plan");
const projectRoot = resolve(option("project-root") ?? root);
const outdir = resolve(projectRoot, option("outdir") ?? "dist");
const skipBuild = flag("skip-build");
flag("release");
if (!planPath) usage("--plan is required");
if (args.length > 0) usage(`unknown option ${args[0]}`);

const planInput: unknown = await Bun.file(resolve(planPath)).json();
const inputs = extractHostBuildInputs(planInput, { expectedTarget: "switch" });
const plan = planInput as ResolvedBuildPlan;
if (
  inputs.hostAbi !== 4 ||
  inputs.viewport.logical[0] !== 480 ||
  inputs.viewport.logical[1] !== 272 ||
  inputs.viewport.physical[0] !== 1280 ||
  inputs.viewport.physical[1] !== 720 ||
  inputs.viewport.presentation !== "integer-fit" ||
  inputs.viewport.rasterDensity !== 2
) {
  throw new Error("PocketJS Switch: unsupported target contract");
}

const devkitpro = resolve(process.env.DEVKITPRO ?? "/opt/devkitpro");
const devkitA64 = resolve(process.env.DEVKITA64 ?? `${devkitpro}/devkitA64`);
const toolPath = `${devkitA64}/bin:${devkitpro}/tools/bin:${process.env.PATH ?? ""}`;
const gcc = resolve(devkitA64, "bin/aarch64-none-elf-gcc");
if (!existsSync(gcc)) {
  throw new Error("PocketJS Switch: devkitA64 not found; install devkitPro switch-dev");
}

async function run(command: string[], label: string, cwd = projectRoot): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      DEVKITPRO: devkitpro,
      DEVKITA64: devkitA64,
      PATH: toolPath,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${label} failed with exit ${status}`);
}

if (!skipBuild) {
  await run(
    [
      process.execPath,
      resolve(root, "tools/build.ts"),
      `--plan=${resolve(planPath)}`,
      `--project-root=${projectRoot}`,
      `--outdir=${outdir}`,
    ],
    "PocketJS compiler",
  );
}

const appJs = resolve(outdir, `${inputs.appOutput}.js`);
const appPak = resolve(outdir, `${inputs.appOutput}.pak`);
if (!existsSync(appJs) || !existsSync(appPak)) {
  throw new Error(`PocketJS Switch: missing ${inputs.appOutput}.js/.pak in ${outdir}`);
}

const romfs = resolve(hostDir, "romfs/pocketjs");
rmSync(dirname(romfs), { recursive: true, force: true });
mkdirSync(romfs, { recursive: true });
cpSync(appJs, resolve(romfs, "app.js"));
cpSync(appPak, resolve(romfs, "app.pak"));

await run(["make", "clean"], "Switch host clean", hostDir);
await run(
  [
    "make",
    `APP_TITLE=${plan.app.title}`,
    "APP_AUTHOR=PocketJS",
    "APP_VERSION=0.1.0",
  ],
  "Switch host build",
  hostDir,
);

const builtNro = resolve(hostDir, "pocketjs-switch.nro");
const packageDir = resolve(outdir, "switch");
const outputNro = resolve(packageDir, `${inputs.appOutput}.nro`);
mkdirSync(packageDir, { recursive: true });
cpSync(builtNro, outputNro);
console.log(`PocketJS Switch: built ${outputNro}`);
