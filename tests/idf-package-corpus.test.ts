import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageCorpus } from "../tools/package-corpus.ts";
import { decodePocketPackage } from "../contracts/spec/pocket-package.ts";

const root = new URL("..", import.meta.url).pathname;
test("TS, C and Python consume the shared package corpus", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocketjs-corpus-"));
  const corpus = join(root, "tests/fixtures/packages/corpus");
  try {
    const run = (cmd: string[]) => {
      const result = Bun.spawnSync(cmd, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    };
    const binary = join(temporary, "package-corpus");
    run([process.env.CC ?? "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-I" + join(root, "hosts/esp-idf/tests/host/include"),
      "-I" + join(root, "hosts/esp-idf/components/pocketjs_package/include"),
      join(root, "hosts/esp-idf/components/pocketjs_package/src/package.c"),
      join(root, "hosts/esp-idf/tests/host/package_corpus.c"), "-o", binary]);
    for (const [name, expected] of packageCorpus()) {
      const path = join(corpus, name), bytes = readFileSync(path);
      expect(bytes.equals(Buffer.from(expected)), name).toBe(true);
      if (name.startsWith("ok-")) expect(() => decodePocketPackage(bytes), name).not.toThrow();
      else expect(() => decodePocketPackage(bytes), name).toThrow();
      run([binary, path, name.startsWith("ok-") ? "ok" : "bad"]);
    }
    run(["python3", join(root, "hosts/esp-idf/tests/host/package_corpus.py"),
      join(root, "hosts/esp-idf/components/pocketjs_package/tools"), corpus]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 30_000);
