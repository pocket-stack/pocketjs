import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tool = join(root, "hosts/esp-idf/components/pocketjs_package/tools/embed_package.py");
const pkg = join(root, "hosts/esp-idf/examples/prebuilt/idf-smoke.pocket");
const profilePath = join(root, "hosts/esp-idf/examples/smoke/pocket.host.json");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function run(profile: string, output: string) {
  return Bun.spawnSync({
    cmd: [
      "python3",
      tool,
      "--package",
      pkg,
      "--host-profile",
      profile,
      "--name",
      "smoke",
      "--output-dir",
      output,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("ESP-IDF package embedding", () => {
  test("requires an independent matching host profile", () => {
    const directory = `/tmp/pocketjs-idf-embed-${process.pid}-${Math.random().toString(16).slice(2)}`;
    mkdirSync(directory, { recursive: true });
    temporary.push(directory);
    const accepted = run(profilePath, join(directory, "accepted"));
    expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);

    const rejectedProfile = JSON.parse(readFileSync(profilePath, "utf8"));
    rejectedProfile.tickHz = 61;
    const rejectedPath = join(directory, "rejected.host.json");
    writeFileSync(rejectedPath, JSON.stringify(rejectedProfile));
    const rejected = run(rejectedPath, join(directory, "rejected"));
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("host profile hash does not match");
  });
});
