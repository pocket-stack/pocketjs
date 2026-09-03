// Run a publish command with a publishable svelte dependency spec.
//
//   bun tools/publish-manifest.ts npm publish --access public --provenance
//
// Svelte's custom-renderer build is unreleased, so package.json pins it as
// `file:vendor/<tarball>` and lists it in bundleDependencies — the tarball
// carries the build under node_modules/svelte and a consumer never installs
// svelte themselves. The PUBLISHED manifest cannot keep that spec: Bun resolves
// a bundled dependency's spec before honouring the bundle, and a consumer's
// `bun install` then fails on a `file:vendor/…` path that does not exist in
// their tree. So swap it for a plain range while the command runs, and always
// put the working tree back.

import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST = new URL("../package.json", import.meta.url);
/** Matches the vendored build's version; consumers get the bundled copy anyway. */
const PUBLISHED_SPEC = ">=5.57.0";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: bun tools/publish-manifest.ts <command> [args...]");
  process.exit(1);
}

const original = readFileSync(MANIFEST, "utf8");
const swapped = original.replace(
  /("svelte":\s*)"file:vendor\/[^"]+"/,
  `$1${JSON.stringify(PUBLISHED_SPEC)}`,
);
if (swapped === original) {
  throw new Error("publish-manifest: package.json has no file:vendor svelte dependency");
}

writeFileSync(MANIFEST, swapped);
try {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exitCode = result.exitCode;
} finally {
  writeFileSync(MANIFEST, original);
}
