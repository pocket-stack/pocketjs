#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { makeVariant } from "./pocket-pack.ts";

const args = Bun.argv.slice(2);

function option(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`sf2000: --${name} is required`);
}

const projectRoot = resolve(option("project-root", "."));
const manifestPath = resolve(option("manifest", join(projectRoot, "pocket.json")));
const planPath = resolve(option("plan"));
const outdir = resolve(projectRoot, option("outdir", "dist"));
const plan = JSON.parse(readFileSync(planPath, "utf8")) as ResolvedBuildPlan;

if (plan.target.id !== "sf2000") {
  throw new Error(`sf2000: expected an sf2000 plan, got ${plan.target.id}`);
}

const jsPath = join(outdir, `${plan.app.output}.js`);
const pakPath = join(outdir, `${plan.app.output}.pak`);
const output = resolve(option("output", join(outdir, `${plan.app.output}.pocket`)));
const variant = makeVariant({
  target: "sf2000",
  hostAbi: plan.target.hostAbi,
  planJson: canonicalJson(plan),
  identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
  js: new Uint8Array(readFileSync(jsPath)),
  pak: existsSync(pakPath) ? new Uint8Array(readFileSync(pakPath)) : new Uint8Array(),
});
const bytes = encodePocketPackage({
  manifest: new Uint8Array(readFileSync(manifestPath)),
  variants: [variant],
});
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, bytes);
console.log(`SF2000 app package: ${output} (${bytes.length} bytes)`);
console.log("Install pocketjs.bin in /unifrog/cores and copy this .pocket file to the ROM directory.");
