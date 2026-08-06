import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const suiteSource = readFileSync(join(repository, "tools/test.ts"), "utf8");

function unitTestFiles(): Set<string> {
  const unitStage = suiteSource.match(
    /name: "unit",\s*tests: \[(.*?)\n\s*\],\n\s*},/s,
  )?.[1];
  if (!unitStage)
    throw new Error("tools/test.ts does not define the unit test stage");

  return new Set(
    [...unitStage.matchAll(/"(tests\/[^"\n]+\.test\.ts)"/g)].map(
      ([, path]) => path,
    ),
  );
}

describe("declared test suite", () => {
  test("runs every iPhone 2G test in the CI unit stage", () => {
    const declared = unitTestFiles();
    const iphone2gTests = readdirSync(join(repository, "tests"))
      .filter((file) => /^iphone2g-.*\.test\.ts$/.test(file))
      .map((file) => `tests/${file}`)
      .sort();

    expect(iphone2gTests).not.toHaveLength(0);
    expect(iphone2gTests.filter((file) => !declared.has(file))).toEqual([]);
  });
});
