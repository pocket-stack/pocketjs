import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");

describe("native host input state machine", () => {
  test("keyboard edges, relative-axis pulses, the primary button, and the touch latch", () => {
    const compiler = Bun.which("cc");
    expect(compiler, "cc is required to build the pocket_input test").toBeTruthy();
    if (!compiler) return;
    const root = mkdtempSync(join(tmpdir(), "pocketjs-pocket-input-"));
    try {
      const executable = join(root, "pocket-input-test");
      const compiled = Bun.spawnSync([
        compiler,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-I",
        join(repository, "hosts/blackberry-classic"),
        "-I",
        join(repository, "contracts/generated"),
        join(repository, "hosts/blackberry-classic/pocket_input.c"),
        join(repository, "tests/fixtures/pocket-input-test.c"),
        "-o",
        executable,
      ], { cwd: repository });
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
      if (process.platform === "darwin") {
        const xattr = Bun.which("xattr");
        if (xattr) Bun.spawnSync([xattr, "-d", "com.apple.provenance", executable]);
      }
      const ran = Bun.spawnSync([executable], { cwd: repository });
      expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
