import { DYNAMIC_FORMS, TARGET_FORMS } from "../../../contracts/spec/platforms.ts";
import type { PocketManifestV2 } from "../../../contracts/spec/pocket-manifest.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type PlatformContractRegistry,
  type PresentationMode,
  type TargetProfile,
  type Viewport,
} from "../../../contracts/spec/platforms.ts";
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

/** The app's viewport intent, normalized: the bare `{logical, presentation}`
 *  spelling is shorthand for `{fixed: ...}`. */
function normalizeViewport(viewport: PocketManifestV2["app"]["viewport"]): {
  fixed?: { logical: Viewport; presentation: PresentationMode };
  dynamic?: { default: Viewport; min?: Viewport; max?: Viewport };
} {
  if ("logical" in viewport) {
    return { fixed: { logical: viewport.logical, presentation: viewport.presentation } };
  }
  return { fixed: viewport.fixed as never, dynamic: viewport.dynamic as never };
}

const within = (v: Viewport, min: Viewport, max: Viewport): boolean =>
  v[0] >= min[0] && v[1] >= min[1] && v[0] <= max[0] && v[1] <= max[1];

/**
 * Pick and validate the viewport variant the target's FORM calls for.
 * Window/widget forms take the app's `dynamic` variant (or its `fixed` one
 * size-locked, when the target opts in via acceptsFixed); every other form
 * requires `fixed`. Returns the resolved plan viewport, or null after
 * pushing diagnostics.
 */
