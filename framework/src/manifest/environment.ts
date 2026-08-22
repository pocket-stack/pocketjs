import {
  pocketEnvironmentV1Schema,
  type EnvironmentInstallationState,
  type PocketEnvironmentPackageV1,
  type PocketEnvironmentV1,
  type SupervisorBackgroundPolicy,
} from "../../../contracts/spec/pocket-environment.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type PlatformContractRegistry,
} from "../../../contracts/spec/platforms.ts";
import { canonicalJson, type ResolvedBuildPlan } from "./plan.ts";
import { resolveBuildPlan } from "./resolve.ts";
import {
  validatePocketManifest,
  validateSchema,
  type ContractDiagnostic,
  type ValidationResult,
} from "./validate.ts";
import { createHash } from "node:crypto";

export interface EnvironmentPackageInput {
  /** Must exactly match an applications.packages[].manifest value. */
  readonly source: string;
  readonly manifest: unknown;
}

export interface ResolveEnvironmentRequest {
  readonly target: string;
  readonly packages: readonly EnvironmentPackageInput[];
}

export interface ResolvedEnvironmentPackage {
  readonly package: string;
  readonly source: string;
  readonly installation: Exclude<EnvironmentInstallationState, "available">;
  readonly presentation?: PocketEnvironmentPackageV1["presentation"];
  /** Complete per-package plan. The supervisor passes every host-facing fact
   *  through unchanged; it never projects this down to output/viewport. */
  readonly plan: ResolvedBuildPlan;
}

export interface ResolvedEnvironmentPlanContent {
  readonly environment: Pick<PocketEnvironmentV1, "id" | "name" | "title" | "version">;
  readonly target: {
    readonly id: string;
    readonly hostAbi: number;
  };
  readonly installation: {
    readonly model: "managed";
    readonly mutable: boolean;
    readonly packages: readonly PocketEnvironmentPackageV1[];
  };
  readonly supervisor: {
    readonly shell: string;
    readonly background: SupervisorBackgroundPolicy;
    readonly packages: readonly ResolvedEnvironmentPackage[];
  };
}

export interface ResolvedEnvironmentPlan extends ResolvedEnvironmentPlanContent {
  readonly planHash: string;
}

export type EnvironmentResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedEnvironmentPlan }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

export function validatePocketEnvironment(
  input: unknown,
): ValidationResult<PocketEnvironmentV1> {
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(input, pocketEnvironmentV1Schema, "", diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: input as PocketEnvironmentV1 };
}

function finalizeEnvironmentPlan(
  content: ResolvedEnvironmentPlanContent,
): ResolvedEnvironmentPlan {
  const digest = createHash("sha256").update(canonicalJson(content)).digest("hex");
  return { ...content, planHash: `sha256:${digest}` };
}

