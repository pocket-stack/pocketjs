import { describe, expect, test } from "bun:test";
import {
  createSurfaceCatalog,
  focusCanvas,
  validateSystemPlan,
} from "../hosts/web/system-engine.js";
import { validateAndResolveSystemPlan } from "@pocketjs/framework/manifest";
import systemInput from "./fixtures/systems/managed-desktop.json";

async function resolvedWebSystem() {
  const installed = new Set(systemInput.installation.installedPackages);
  const packages = await Promise.all(
    systemInput.applications.catalog
      .filter((entry) => installed.has(entry.package))
      .map(async (entry) => ({
        source: entry.manifest,
        manifest: await Bun.file(entry.manifest).json(),
      })),
  );
  const result = validateAndResolveSystemPlan(systemInput, {
    target: "web-app",
    packages,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

describe("browser Pocket System host", () => {
  test("focusing the canvas cannot move a double-click onto another surface", () => {
    let options: FocusOptions | undefined;
    focusCanvas({
      focus(next: FocusOptions) {
        options = next;
      },
    });
    expect(options).toEqual({ preventScroll: true });
  });

  test("assigns one-based compositor handles in installation order", async () => {
    const plan = await resolvedWebSystem();
    const { catalog, surfaces } = createSurfaceCatalog(plan.applications);
    expect(catalog.get(0)).toBeUndefined();
    expect(catalog.get(1)).toBe(plan.applications[0]);
    expect(surfaces[plan.applications[0].package]).toBe(1);
    expect(surfaces[plan.applications[1].package]).toBe(2);
  });

  test("accepts a complete resolved web System plan", async () => {
    const plan = await resolvedWebSystem();
    expect(() => validateSystemPlan(plan)).not.toThrow();
  });

  test("rejects child companions and artifact collisions at its trust boundary", async () => {
    const companions = structuredClone(await resolvedWebSystem());
    companions.applications[0].plan.companions = ["note"];
    expect(() => validateSystemPlan(companions)).toThrow("unsupported companions");

    const collision = structuredClone(await resolvedWebSystem());
    collision.applications[1].plan.app.output = collision.applications[0].plan.app.output;
    expect(() => validateSystemPlan(collision)).toThrow("duplicate or missing artifact output");
  });
});
