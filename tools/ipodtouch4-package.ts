import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { decodeIdentity, decodePocketPackage, encodePocketPackage, findSection, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { IPODTOUCH4_DEV_TARGET_ID, resolveIPodTouch4BuildPlan } from "./ipodtouch4-profile.ts";
import { makeVariant } from "./pocket-pack.ts";

const ROOT = new URL("..", import.meta.url).pathname;
export const IPODTOUCH4_MAX_PACKAGE_BYTES = 24 * 1024 * 1024;

/** Admission on the desktop checks the manifest, plan and identity before any
 * transfer. The native receiver checks the bytes again, including its viewport. */
export function verifyIPodTouch4Package(bytes: Uint8Array) {
  if (bytes.length > IPODTOUCH4_MAX_PACKAGE_BYTES) throw new Error("iPod package exceeds 24 MiB");
  const pkg = decodePocketPackage(bytes);
  const manifest = JSON.parse(new TextDecoder().decode(pkg.manifest));
  const plan = resolveIPodTouch4BuildPlan(manifest);
  const variant = pkg.variants.find((entry) => entry.target === IPODTOUCH4_DEV_TARGET_ID);
  if (!variant || variant.hostAbi !== plan.target.hostAbi) throw new Error("package has no matching iPod target/ABI");
  const section = (kind: number) => {
    const value = findSection(variant, kind);
    if (!value?.length) throw new Error(`iPod package is missing section ${kind}`);
    return value;
  };
  if (canonicalJson(JSON.parse(new TextDecoder().decode(section(POCKET_SECTION.plan)))) !== canonicalJson(plan)) {
    throw new Error("iPod package plan differs from its resolved manifest");
  }
  const identity = decodeIdentity(section(POCKET_SECTION.identity));
  if (identity.id !== plan.app.id || identity.output !== plan.app.output || identity.title !== plan.app.title) {
    throw new Error("iPod package identity differs from its plan");
  }
  const js = section(POCKET_SECTION.js);
  if (js.at(-1) !== 0) throw new Error("iPod package JavaScript needs its QuickJS terminator");
  section(POCKET_SECTION.pak);
  return plan;
}

export async function buildIPodTouch4Package(options: {
  manifest: string;
  projectRoot?: string;
  outdir?: string;
}) {
  const projectRoot = resolve(options.projectRoot ?? ROOT);
  const manifestPath = resolve(projectRoot, options.manifest);
  const manifest = readFileSync(manifestPath);
  const plan = resolveIPodTouch4BuildPlan(JSON.parse(manifest.toString()));
  const outdir = resolve(options.outdir ?? join(ROOT, "dist/ipodtouch4/packages", plan.app.output));
  mkdirSync(outdir, { recursive: true });
  const planPath = join(outdir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  const child = Bun.spawn([process.execPath, join(ROOT, "tools/build.ts"),
    `--plan=${planPath}`, `--project-root=${projectRoot}`, `--outdir=${outdir}`],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error("iPod guest build failed");
  const bytes = encodePocketPackage({ manifest, variants: [makeVariant({
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { id: plan.app.id, title: plan.app.title, output: plan.app.output },
    js: readFileSync(join(outdir, `${plan.app.output}.js`)),
    pak: readFileSync(join(outdir, `${plan.app.output}.pak`)),
  })] });
  verifyIPodTouch4Package(bytes);
  const path = join(outdir, `${plan.app.output}.pocket`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, plan, projectRoot, manifestPath };
}