function resolveViewport(
  manifest: PocketManifestV2,
  profile: TargetProfile,
  diagnostics: ContractDiagnostic[],
): { logical: Viewport; presentation: PresentationMode; physical: Viewport } | null {
  const viewport = normalizeViewport(manifest.app.viewport);
  const { physicalViewport, logicalViewports, dynamicViewport, presentations, rasterDensity } =
    profile.display;
  const dynamicTarget = DYNAMIC_FORMS.includes(profile.form);

  if (dynamicTarget) {
    // Registry validation already records the actionable diagnostic. Do not
    // dereference malformed framework-owned data and turn it into a runtime
    // TypeError before the caller can receive that diagnostic.
    if (!dynamicViewport) return null;
    const range = dynamicViewport;
    if (viewport.dynamic) {
      const size = viewport.dynamic.default;
      if (!within(size, range.min, range.max)) {
        diagnostics.push({
          code: "viewport.logicalUnsupported",
          path: "/app/viewport/dynamic/default",
          message: `target admits ${range.min[0]}x${range.min[1]} through ${range.max[0]}x${range.max[1]}, not ${size[0]}x${size[1]}`,
        });
        return null;
      }
      return {
        logical: size,
        presentation: "native",
        physical: [size[0] * rasterDensity, size[1] * rasterDensity],
      };
    }
    if (viewport.fixed) {
      if (!range.acceptsFixed) {
        diagnostics.push({
          code: "viewport.fixedUnhosted",
          path: "/app/viewport",
          message: `${profile.form}-form target does not host fixed-viewport apps — declare a dynamic viewport variant`,
        });
        return null;
      }
      const size = viewport.fixed.logical;
      if (!within(size, range.min, range.max)) {
        diagnostics.push({
          code: "viewport.logicalUnsupported",
          path: "/app/viewport/fixed/logical",
          message: `target admits ${range.min[0]}x${range.min[1]} through ${range.max[0]}x${range.max[1]}, not ${size[0]}x${size[1]}`,
        });
        return null;
      }
      // Size-locked window: presented 1 logical px = density physical px.
      return {
        logical: size,
        presentation: "native",
        physical: [size[0] * rasterDensity, size[1] * rasterDensity],
      };
    }
    diagnostics.push({
      code: "viewport.dynamicRequired",
      path: "/app/viewport",
      message: "target has a dynamic window — declare a dynamic viewport variant",
    });
    return null;
  }

  if (!viewport.fixed) {
    diagnostics.push({
      code: "viewport.fixedRequired",
      path: "/app/viewport",
      message: "target has a fixed screen — declare a fixed viewport variant",
    });
    return null;
  }
  const { logical, presentation } = viewport.fixed;
  const fixedPath = "logical" in manifest.app.viewport ? "/app/viewport" : "/app/viewport/fixed";
  let ok = true;
  if (!logicalViewports.some((supported) => sameViewport(supported, logical))) {
    diagnostics.push({
      code: "viewport.logicalUnsupported",
      path: `${fixedPath}/logical`,
      message: `target does not support logical viewport ${logical[0]}x${logical[1]}`,
    });
    ok = false;
  }
  if (!presentations.includes(presentation)) {
    diagnostics.push({
      code: "viewport.presentationUnsupported",
      path: `${fixedPath}/presentation`,
      message: `target does not support ${JSON.stringify(presentation)} presentation`,
    });
    ok = false;
  }
  // Native presentation: one logical px maps to rasterDensity physical px.
  if (
    presentation === "native" &&
    !sameViewport([logical[0] * rasterDensity, logical[1] * rasterDensity], physicalViewport)
  ) {
    diagnostics.push({
      code: "viewport.nativeMismatch",
      path: fixedPath,
      message: "native presentation requires the logical viewport to fill the panel",
    });
    ok = false;
  }
  if (presentation === "integer-fit") {
    const scale = Math.floor(
      Math.min(physicalViewport[0] / logical[0], physicalViewport[1] / logical[1]),
    );
    if (scale < 1) {
      diagnostics.push({
        code: "viewport.integerFitMismatch",
        path: fixedPath,
        message: "integer-fit requires the logical viewport to fit at a positive integer scale",
      });
      ok = false;
    }
  }
  return ok ? { logical, presentation, physical: [physicalViewport[0], physicalViewport[1]] } : null;
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
    if (!TARGET_FORMS.includes(target.form)) {
      diagnostics.push({
        code: "registry.invalidForm",
        path: `/targets/${targetId}/form`,
        message: `target form must be one of ${TARGET_FORMS.join(", ")}`,
      });
    }
    const dynamicForm = DYNAMIC_FORMS.includes(target.form);
    if (dynamicForm && !target.display.dynamicViewport) {
      diagnostics.push({
        code: "registry.dynamicViewportMissing",
        path: `/targets/${targetId}/display`,
        message: `${target.form}-form targets must declare display.dynamicViewport`,
      });
    }
    if (!dynamicForm && target.display.dynamicViewport) {
      diagnostics.push({
        code: "registry.dynamicViewportForbidden",
        path: `/targets/${targetId}/display/dynamicViewport`,
        message: `${target.form}-form targets have a fixed screen — remove dynamicViewport`,
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

  // This resolver only produces guest-class plans. AOT-class packages are
  // admitted at compile time by their compiler family (see vapor/BOARDS.md);
  // a manifest that ships no guest artifact has nothing for us to build.
  const executionClasses = manifest.execution?.classes ?? ["guest"];
  if (!executionClasses.includes("guest")) {
    diagnostics.push({
      code: "execution.guestExcluded",
      path: "/execution/classes",
      message: "manifest declares no guest execution class; this resolver only builds guest plans",
    });
  }

  const resolvedViewport = resolveViewport(manifest, profile, diagnostics);

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

  if (diagnostics.length > 0 || !resolvedViewport) return { ok: false, diagnostics };

  const logical: Viewport = [resolvedViewport.logical[0], resolvedViewport.logical[1]];
  const physical: Viewport = [resolvedViewport.physical[0], resolvedViewport.physical[1]];
  // Plain codepoint sort — the same ordering canonicalJson uses for the plan
  // hash, so the pretty plan.json never depends on ICU collation.
  const features = Object.fromEntries(
    [...featureAvailability.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );

  const content: ResolvedBuildPlanContent = {
    app: {
      id: manifest.id,
      title: manifest.title,
      version: manifest.version,
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
      presentation: resolvedViewport.presentation,
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
