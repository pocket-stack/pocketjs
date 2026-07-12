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
import {
  checkTargetTypes,
  generateTargetEnvironment,
  type TargetTypeEnvironment,
} from "../compiler/target-check.ts";

const FIXTURES = new URL("fixtures/target-check/", import.meta.url).pathname;
const ROOT_TSCONFIG = new URL("../tsconfig.json", import.meta.url).pathname;
const BASELINE = ["ui.drawlist@1", "input.buttons@1"] as const;

function environment(
  target: "psp" | "vita",
  options: { touchProvided?: boolean; touchOptional?: boolean } = {},
): TargetTypeEnvironment {
  return {
    target,
    providedCapabilities: [
      ...BASELINE,
      ...(options.touchProvided ? ["input.touch@1"] : []),
    ],
    requiredCapabilities: BASELINE,
    enhancementCapabilities: options.touchOptional ? ["input.touch@1"] : [],
  };
}

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

function checkFixture(
  fixture: string,
  targetEnvironment: TargetTypeEnvironment,
  tsconfigPath?: string,
): ReturnType<typeof checkTargetTypes> {
  const fixtureEntry = entry(fixture);
  try {
    return checkTargetTypes({ entry: fixtureEntry, environment: targetEnvironment, tsconfigPath });
  } finally {
    rmSync(dirname(fixtureEntry), { recursive: true, force: true });
  }
}

function errors(result: ReturnType<typeof checkTargetTypes>): string {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.category === "error")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("\n");
}

describe("per-app/per-target TypeScript checks", () => {
  test("PSP baseline checks only the entry import graph", () => {
    const result = checkFixture("baseline", environment("psp"));

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/main.ts"))).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/controls.ts"))).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/unrelated-broken.ts"))).toBe(false);
  });

  test("inherits app compiler options without broadening to the app include set", () => {
    const result = checkFixture("baseline", environment("psp"), ROOT_TSCONFIG);

    expect(errors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.checkedFiles.some((file) => file.endsWith("/unrelated-broken.ts"))).toBe(false);
    expect(result.artifacts.tsconfig).toContain(`"extends": ${JSON.stringify(ROOT_TSCONFIG)}`);
  });

  test("a host-provided but undeclared capability stays unauthorized", () => {
    const result = checkFixture("unauthorized", environment("vita", { touchProvided: true }));

    expect(result.ok).toBe(false);
    expect(errors(result)).toContain("input.touch@1");
  });

  test("a guarded optional enhancement checks on PSP and Vita", () => {
    const psp = checkFixture("optional", environment("psp", { touchOptional: true }));
    const vita = checkFixture(
      "optional",
      environment("vita", { touchProvided: true, touchOptional: true }),
    );

    expect(errors(psp)).toBe("");
    expect(errors(vita)).toBe("");
    expect(psp.ok).toBe(true);
    expect(vita.ok).toBe(true);
    expect(psp.artifacts.targetEnvironment).toContain(
      'CapabilityToken<"input.touch@1"> | undefined',
    );
    expect(vita.artifacts.targetEnvironment).toContain(
      'readonly "input.touch@1": CapabilityToken<"input.touch@1">;',
    );
  });

  test("an unguarded optional enhancement is target-specific", () => {
    const psp = checkFixture(
      "optional-unguarded",
      environment("psp", { touchOptional: true }),
    );
    const vita = checkFixture(
      "optional-unguarded",
      environment("vita", { touchProvided: true, touchOptional: true }),
    );

    expect(psp.ok).toBe(false);
    expect(errors(psp)).toContain("undefined");
    expect(errors(vita)).toBe("");
    expect(vita.ok).toBe(true);
  });

  test("rejects an unsound resolved environment before invoking TypeScript", () => {
    expect(() =>
      generateTargetEnvironment({
        target: "psp",
        providedCapabilities: BASELINE,
        requiredCapabilities: [...BASELINE, "input.touch@1"],
      }),
    ).toThrow("does not provide required capability: input.touch@1");
  });
});
