import { describe, expect, test } from "bun:test";
import {
  generatePocketManifestV2Schema,
  type PocketManifestV2,
} from "../spec/pocket-manifest.ts";
import {
  POCKET_CAPABILITIES,
  POCKET_PLATFORM_CONTRACTS,
  POCKET_TARGETS,
  defineCapabilityRegistry,
  definePlatformContractRegistry,
  defineTargetRegistry,
  type CapabilityId,
  type TargetId,
  type TargetProfile,
} from "../spec/platforms.ts";
import { canonicalJson, verifyPlanHash } from "../src/manifest/plan.ts";
import {
  resolveBuildPlan,
  validateAndResolveBuildPlan,
  validatePlatformContractRegistry,
} from "../src/manifest/resolve.ts";
import { validatePocketManifest } from "../src/manifest/validate.ts";

const fixtureUrl = (name: string) => new URL(`./fixtures/manifests/${name}.json`, import.meta.url);
const portableInput: unknown = await Bun.file(fixtureUrl("portable-psp")).json();
const invalidExtraInput: unknown = await Bun.file(fixtureUrl("invalid-extra-field")).json();
const touchInput: unknown = await Bun.file(fixtureUrl("requires-touch")).json();

function manifest(input: unknown): PocketManifestV2 {
  const result = validatePocketManifest(input);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

const SYNTHETIC_CAPABILITIES = defineCapabilityRegistry([
  ...POCKET_CAPABILITIES,
  "input.touch",
] as const);

type SyntheticCapabilityId = CapabilityId<typeof SYNTHETIC_CAPABILITIES>;

const syntheticTargetDefinitions = {
  psp: POCKET_TARGETS.psp,
  "vita-test": {
    hostAbi: 1,
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "input.touch",
      "text.glyphs.baked",
    ],
  },
} as const satisfies Readonly<Record<string, TargetProfile<SyntheticCapabilityId>>>;

const SYNTHETIC_TARGETS = defineTargetRegistry<
  SyntheticCapabilityId,
  typeof syntheticTargetDefinitions
>(syntheticTargetDefinitions);

type SyntheticTargetId = TargetId<typeof SYNTHETIC_TARGETS>;
const SYNTHETIC_CONTRACTS = definePlatformContractRegistry(
  SYNTHETIC_CAPABILITIES,
  SYNTHETIC_TARGETS,
);

describe("pocket.json v2 schema", () => {
  test("committed JSON Schema is byte-exact with the TypeScript source", async () => {
    const committed = await Bun.file(new URL("../schema/pocket-2.json", import.meta.url)).text();
    expect(committed).toBe(generatePocketManifestV2Schema());
  });

  test("accepts the portable PSP fixture", () => {
    expect(validatePocketManifest(portableInput).ok).toBe(true);
  });

  test("rejects unknown fields at their exact JSON Pointer", () => {
    const result = validatePocketManifest(invalidExtraInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.additionalProperty",
      path: "/app/target",
      message: "unknown property",
    });
  });

  test("accepts only relative entries and string capability ids", () => {
    const bad = structuredClone(portableInput) as Record<string, any>;
    bad.app.entry = "../outside.tsx";
    bad.engine.capabilities.requires[0] = { id: "input.buttons", version: 1 };
    const result = validatePocketManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((item) => [item.code, item.path])).toEqual(expect.arrayContaining([
      ["schema.pattern", "/app/entry"],
      ["schema.type", "/engine/capabilities/requires/0"],
    ]));
  });

  test("rejects packaging fields until a backend consumes them", () => {
    const bad = structuredClone(portableInput) as Record<string, any>;
    bad.packages = { psp: { title: "unused" } };
    const result = validatePocketManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual({
      code: "schema.additionalProperty",
      path: "/packages",
      message: "unknown property",
    });
  });
});

describe("platform registry", () => {
  test("production advertises only the truthful PSP and Vita profiles", () => {
    expect(Object.keys(POCKET_TARGETS)).toEqual(["psp", "vita"]);
    expect(validatePlatformContractRegistry(POCKET_PLATFORM_CONTRACTS)).toEqual([]);
    expect(POCKET_TARGETS.vita.capabilities).toEqual([
      "input.analog.left",
      "input.buttons",
      "text.glyphs.baked",
    ]);
    expect(POCKET_TARGETS.vita.display).toEqual({
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
    });
  });

  test("TargetId and capability registries extend without changing the resolver", () => {
    const ids: SyntheticTargetId[] = ["psp", "vita-test"];
    expect(ids).toEqual(["psp", "vita-test"]);
    expect(validatePlatformContractRegistry(SYNTHETIC_CONTRACTS)).toEqual([]);
  });
});

