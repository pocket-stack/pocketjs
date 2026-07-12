// Manifest-driven PocketJS orchestration.
//
//   bun pocket check --target psp
//   bun pocket build --target psp -- --release

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkTargetTypes } from "../compiler/target-check.ts";
import { POCKET_PLATFORM_CONTRACTS, type PocketTargetId } from "../spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../src/manifest/resolve.ts";
import type { ResolvedBuildPlan } from "../src/manifest/plan.ts";

const frameworkRoot = new URL("..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const command = argv.shift();

function usage(message?: string): never {
  if (message) console.error(`PocketJS: ${message}`);
  console.error(
    "usage: bun pocket <check|build> --target <target> [--manifest pocket.json] [--outdir dist] [-- backend args]",
  );
  process.exit(1);
}

function takeOption(name: string): string | undefined {
  const inline = argv.findIndex((value) => value.startsWith(`--${name}=`));
  if (inline >= 0) return argv.splice(inline, 1)[0]!.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} requires a value`);
  argv.splice(index, 2);
  return value;
}

if (command !== "check" && command !== "build") usage(`unknown command ${command ?? "<missing>"}`);
const target = takeOption("target");
if (!target) usage("--target is required");
const manifestPath = resolve(takeOption("manifest") ?? "pocket.json");
const projectRoot = dirname(manifestPath);
const outdir = resolve(projectRoot, takeOption("outdir") ?? "dist");
const separator = argv.indexOf("--");
const backendArgs = separator >= 0 ? argv.splice(separator + 1) : argv.splice(0);
if (separator >= 0) argv.splice(separator, 1);
if (argv.length > 0) usage(`unknown option ${argv[0]}`);

if (!existsSync(manifestPath)) usage(`manifest not found: ${manifestPath}`);
const manifestInput: unknown = await Bun.file(manifestPath).json();
const resolution = validateAndResolveBuildPlan(manifestInput, { target });
if (!resolution.ok) {
  for (const diagnostic of resolution.diagnostics) {
    console.error(`${diagnostic.code} ${diagnostic.path || "/"}: ${diagnostic.message}`);
  }
  process.exit(1);
}
const plan = resolution.plan;
const entry = resolve(projectRoot, plan.app.entry);
if (!existsSync(entry)) usage(`app entry not found: ${entry}`);

const profile = POCKET_PLATFORM_CONTRACTS.targets[target];
if (!profile) usage(`target profile disappeared during resolution: ${target}`);
const capabilityKey = (id: string, version: number): string => `${id}@${version}`;
const typeResult = checkTargetTypes({
  entry,
  environment: {
    target,
    providedCapabilities: Object.entries(profile.capabilities).map(([id, provided]) =>
      capabilityKey(id, provided!.version)
    ),
    requiredCapabilities: plan.capabilities.requires.map(({ requirement }) =>
      capabilityKey(requirement.id, requirement.version)
    ),
    enhancementCapabilities: plan.capabilities.enhances.map(({ requirement }) =>
      capabilityKey(requirement.id, requirement.version)
    ),
  },
  tsconfigPath: existsSync(resolve(projectRoot, "tsconfig.json"))
    ? resolve(projectRoot, "tsconfig.json")
    : undefined,
  declarationFiles: [resolve(frameworkRoot, "src/jsx.d.ts")],
});
if (!typeResult.ok) {
  for (const diagnostic of typeResult.diagnostics.filter((item) => item.category === "error")) {
    const location = diagnostic.file
      ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column}` : ""}`
      : "TypeScript";
    console.error(`${location} TS${diagnostic.code}: ${diagnostic.message}`);
  }
  process.exit(1);
}

const planDirectory = resolve(projectRoot, ".pocket", target);
const planPath = resolve(planDirectory, "plan.json");
mkdirSync(planDirectory, { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");

console.log(`✓ pocket.json v2`);
console.log(`✓ ${target}@${plan.target.profileVersion} satisfies ${plan.capabilities.requires.length} requirement(s)`);
console.log(`✓ target-specific TypeScript (${typeResult.checkedFiles.length} app module(s))`);
console.log(`✓ ResolvedBuildPlan ${plan.contractHash}`);

if (command === "check") process.exit(0);

async function run(args: string[], label: string): Promise<void> {
  const child = Bun.spawn(args, { cwd: projectRoot, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${label} failed with exit ${status}`);
}

await run(
  [
    Bun.which("bun") ?? "bun",
    resolve(frameworkRoot, "scripts/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${projectRoot}`,
    `--outdir=${outdir}`,
  ],
  "PocketJS compiler",
);

interface TargetBackendContext {
  readonly plan: ResolvedBuildPlan;
  readonly planPath: string;
  readonly projectRoot: string;
  readonly outdir: string;
  readonly args: readonly string[];
}

type TargetBackend = (context: TargetBackendContext) => Promise<void>;

const targetBackends = {
  psp: async ({ planPath, projectRoot, outdir, args }) => {
    await run(
      [
        Bun.which("bun") ?? "bun",
        resolve(frameworkRoot, "scripts/psp.ts"),
        `--plan=${planPath}`,
        `--project-root=${projectRoot}`,
        `--outdir=${outdir}`,
        "--skip-build",
        ...args,
      ],
      "PSP backend",
    );
  },
} satisfies Record<PocketTargetId, TargetBackend>;

await targetBackends[target as PocketTargetId]({
  plan,
  planPath,
  projectRoot,
  outdir,
  args: backendArgs,
});