function sameViewport(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/**
 * Resolve an Environment into one shell plan plus the complete plans of every
 * currently installed package. Available packages remain installation-model
 * data and are not handed to RuntimeSupervisor until an Environment installs
 * and resolves them.
 */
export function resolveEnvironmentPlan(
  environment: PocketEnvironmentV1,
  request: ResolveEnvironmentRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): EnvironmentResolutionResult {
  const diagnostics: ContractDiagnostic[] = [];
  const profile = registry.targets[request.target];
  if (!profile) {
    return {
      ok: false,
      diagnostics: [{
        code: "target.unknown",
        path: "/target",
        message: `unknown target ${JSON.stringify(request.target)}`,
      }],
    };
  }
  if (!profile.runtime?.supervisor) {
    diagnostics.push({
      code: "runtime.supervisorUnavailable",
      path: "/runtime/supervisor",
      message: `target ${request.target} does not provide a runtime supervisor`,
    });
  }

  const bySource = new Map(request.packages.map((item) => [item.source, item.manifest]));
  const seenPackages = new Set<string>();
  const seenSources = new Set<string>();
  const resolved: ResolvedEnvironmentPackage[] = [];
  let shellEntry: PocketEnvironmentPackageV1 | undefined;

  environment.applications.packages.forEach((entry, index) => {
    const path = `/applications/packages/${index}`;
    if (seenPackages.has(entry.package)) {
      diagnostics.push({
        code: "environment.duplicatePackage",
        path: `${path}/package`,
        message: `package ${JSON.stringify(entry.package)} appears more than once`,
      });
    }
    seenPackages.add(entry.package);
    if (seenSources.has(entry.manifest)) {
      diagnostics.push({
        code: "environment.duplicateManifest",
        path: `${path}/manifest`,
        message: `manifest ${JSON.stringify(entry.manifest)} appears more than once`,
      });
    }
    seenSources.add(entry.manifest);
    if (entry.package === environment.runtime.supervisor.shell) shellEntry = entry;

    const input = bySource.get(entry.manifest);
    if (input === undefined) {
      diagnostics.push({
        code: "environment.manifestMissing",
        path: `${path}/manifest`,
        message: `no package manifest input was supplied for ${JSON.stringify(entry.manifest)}`,
      });
      return;
    }
    const manifestValidation = validatePocketManifest(input);
    if (!manifestValidation.ok) {
      for (const diagnostic of manifestValidation.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `${path}/resolved${diagnostic.path}`,
        });
      }
      return;
    }
    if (manifestValidation.value.id !== entry.package) {
      diagnostics.push({
        code: "environment.packageMismatch",
        path: `${path}/package`,
        message: `entry names ${entry.package}, manifest declares ${manifestValidation.value.id}`,
      });
      return;
    }
    // Available entries belong to the Environment catalog but have no running
    // realm or target plan. Installation resolves admission before adding the
    // package to RuntimeSupervisor.
    if (entry.installation === "available") return;

    const packageResolution = resolveBuildPlan(
      manifestValidation.value,
      { target: request.target },
      registry,
    );
    if (!packageResolution.ok) {
      for (const diagnostic of packageResolution.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `${path}/resolved${diagnostic.path}`,
        });
      }
      return;
    }
    if (
      entry.presentation &&
      !sameViewport(entry.presentation.viewport, packageResolution.plan.viewport.logical)
    ) {
      diagnostics.push({
        code: "environment.presentationViewportMismatch",
        path: `${path}/presentation/viewport`,
        message:
          `environment requests ${entry.presentation.viewport[0]}x${entry.presentation.viewport[1]}, ` +
          `package plan resolves ${packageResolution.plan.viewport.logical[0]}x${packageResolution.plan.viewport.logical[1]}`,
      });
    }
    resolved.push({
      package: entry.package,
      source: entry.manifest,
      installation: entry.installation,
      ...(entry.presentation ? { presentation: entry.presentation } : {}),
      plan: packageResolution.plan,
    });
  });

  if (!shellEntry) {
    diagnostics.push({
      code: "environment.shellMissing",
      path: "/runtime/supervisor/shell",
      message: "the supervisor shell must name one applications.packages entry",
    });
  } else if (shellEntry.installation !== "required") {
    diagnostics.push({
      code: "environment.shellRemovable",
      path: "/runtime/supervisor/shell",
      message: "the supervisor shell package must have installation=required",
    });
  }

  const shellPlan = resolved.find((item) => item.package === environment.runtime.supervisor.shell);
  if (shellPlan && shellPlan.plan.features["runtime.supervisor"] !== true) {
    diagnostics.push({
      code: "environment.shellCapabilityMissing",
      path: "/runtime/supervisor/shell",
      message: "the shell package must require runtime.supervisor",
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    plan: finalizeEnvironmentPlan({
      environment: {
        id: environment.id,
        name: environment.name,
        title: environment.title,
        version: environment.version,
      },
      target: { id: request.target, hostAbi: profile.hostAbi },
      installation: {
        model: environment.applications.model,
        mutable: environment.applications.mutable,
        packages: environment.applications.packages,
      },
      supervisor: {
        shell: environment.runtime.supervisor.shell,
        background: environment.runtime.supervisor.background,
        packages: resolved,
      },
    }),
  };
}

export function validateAndResolveEnvironmentPlan(
  input: unknown,
  request: ResolveEnvironmentRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): EnvironmentResolutionResult {
  const validated = validatePocketEnvironment(input);
  if (!validated.ok) return validated;
  return resolveEnvironmentPlan(validated.value, request, registry);
}
