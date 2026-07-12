import type { PocketManifestV2 } from "../../spec/pocket-manifest.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type PlatformContractRegistry,
  type TargetProfile,
  type Viewport,
} from "../../spec/platforms.ts";
import {
  finalizeBuildPlan,
  type ResolvedBuildPlan,
  type ResolvedBuildPlanContent,
} from "./plan.ts";
import { validatePocketManifest, type ContractDiagnostic } from "./validate.ts";

export interface ResolveBuildRequest {
  readonly target: string;
}

export type ResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedBuildPlan }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

function capabilityPath(kind: "enhances" | "requires", index: number): string {
  return `/engine/capabilities/${kind}/${index}`;
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function validateViewport(
  manifest: PocketManifestV2,
  profile: TargetProfile,
  diagnostics: ContractDiagnostic[],
): void {
  const { logical, presentation } = manifest.app.viewport;
  const { physicalViewport, logicalViewports, presentations } = profile.display;
  if (!logicalViewports.some((supported) => sameViewport(supported, logical))) {
    diagnostics.push({
      code: "viewport.logicalUnsupported",
      path: "/app/viewport/logical",
      message: `target does not support logical viewport ${logical[0]}x${logical[1]}`,
    });
  }
  if (!presentations.includes(presentation)) {
    diagnostics.push({
      code: "viewport.presentationUnsupported",
      path: "/app/viewport/presentation",
      message: `target does not support ${JSON.stringify(presentation)} presentation`,
    });
  }
  if (presentation === "native" && !sameViewport(logical, physicalViewport)) {
    diagnostics.push({
      code: "viewport.nativeMismatch",
      path: "/app/viewport",
      message: "native presentation requires equal logical and physical viewports",
    });
  }
  if (presentation === "integer-fit") {
    const x = physicalViewport[0] / logical[0];
    const y = physicalViewport[1] / logical[1];
    if (!Number.isInteger(x) || x < 1 || x !== y) {
      diagnostics.push({
        code: "viewport.integerFitMismatch",
        path: "/app/viewport",
        message: "integer-fit requires one positive integer scale on both axes",
      });
    }
  }
}

/** Validate framework-owned registry data before trusting it in resolution. */
export function validatePlatformContractRegistry(
  registry: PlatformContractRegistry,
): readonly ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const known = new Set<string>();
  registry.capabilities.forEach((capability, index) => {
    if (known.has(capability)) {
      diagnostics.push({
        code: "registry.duplicateCapability",
        path: `/capabilities/${index}`,
        message: `capability ${JSON.stringify(capability)} is registered more than once`,
      });
    }
    known.add(capability);
  });

  for (const [targetId, target] of Object.entries(registry.targets)) {
    if (
      !Number.isInteger(target.display.rasterDensity) ||
      target.display.rasterDensity < 1 ||
      target.display.rasterDensity > 255
    ) {
      diagnostics.push({
        code: "registry.invalidRasterDensity",
        path: `/targets/${targetId}/display/rasterDensity`,
        message: "target rasterDensity must be an integer from 1 through 255",
      });
    }
    const provided = new Set<string>();
    target.capabilities.forEach((capability, index) => {
      const path = `/targets/${targetId}/capabilities/${index}`;
      if (!known.has(capability)) {
        diagnostics.push({
          code: "registry.unknownCapability",
          path,
          message: `target provides unregistered capability ${JSON.stringify(capability)}`,
        });
      }
      if (provided.has(capability)) {
        diagnostics.push({
          code: "registry.duplicateCapability",
          path,
          message: `target provides capability ${JSON.stringify(capability)} more than once`,
        });
      }
      provided.add(capability);
    });
  }
  return diagnostics;
}

export function resolveBuildPlan(
  manifest: PocketManifestV2,
  request: ResolveBuildRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): ResolutionResult {
  const diagnostics: ContractDiagnostic[] = [...validatePlatformContractRegistry(registry)];
  const profile = registry.targets[request.target];
  if (!profile) {
    diagnostics.push({
      code: "target.unknown",
      path: "/target",
      message: `unknown target ${JSON.stringify(request.target)}; available: ${Object.keys(registry.targets).sort().join(", ")}`,
    });
    return { ok: false, diagnostics };
  }

  validateViewport(manifest, profile, diagnostics);

  const known = new Set<string>(registry.capabilities);
  const provided = new Set<string>(profile.capabilities);
  const seen = new Map<string, string>();
  const featureAvailability = new Map<string, boolean>();

  for (const [kind, capabilities] of [
    ["requires", manifest.engine.capabilities.requires],
    ["enhances", manifest.engine.capabilities.enhances ?? []],
  ] as const) {
    capabilities.forEach((capability, index) => {
      const path = capabilityPath(kind, index);
      const previous = seen.get(capability);
      if (previous) {
        diagnostics.push({
          code: "capability.duplicate",
          path,
          message: `capability was already declared at ${previous}`,
        });
        return;
      }
      seen.set(capability, path);

      if (!known.has(capability)) {
        diagnostics.push({
          code: "capability.unknown",
          path,
          message: `unknown capability ${JSON.stringify(capability)}`,
        });
        return;
      }

      const available = provided.has(capability);
      const required = kind === "requires";
      if (required && !available) {
        diagnostics.push({
          code: "capability.unavailable",
          path,
          message: `target ${request.target} does not provide ${capability}`,
        });
        return;
      }
      featureAvailability.set(capability, required || available);
    });
  }

  // A derived output must satisfy the same artifact-name contract an explicit
  // one is validated against — an entry like "app/Main.tsx" or "app/.tsx"
  // would otherwise smuggle an invalid name past the schema and fail much
  // later, inside a backend, blaming a plan the resolver itself produced.
  const OUTPUT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const output = manifest.app.output ?? manifest.app.entry.split("/").pop()!.replace(/\.tsx?$/, "");
  if (!OUTPUT_NAME.test(output)) {
    diagnostics.push({
      code: "app.outputUnderivable",
      path: manifest.app.output !== undefined ? "/app/output" : "/app/entry",
      message: `derived output ${JSON.stringify(output)} is not a valid artifact name — set app.output explicitly`,
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const logical: Viewport = [manifest.app.viewport.logical[0], manifest.app.viewport.logical[1]];
  const physical: Viewport = [profile.display.physicalViewport[0], profile.display.physicalViewport[1]];
  // Plain codepoint sort — the same ordering canonicalJson uses for the plan
  // hash, so the pretty plan.json never depends on ICU collation.
  const features = Object.fromEntries(
    [...featureAvailability.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );

  const content: ResolvedBuildPlanContent = {
    app: {
      id: manifest.id,
      title: manifest.title,
      entry: manifest.app.entry,
      output,
      framework: manifest.app.framework,
    },
    target: {
      id: request.target,
      hostAbi: profile.hostAbi,
    },
    viewport: {
      logical,
      physical,
      presentation: manifest.app.viewport.presentation,
      rasterDensity: profile.display.rasterDensity,
    },
    features,
  };
  return { ok: true, plan: finalizeBuildPlan(content) };
}

export function validateAndResolveBuildPlan(
  input: unknown,
  request: ResolveBuildRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): ResolutionResult {
  const validated = validatePocketManifest(input);
  if (!validated.ok) return validated;
  return resolveBuildPlan(validated.value, request, registry);
}