describe("semantic resolution", () => {
  test("resolves a small PSP build plan", () => {
    const result = validateAndResolveBuildPlan(portableInput, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "psp", hostAbi: 1 });
    expect(result.plan.app).toEqual({
      entry: "app/main.tsx",
      output: "main",
      framework: "solid",
    });
    expect(result.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
    });
    expect(result.plan.features).toEqual({
      "input.analog.left": true,
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    expect(result.plan.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyPlanHash(result.plan)).toBe(true);
  });

  test("resolved PSP plan is byte-exact with its committed fixture", async () => {
    const result = validateAndResolveBuildPlan(portableInput, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const committed = await Bun.file(
      new URL("./fixtures/plans/portable-psp.plan.json", import.meta.url),
    ).text();
    expect(JSON.stringify(result.plan, null, 2) + "\n").toBe(committed);
  });

  test("portable PSP baseline resolves to a byte-exact 2x Vita plan", async () => {
    const result = validateAndResolveBuildPlan(portableInput, { target: "vita" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.target).toEqual({ id: "vita", hostAbi: 1 });
    expect(result.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [960, 544],
      presentation: "integer-fit",
    });
    expect(result.plan.features).toEqual({
      "input.analog.left": true,
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    const committed = await Bun.file(
      new URL("./fixtures/plans/portable-vita.plan.json", import.meta.url),
    ).text();
    expect(JSON.stringify(result.plan, null, 2) + "\n").toBe(committed);
  });

  test("plan checksum is independent of capability order and manifest identity", () => {
    const changed = structuredClone(portableInput) as Record<string, any>;
    changed.engine.capabilities.requires.reverse();
    changed.id = "dev.pocket-stack.renamed";
    changed.name = "renamed-app";
    changed.title = "Renamed App";
    changed.version = "9.0.0";
    const left = validateAndResolveBuildPlan(portableInput, { target: "psp" });
    const right = validateAndResolveBuildPlan(changed, { target: "psp" });
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(canonicalJson(left.plan)).toBe(canonicalJson(right.plan));
    expect(left.plan.planHash).toBe(right.plan.planHash);
  });

  test("reports unknown targets and missing hard requirements", () => {
    const unknownTarget = validateAndResolveBuildPlan(portableInput, { target: "switch" });
    expect(unknownTarget.ok).toBe(false);
    if (!unknownTarget.ok) expect(unknownTarget.diagnostics[0]?.code).toBe("target.unknown");

    const needsTouch = structuredClone(portableInput) as Record<string, any>;
    needsTouch.engine.capabilities.requires.push("input.touch");
    const unavailable = resolveBuildPlan(manifest(needsTouch), { target: "psp" }, SYNTHETIC_CONTRACTS);
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.diagnostics.some((item) => item.code === "capability.unavailable")).toBe(true);
    }
  });

  test("rejects duplicate requires/enhances declarations", () => {
    const bad = structuredClone(portableInput) as Record<string, any>;
    bad.engine.capabilities.enhances = ["input.buttons"];
    const result = validateAndResolveBuildPlan(bad, { target: "psp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((item) => item.code === "capability.duplicate")).toBe(true);
  });

  test("a PSP baseline resolves unchanged for a higher-resolution Vita host", () => {
    const result = resolveBuildPlan(manifest(portableInput), { target: "vita-test" }, SYNTHETIC_CONTRACTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [960, 544],
      presentation: "integer-fit",
    });
    expect(Object.values(result.plan.features).every(Boolean)).toBe(true);
  });

  test("enhancements record target availability without gating resolution", () => {
    const adaptive = structuredClone(portableInput) as Record<string, any>;
    adaptive.engine.capabilities.enhances = ["input.touch"];
    const parsed = manifest(adaptive);

    const psp = resolveBuildPlan(parsed, { target: "psp" }, SYNTHETIC_CONTRACTS);
    const vita = resolveBuildPlan(parsed, { target: "vita-test" }, SYNTHETIC_CONTRACTS);
    expect(psp.ok && vita.ok).toBe(true);
    if (!psp.ok || !vita.ok) return;
    expect(psp.plan.features["input.touch"]).toBe(false);
    expect(vita.plan.features["input.touch"]).toBe(true);
  });

  test("production Vita rejects future touch instead of advertising hardware without an API", () => {
    const result = validateAndResolveBuildPlan(touchInput, { target: "vita" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((item) => item.code === "capability.unknown")).toBe(true);
  });
});
