import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { checkAppTypes } from "../compiler/app-check.ts";

const FIXTURES = new URL("fixtures/app-check/", import.meta.url).pathname;
const ROOT_TSCONFIG = new URL("../tsconfig.json", import.meta.url).pathname;
const JSX_DECLARATIONS = new URL("../src/jsx.d.ts", import.meta.url).pathname;
const SOLID_CONTROL_FLOW_ENTRY = new URL("../demos/cards/main.tsx", import.meta.url).pathname;

function entry(fixture: string): string {
  const sourceDirectory = resolve(FIXTURES, fixture);
  const directory = mkdtempSync(resolve(tmpdir(), `pocketjs-${fixture}-fixture-`));
  mkdirSync(directory, { recursive: true });
  for (const source of readdirSync(sourceDirectory)) {
    if (!source.endsWith(".txt")) continue;
    writeFileSync(
      resolve(directory, source.slice(0, -".txt".length)),
      readFileSync(resolve(sourceDirectory, source)),
    );
  }
  return resolve(directory, "main.ts");
}

function checkFixture(fixture: string, tsconfigPath?: string): ReturnType<typeof checkAppTypes> {
  const fixtureEntry = entry(fixture);
  try {
    return checkAppTypes({ entry: fixtureEntry, tsconfigPath });
  } finally {
    rmSync(dirname(fixtureEntry), { recursive: true, force: true });
  }
}

function errors(result: ReturnType<typeof checkAppTypes>): string {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.category === "error")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("\n");
}

describe("per-app TypeScript checks", () => {
  test("checks only the entry import graph", () => {
    const result = checkFixture("baseline");

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/main.ts"))).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/controls.ts"))).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/unrelated-broken.ts"))).toBe(false);
  });

  test("inherits app compiler options without broadening to the app include set", () => {
    const result = checkFixture("baseline", ROOT_TSCONFIG);

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/unrelated-broken.ts"))).toBe(false);
    expect(result.artifacts.tsconfig).toContain(`"extends": ${JSON.stringify(ROOT_TSCONFIG)}`);
  });

  test("resolves the public manifest and platform subpaths from the app config", () => {
    const result = checkFixture("framework-import", ROOT_TSCONFIG);

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
  });

  test("keeps Solid control-flow children contextually typed without lib.dom", () => {
    const result = checkAppTypes({
      entry: SOLID_CONTROL_FLOW_ENTRY,
      tsconfigPath: ROOT_TSCONFIG,
      declarationFiles: [JSX_DECLARATIONS],
    });

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
  });

  test("reports reachable TypeScript errors", () => {
    const result = checkFixture("error");

    expect(result.ok).toBe(false);
    expect(errors(result)).toContain("Type 'string' is not assignable to type 'number'");
  });
});
