import type {
  CapabilityRequirement,
  PackageMetadata,
  PocketManifestV2,
} from "../../spec/pocket-manifest.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type CapabilityDefinition,
  type CapabilityParameterDefinition,
  type PlatformContractRegistry,
  type ProvidedCapability,
  type TargetProfile,
  type Viewport,
} from "../../spec/platforms.ts";
import { canonicalJson, finalizeBuildPlan, type ResolvedBuildPlan, type ResolvedBuildPlanContent } from "./plan.ts";
import { validatePocketManifest, type ContractDiagnostic } from "./validate.ts";

export interface ResolveBuildRequest {
  readonly target: string;
}

export type ResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedBuildPlan }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

function capabilityPath(kind: "enhances" | "requires", index: number, suffix = ""): string {
  return `/engine/capabilities/${kind}/${index}${suffix}`;
}

function valueMatchesDefinition(value: unknown, definition: CapabilityParameterDefinition): boolean {
  switch (definition.kind) {
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
  }
}

function validateParameters(
  capability: CapabilityRequirement | ProvidedCapability,
  definition: CapabilityDefinition,
  path: string,
  diagnostics: ContractDiagnostic[],
): boolean {
  let valid = true;
  const parameters = capability.parameters ?? {};
  for (const key of Object.keys(parameters)) {
    if (!definition.parameters[key]) {
      diagnostics.push({
        code: "capability.unknownParameter",
        path: `${path}/parameters/${key}`,
        message: `capability has no parameter ${JSON.stringify(key)}`,
      });
      valid = false;
    }
  }
  for (const [key, parameterDefinition] of Object.entries(definition.parameters)) {
    const value = parameters[key];
    if (value === undefined) {
      if (parameterDefinition.required) {
        diagnostics.push({
          code: "capability.missingParameter",
          path: `${path}/parameters/${key}`,
          message: "required capability parameter is missing",
        });
        valid = false;
      }
      continue;
    }
    if (!valueMatchesDefinition(value, parameterDefinition)) {
      diagnostics.push({
        code: "capability.parameterType",
        path: `${path}/parameters/${key}`,
        message: `expected ${parameterDefinition.kind}`,
      });
      valid = false;
      continue;
    }
    if (
      parameterDefinition.minimum !== undefined &&
      typeof value === "number" &&
      value < parameterDefinition.minimum
    ) {
      diagnostics.push({
        code: "capability.parameterMinimum",
        path: `${path}/parameters/${key}`,
        message: `minimum value is ${parameterDefinition.minimum}`,
      });
      valid = false;
    }
  }
  return valid;
}

