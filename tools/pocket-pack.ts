#!/usr/bin/env bun

// `.pocket` packaging (docs/PLATFORM.md L2; format in contracts/spec/pocket-package.ts).
//
//   bun tools/pocket-pack.ts build --manifest apps/hero/pocket.json \
//       --target psp --target vita [-o dist/packages/hero.pocket]
//   bun tools/pocket-pack.ts build --manifest ... --all-targets
//   bun tools/pocket-pack.ts inspect <file.pocket>
//   bun tools/pocket-pack.ts thin <file.pocket> --target psp -o out.pocket
//   bun tools/pocket-pack.ts verify <file.pocket>
//
// `build` compiles each requested target into ITS OWN outdir
// (.pocket-build/<target>/) — dist flavors never collide (the stale-dist
// lesson, institutionalized) — then packs manifest × variants into one
// file. A target the manifest does not admit fails the pack (or is skipped
// with a log under --all-targets): a package can never carry a variant its
// own manifest disowns.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import {
  POCKET_SECTION,
  decodePocketPackage,
  encodeIdentity,
  encodePocketPackage,
  findSection,
  fnv1a64,
  thinPocketPackage,
  type PocketPackageVariant,
} from "../contracts/spec/pocket-package.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function usage(message?: string): never {
  if (message) console.error(`pocket-pack: ${message}`);
  console.error(
    "usage:\n" +
      "  bun tools/pocket-pack.ts build --manifest <pocket.json> (--target <t>)+ | --all-targets [-o <file>]\n" +
      "  bun tools/pocket-pack.ts inspect <file.pocket>\n" +
      "  bun tools/pocket-pack.ts thin <file.pocket> --target <t> [-o <file>]\n" +
      "  bun tools/pocket-pack.ts verify <file.pocket>",
  );
  process.exit(1);
}

/** Assemble one variant from prebuilt pieces. Shared with the launcher
 *  chain (tools/launcher.ts pack), which reuses its existing psp dist. */
export function makeVariant(input: {
  target: string;
  hostAbi: number;
  planJson: string;
  identity: { output: string; id: string; title: string };
  js: Uint8Array;
  pak: Uint8Array;
  cover?: Uint8Array;
}): PocketPackageVariant {
  // The js section carries the QuickJS NUL (zero-copy device eval rule).
  const js = new Uint8Array(input.js.length + 1);
  js.set(input.js, 0);
  const sections = [
    { kind: POCKET_SECTION.identity, bytes: encodeIdentity(input.identity) },
    { kind: POCKET_SECTION.plan, bytes: new TextEncoder().encode(input.planJson) },
    { kind: POCKET_SECTION.js, bytes: js },
    { kind: POCKET_SECTION.pak, bytes: input.pak },
  ];
  if (input.cover) sections.push({ kind: POCKET_SECTION.cover, bytes: input.cover });
  return { target: input.target, hostAbi: input.hostAbi, sections };
}

async function compileTarget(manifestPath: string, target: string): Promise<string> {
  const outdir = join(ROOT, ".pocket-build", target);
  mkdirSync(outdir, { recursive: true });
  const p = Bun.spawnSync(
    [
      "bun",
      "tools/pocket.ts",
      "compile",
      "--target",
      target,
      "--manifest",
      manifestPath,
      "--project-root",
      ".",
      "--outdir",
      relative(ROOT, outdir),
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0) throw new Error(`pocket-pack: compile failed for ${target}`);
  return outdir;
}

async function buildCommand(argv: string[]): Promise<void> {
  let manifestPath = "";
  let output = "";
  let allTargets = false;
  const targets: string[] = [];
  while (argv.length) {
    const a = argv.shift()!;
    if (a === "--manifest") manifestPath = resolve(argv.shift() ?? usage("--manifest needs a value"));
    else if (a === "--target") targets.push(argv.shift() ?? usage("--target needs a value"));
    else if (a === "--all-targets") allTargets = true;
    else if (a === "-o" || a === "--output") output = resolve(argv.shift() ?? usage("-o needs a value"));
    else usage(`unknown option ${a}`);
  }
  if (!manifestPath) usage("--manifest is required");
  if (!allTargets && targets.length === 0) usage("give --target (repeatable) or --all-targets");
  const manifestBytes = readFileSync(manifestPath);
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));

  const requested = allTargets ? Object.keys(POCKET_TARGETS) : targets;
  const variants: PocketPackageVariant[] = [];
  for (const target of requested) {
    const resolution = validateAndResolveBuildPlan(manifest, { target });
    if (!resolution.ok) {
      const codes = resolution.diagnostics.map((d) => `${d.code}`).join(", ");
      if (allTargets) {
        console.log(`  skip ${target}: not admitted (${codes})`);
        continue;
      }
      throw new Error(`pocket-pack: ${target} does not admit this manifest (${codes})`);
    }
    const plan = resolution.plan;
    const outdir = await compileTarget(manifestPath, target);
    const js = new Uint8Array(readFileSync(join(outdir, `${plan.app.output}.js`)));
    const pakPath = join(outdir, `${plan.app.output}.pak`);
    const pak = existsSync(pakPath) ? new Uint8Array(readFileSync(pakPath)) : new Uint8Array(0);
    const coverPath = join(ROOT, "apps/launcher/covers", `cover-${plan.app.output}.png`);
    variants.push(
      makeVariant({
        target,
        hostAbi: plan.target.hostAbi,
        planJson: canonicalJson(plan),
        identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
        js,
        pak,
        cover: existsSync(coverPath) ? new Uint8Array(readFileSync(coverPath)) : undefined,
      }),
    );
    console.log(`  variant ${target}: js ${js.length}B pak ${pak.length}B`);
  }
  if (variants.length === 0) throw new Error("pocket-pack: no variant admitted — nothing to pack");

  const id = (manifest as { name?: string }).name ?? "app";
  const file = output || join(ROOT, "dist/packages", `${id}.pocket`);
  mkdirSync(dirname(file), { recursive: true });
  const bytes = encodePocketPackage({ manifest: new Uint8Array(manifestBytes), variants });
  writeFileSync(file, bytes);
  console.log(`pocket-pack: ${relative(ROOT, file)} (${bytes.length}B, ${variants.length} variant(s))`);
}

