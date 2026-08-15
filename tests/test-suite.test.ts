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

  test("runs every iOS test in the CI unit stage", () => {
    const declared = unitTestFiles();
    const iosTests = readdirSync(join(repository, "tests"))
      .filter((file) => /^ios-.*\.test\.ts$/.test(file))
      .map((file) => `tests/${file}`)
      .sort();

    expect(iosTests).not.toHaveLength(0);
    expect(iosTests.filter((file) => !declared.has(file))).toEqual([]);
  });

  test("runs every Meizu M8 test in the CI unit stage", () => {
    const declared = unitTestFiles();
    const meizuM8Tests = readdirSync(join(repository, "tests"))
      .filter((file) => /^meizu-m8-.*\.test\.ts$/.test(file))
      .map((file) => `tests/${file}`)
      .sort();

    expect(meizuM8Tests).not.toHaveLength(0);
    expect(meizuM8Tests.filter((file) => !declared.has(file))).toEqual([]);
  });

  test("runs every iPhone 4S test in the CI unit stage", () => {
    const declared = unitTestFiles();
    const iphone4sTests = readdirSync(join(repository, "tests"))
      .filter((file) => /^iphone4s-.*\.test\.ts$/.test(file))
      .map((file) => `tests/${file}`)
      .sort();

    expect(iphone4sTests).not.toHaveLength(0);
    expect(iphone4sTests.filter((file) => !declared.has(file))).toEqual([]);
  });

  test("runs every iPod touch test in the CI unit stage", () => {
    const declared = unitTestFiles();
    const ipodtouchTests = readdirSync(join(repository, "tests"))
      .filter((file) => /^ipodtouch-.*\.test\.ts$/.test(file))
      .map((file) => `tests/${file}`)
      .sort();

    expect(ipodtouchTests).not.toHaveLength(0);
    expect(ipodtouchTests.filter((file) => !declared.has(file))).toEqual([]);
  });
});