function targetSatisfies(
  requirement: CapabilityRequirement,
  provided: ProvidedCapability | undefined,
  definition: CapabilityDefinition,
): boolean {
  if (!provided || provided.version !== requirement.version) return false;
  const requiredParameters = requirement.parameters ?? {};
  const providedParameters = provided.parameters ?? {};
  for (const [key, requested] of Object.entries(requiredParameters)) {
    const actual = providedParameters[key];
    if (actual === undefined) return false;
    const relation = definition.parameters[key]?.relation;
    if (relation === "at-least") {
      if (typeof requested !== "number" || typeof actual !== "number" || actual < requested) return false;
    } else if (actual !== requested) {
      return false;
    }
  }
  return true;
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function scale(numerator: number, denominator: number) {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor } as const;
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

function resolvePackageMetadata(
  manifest: PocketManifestV2,
  profile: TargetProfile,
): PackageMetadata {
  const defaults = Object.fromEntries(
    Object.entries(profile.packageDefaults).map(([key, value]) => [
      key,
      typeof value === "object" ? manifest.title : value,
    ]),
  );
  const overrides = (
    (manifest.packages ?? {}) as Readonly<Record<string, Readonly<Record<string, boolean | number | string>>>>
  )[profile.packageFormat] ?? {};
  return { ...defaults, ...overrides };
}

/** Validate framework-owned registry data before trusting it in resolution. */
export function validatePlatformContractRegistry(
  registry: PlatformContractRegistry,
): readonly ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  for (const [targetId, target] of Object.entries(registry.targets)) {
    for (const [capabilityId, provided] of Object.entries(target.capabilities)) {
      const definition = registry.capabilities[capabilityId];
      const path = `/targets/${targetId}/capabilities/${capabilityId}`;
      if (!definition) {
        diagnostics.push({ code: "registry.unknownCapability", path, message: "target provides an unregistered capability" });
        continue;
      }
      if (provided!.version !== definition.version) {
        diagnostics.push({
          code: "registry.capabilityVersion",
          path: `${path}/version`,
          message: `expected registered version ${definition.version}`,
        });
      }
      validateParameters(provided!, definition, path, diagnostics);
    }
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

  if (manifest.engine.abi !== profile.hostAbi) {
    diagnostics.push({
      code: "engine.abiMismatch",
      path: "/engine/abi",
      message: `app requires host ABI ${manifest.engine.abi}, target provides ${profile.hostAbi}`,
    });
  }

  const packageMetadata = resolvePackageMetadata(manifest, profile);

  validateViewport(manifest, profile, diagnostics);

  const requires = manifest.engine.capabilities.requires;
  const enhances = manifest.engine.capabilities.enhances ?? [];
  const seen = new Map<string, string>();
  const resolvedRequires: ResolvedBuildPlanContent["capabilities"]["requires"][number][] = [];
  const resolvedEnhances: ResolvedBuildPlanContent["capabilities"]["enhances"][number][] = [];

  for (const [kind, requirements] of [["requires", requires], ["enhances", enhances]] as const) {
    requirements.forEach((requirement, index) => {
      const path = capabilityPath(kind, index);
      const previous = seen.get(requirement.id);
      if (previous) {
        diagnostics.push({
          code: "capability.duplicate",
          path: `${path}/id`,
          message: `capability was already declared at ${previous}`,
        });
        return;
      }
      seen.set(requirement.id, `${path}/id`);

      const definition = registry.capabilities[requirement.id];
      if (!definition) {
        diagnostics.push({
          code: "capability.unknown",
          path: `${path}/id`,
          message: `unknown capability ${JSON.stringify(requirement.id)}`,
        });
        return;
      }
      if (requirement.version !== definition.version) {
        diagnostics.push({
          code: "capability.version",
          path: `${path}/version`,
          message: `registered capability version is ${definition.version}`,
        });
        return;
      }
      if (!validateParameters(requirement, definition, path, diagnostics)) return;

      const provided = profile.capabilities[requirement.id];
      const available = targetSatisfies(requirement, provided, definition);
      if (kind === "requires") {
        if (!available) {
          diagnostics.push({
            code: "capability.unavailable",
            path,
            message: `target ${request.target} does not satisfy ${requirement.id}@${requirement.version}`,
          });
        } else {
          resolvedRequires.push({ requirement, provided: provided! });
        }
      } else {
        resolvedEnhances.push({
          requirement,
          status: available ? "available" : "unavailable",
          provided: available ? provided! : null,
        });
      }
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const logical: Viewport = [manifest.app.viewport.logical[0], manifest.app.viewport.logical[1]];
  const physical: Viewport = [profile.display.physicalViewport[0], profile.display.physicalViewport[1]];
  const sortCapabilities = <T extends { readonly requirement: CapabilityRequirement }>(items: T[]): T[] =>
    items.sort((left, right) => {
      const leftId = left.requirement.id;
      const rightId = right.requirement.id;
      if (leftId !== rightId) return leftId < rightId ? -1 : 1;
      const leftContract = canonicalJson(left.requirement);
      const rightContract = canonicalJson(right.requirement);
      return leftContract === rightContract ? 0 : leftContract < rightContract ? -1 : 1;
    });

  const content: ResolvedBuildPlanContent = {
    pocket: 2,
    app: {
      id: manifest.id,
      name: manifest.name,
      title: manifest.title,
      version: manifest.version,
      entry: manifest.app.entry,
      output: manifest.app.output ?? manifest.app.entry.split("/").pop()!.replace(/\.tsx?$/, ""),
      framework: manifest.app.framework,
      simulationHz: manifest.app.simulationHz,
      viewport: { logical, presentation: manifest.app.viewport.presentation },
    },
    target: {
      id: request.target,
      profileVersion: profile.profileVersion,
      hostAbi: profile.hostAbi,
    },
    package: {
      format: profile.packageFormat,
      metadata: packageMetadata,
    },
    viewport: {
      logical,
      physical,
      presentation: manifest.app.viewport.presentation,
      scale: {
        x: scale(physical[0], logical[0]),
        y: scale(physical[1], logical[1]),
      },
    },
    capabilities: {
      requires: sortCapabilities(resolvedRequires),
      enhances: sortCapabilities(resolvedEnhances),
    },
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