function inspectCommand(file: string): void {
  const bytes = new Uint8Array(readFileSync(file));
  const pkg = decodePocketPackage(bytes);
  const manifest = JSON.parse(new TextDecoder().decode(pkg.manifest)) as {
    id?: string;
    title?: string;
  };
  console.log(`${file}: ${bytes.length}B`);
  console.log(`  manifest: ${manifest.id ?? "?"} — ${manifest.title ?? "?"}`);
  for (const v of pkg.variants) {
    const hash = fnv1a64(...v.sections.map((s) => s.bytes)).toString(16).padStart(16, "0");
    console.log(`  variant ${v.target} (abi ${v.hostAbi}) hash ${hash}`);
    const names: Record<number, string> = { 1: "identity", 2: "plan", 3: "js", 4: "pak", 5: "cover" };
    for (const s of v.sections) {
      console.log(`    ${(names[s.kind] ?? `kind${s.kind}`).padEnd(8)} ${s.bytes.length}B`);
    }
  }
}

function thinCommand(argv: string[]): void {
  const file = argv.shift() ?? usage("thin needs a file");
  let output = "";
  const targets: string[] = [];
  while (argv.length) {
    const a = argv.shift()!;
    if (a === "--target") targets.push(argv.shift() ?? usage("--target needs a value"));
    else if (a === "-o" || a === "--output") output = resolve(argv.shift() ?? usage("-o needs a value"));
    else usage(`unknown option ${a}`);
  }
  if (targets.length === 0) usage("thin needs at least one --target");
  const pkg = decodePocketPackage(new Uint8Array(readFileSync(file)));
  const thinned = encodePocketPackage(thinPocketPackage(pkg, targets));
  const out = output || file.replace(/\.pocket$/, `.${targets.join("-")}.pocket`);
  writeFileSync(out, thinned);
  console.log(`pocket-pack: ${out} (${thinned.length}B)`);
}

function verifyCommand(file: string): void {
  const bytes = new Uint8Array(readFileSync(file));
  const pkg = decodePocketPackage(bytes); // footer hash checked here
  const manifest: unknown = JSON.parse(new TextDecoder().decode(pkg.manifest));
  for (const v of pkg.variants) {
    // Re-run the admission the pack claims: the embedded manifest must
    // still resolve for the variant's target — platform review as a pure
    // function, on the artifact itself.
    const resolution = validateAndResolveBuildPlan(manifest, { target: v.target });
    if (!resolution.ok) {
      throw new Error(`verify: variant ${v.target} is no longer admitted by its own manifest`);
    }
    if (resolution.plan.target.hostAbi !== v.hostAbi) {
      throw new Error(`verify: variant ${v.target} hostAbi drifted`);
    }
    const js = findSection(v, POCKET_SECTION.js);
    if (!js || js[js.length - 1] !== 0) {
      throw new Error(`verify: variant ${v.target} js section is not NUL-terminated`);
    }
  }
  console.log(`verify: OK — footer hash, ${pkg.variants.length} variant(s) re-admitted`);
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const command = argv.shift();
  try {
    if (command === "build") await buildCommand(argv);
    else if (command === "inspect") inspectCommand(argv.shift() ?? usage("inspect needs a file"));
    else if (command === "thin") thinCommand(argv);
    else if (command === "verify") verifyCommand(argv.shift() ?? usage("verify needs a file"));
    else usage(`unknown command ${command ?? "<missing>"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
