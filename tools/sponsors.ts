// tools/sponsors.ts — refresh the sponsor gallery on the homepage.
//
//   bun tools/sponsors.ts            # rewrite site/sponsors.json + avatars
//   bun tools/sponsors.ts --check    # fail if the checked-in data is stale
//
// PUBLIC sponsorships only: the query passes includePrivate: false, so a
// private sponsorship can never reach the site through this path. Avatars are
// downloaded next to the site so the page makes no request to GitHub at run
// time. site/build.ts renders the gallery from site/sponsors.json.
//
// Auth comes from the `gh` CLI (gh auth login), which already holds a token
// with the scope this query needs.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = `${ROOT}site/sponsors.json`;
const AVATARS = `${ROOT}site/assets/sponsors/`;
const AVATAR_PX = 144; // rendered at 48-56 css px, so 2x-3x on the page
const CHECK = process.argv.includes("--check");

const QUERY = `
{
  viewer {
    sponsorshipsAsMaintainer(first: 100, includePrivate: false, activeOnly: true) {
      totalCount
      nodes {
        sponsorEntity {
          __typename
          ... on User { login name avatarUrl url }
          ... on Organization { login name avatarUrl url }
        }
      }
    }
  }
}`;

type Entity = { __typename: string; login: string; name: string | null; avatarUrl: string; url: string };
type Sponsor = { login: string; name: string; url: string; avatar: string };

// Pinned first, in this order; everyone else follows alphabetically.
const PINNED = ["ZephyrCloudIO"];

async function fetchSponsors(): Promise<Sponsor[]> {
  const p = Bun.spawn(["gh", "api", "graphql", "-f", `query=${QUERY}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`gh api graphql failed: ${err.trim()}`);
  const body = JSON.parse(out) as {
    data?: { viewer?: { sponsorshipsAsMaintainer?: { totalCount: number; nodes: { sponsorEntity: Entity | null }[] } } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`graphql errors: ${body.errors.map((e) => e.message).join("; ")}`);
  const nodes = body.data?.viewer?.sponsorshipsAsMaintainer?.nodes ?? [];
  const sponsors = nodes
    .map((n) => n.sponsorEntity)
    .filter((e): e is Entity => Boolean(e?.login))
    // pinned entries first, then alphabetical: the gallery thanks everyone and
    // otherwise implies no ranking
    .sort((a, b) => {
      const pa = PINNED.indexOf(a.login);
      const pb = PINNED.indexOf(b.login);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? PINNED.length : pa) - (pb === -1 ? PINNED.length : pb);
      return a.login.toLowerCase().localeCompare(b.login.toLowerCase());
    })
    .map((e) => ({
      login: e.login,
      name: e.name?.trim() || e.login,
      url: e.url,
      avatarUrl: e.avatarUrl,
    }));
  if (!CHECK) {
    mkdirSync(AVATARS, { recursive: true });
    const keep = new Set(sponsors.map((s) => `${s.login}.png`));
    for (const f of existsSync(AVATARS) ? readdirSync(AVATARS) : []) {
      if (!keep.has(f)) rmSync(AVATARS + f);
    }
    for (const s of sponsors) {
      const url = `${s.avatarUrl}${s.avatarUrl.includes("?") ? "&" : "?"}s=${AVATAR_PX}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`avatar fetch failed for ${s.login}: ${res.status}`);
      writeFileSync(AVATARS + s.login + ".png", new Uint8Array(await res.arrayBuffer()));
    }
  }
  return sponsors.map(({ login, name, url }) => ({ login, name, url, avatar: `/assets/sponsors/${login}.png` }));
}

const sponsors = await fetchSponsors();
const next = `${JSON.stringify({ count: sponsors.length, sponsors }, null, 2)}\n`;

if (CHECK) {
  const current = existsSync(DATA) ? readFileSync(DATA, "utf8") : "";
  if (current !== next) {
    console.error("sponsors: site/sponsors.json is stale. Run: bun tools/sponsors.ts");
    process.exit(1);
  }
  console.log(`sponsors: up to date (${sponsors.length})`);
} else {
  writeFileSync(DATA, next);
  console.log(`sponsors: wrote ${sponsors.length} public sponsors -> site/sponsors.json`);
  for (const s of sponsors) console.log(`  ${s.login}`);
}
