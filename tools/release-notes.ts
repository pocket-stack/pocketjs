// tools/release-notes.ts — GitHub Release notes from the changelog.
//   bun tools/release-notes.ts v0.4.0            # print the notes body
//   bun tools/release-notes.ts v0.4.0 --title    # print the release title
// release.yml uses both to create the GitHub Release after publishing to
// npm; a version without a changelog entry fails instead of shipping an
// empty release.

const SITE = "https://pocketjs.dev";

function section(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `));
  if (start === -1) {
    throw new Error(`no "## ${version} — <date>" entry in site/content/changelog.md`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export function releaseNotes(changelog: string, version: string): string {
  // Root-relative site links only resolve on pocketjs.dev, not on GitHub.
  const body = section(changelog, version).replaceAll("](/", `](${SITE}/`);
  const npm = (name: string) =>
    `[\`${name}@${version}\`](https://www.npmjs.com/package/${name}/v/${version})`;
  return [
    body,
    "",
    "---",
    "",
    `npm: ${npm("@pocketjs/framework")} · ${npm("@pocketjs/cli")} · [full changelog](${SITE}/changelog/)`,
    "",
  ].join("\n");
}

export function releaseTitle(changelog: string, version: string): string {
  const thesis = section(changelog, version).match(/\*\*(.+?)\*\*/);
  return thesis ? `v${version} — ${thesis[1]!.replace(/\.$/, "")}` : `v${version}`;
}

if (import.meta.main) {
  const tag = process.argv[2];
  if (!tag) {
    throw new Error("usage: bun tools/release-notes.ts vX.Y.Z [--title]");
  }
  const version = tag.replace(/^v/, "");
  const changelog = await Bun.file(
    new URL("../site/content/changelog.md", import.meta.url),
  ).text();
  process.stdout.write(
    process.argv[3] === "--title"
      ? releaseTitle(changelog, version) + "\n"
      : releaseNotes(changelog, version),
  );
}
