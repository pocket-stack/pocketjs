import { describe, expect, test } from "bun:test";
import { releaseNotes, releaseTitle } from "../tools/release-notes.ts";

const root = new URL("..", import.meta.url).pathname;

const FIXTURE = `# Changelog

Intro text.

## 0.9.0 — July 20, 2026

**The next thing.** One line of thesis —
[deep-dive](/blog/next-thing/).

- **A bullet** — with a [doc link](/docs/thing/) and an
  [absolute link](https://example.com/kept).

## 0.8.0 — July 1, 2026

**Older.** Not this one.
`;

describe("release notes extraction", () => {
  test("slices exactly one version section and absolutizes site links", () => {
    const notes = releaseNotes(FIXTURE, "0.9.0");
    expect(notes).toContain("**The next thing.**");
    expect(notes).toContain("https://pocketjs.dev/blog/next-thing/");
    expect(notes).toContain("https://pocketjs.dev/docs/thing/");
    expect(notes).toContain("https://example.com/kept");
    expect(notes).not.toContain("Older");
    expect(notes).toContain("@pocketjs/framework/v/0.9.0");
    expect(notes).toContain("@pocketjs/cli/v/0.9.0");
  });

  test("titles the release with the bold thesis", () => {
    expect(releaseTitle(FIXTURE, "0.9.0")).toBe("v0.9.0 — The next thing");
  });

  test("rejects a version without a changelog entry", () => {
    expect(() => releaseNotes(FIXTURE, "1.0.0")).toThrow("no \"## 1.0.0");
  });

  test("the committed changelog covers the version being released", async () => {
    const changelog = await Bun.file(`${root}site/content/changelog.md`).text();
    const { version } = await Bun.file(`${root}package.json`).json() as { version: string };
    expect(releaseNotes(changelog, version).length).toBeGreaterThan(100);
    expect(releaseTitle(changelog, version)).toStartWith(`v${version} — `);
  });
});
