// Move the vendored Svelte pin to the current head of the custom-renderer PR.
//
//   bun tools/vendor-svelte.ts
//
// Svelte's custom renderer (sveltejs/svelte#18511) is unreleased, so the
// framework builds against a tarball of the PR head kept in vendor/. A URL pin
// is not an option: pkg.svelte.dev drops a build once a force-push removes its
// commit, and the PR is rebased on most updates. Run `bun run test` afterwards.

import { readdirSync, rmSync } from "node:fs";

const PR = 18511;
const VENDOR = new URL("../vendor/", import.meta.url);
const MANIFEST = new URL("../package.json", import.meta.url);

async function json(url: string, accept = "application/vnd.github+json"): Promise<unknown> {
  const res = await fetch(url, { headers: { accept, "user-agent": "pocketjs-vendor-svelte" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const pr = (await json(`https://api.github.com/repos/sveltejs/svelte/pulls/${PR}`)) as {
  head?: { sha?: string };
};
const sha = pr.head?.sha;
if (!sha) throw new Error(`PR ${PR} has no head sha`);
const short = sha.slice(0, 7);

const existing = readdirSync(VENDOR).filter((name) => name.endsWith(".tgz"));
if (existing.some((name) => name.endsWith(`-${short}.tgz`))) {
  console.log(`vendor: already at ${short}`);
  process.exit(0);
}

const pkg = (await json(
  `https://raw.githubusercontent.com/sveltejs/svelte/${sha}/packages/svelte/package.json`,
  "application/json",
)) as { version?: string };
if (!pkg.version) throw new Error(`no version in svelte package.json at ${sha}`);

const tarball = await fetch(`https://pkg.svelte.dev/svelte/c/${sha}`);
if (!tarball.ok) {
  throw new Error(
    `pkg.svelte.dev has no build for ${short} yet (${tarball.status}); retry once CI publishes it`,
  );
}
const name = `svelte-${pkg.version}-${short}.tgz`;
for (const stale of existing) rmSync(new URL(stale, VENDOR));
await Bun.write(new URL(name, VENDOR), await tarball.arrayBuffer());

const manifest = await Bun.file(MANIFEST).text();
const next = manifest.replace(
  /"svelte": "file:vendor\/[^"]+"/,
  `"svelte": "file:vendor/${name}"`,
);
if (next === manifest) throw new Error("package.json has no file:vendor svelte dependency");
await Bun.write(MANIFEST, next);

console.log(`vendor: svelte ${pkg.version} @ ${short}`);
// bun install does not re-extract a same-named tarball whose bytes changed, but
// the name always carries the commit, so a fresh name is a fresh install.
await Bun.$`bun install`.cwd(new URL("../", import.meta.url).pathname);
