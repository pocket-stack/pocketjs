import {
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../framework/src/manifest/plan.ts";
import type { NetworkPrivateBuildContext } from
  "../framework/compiler/network-private.ts";
import {
  networkV1FeatureIdsFromBuildPlan,
  networkV1PlanHashBytes,
} from "../contracts/spec/network/network-v1.ts";

export type BundleArtifactMode = "iife" | "network-factory";

/**
 * Select the artifact ABI after checking the plan checksum. Network authority
 * and an explicitly selected factory-aware loader must agree in both
 * directions; legacy loaders must never receive a callable artifact by
 * accident.
 */
export function selectBundleArtifactMode(
  plan: ResolvedBuildPlan | undefined,
  networkFactoryRequested: boolean,
): BundleArtifactMode {
  if (plan !== undefined && !verifyPlanHash(plan)) {
    throw new TypeError("PocketJS network factory: invalid ResolvedBuildPlan checksum");
  }

  const hasNetworkPlan = plan?.network !== undefined;
  if (hasNetworkPlan && !networkFactoryRequested) {
    throw new TypeError(
      "PocketJS build: a network ResolvedBuildPlan requires a factory-aware loader (--network-factory)",
    );
  }
  if (!hasNetworkPlan && networkFactoryRequested) {
    throw new TypeError(
      "PocketJS build: --network-factory requires a ResolvedBuildPlan with network admission",
    );
  }
  return hasNetworkPlan ? "network-factory" : "iife";
}

/**
 * Derive identifiers from the verified plan so they are artifact-specific but
 * reproducible. They are transport names between the compiler and finalizer,
 * never an application-facing ABI.
 */
export function createNetworkFactoryBuildContext(
  plan: ResolvedBuildPlan,
): NetworkPrivateBuildContext {
  if (!verifyPlanHash(plan) || plan.network === undefined) {
    throw new TypeError(
      "PocketJS network factory: private context requires a verified network plan",
    );
  }
  const digest = /^sha256:([0-9a-f]{64})$/.exec(plan.planHash)?.[1];
  if (!digest) {
    throw new TypeError("PocketJS network factory: unsupported plan checksum");
  }
  const token = digest.slice(0, 24);
  const planHashBytes = Object.freeze(Array.from(networkV1PlanHashBytes(plan.planHash)));
  const featureIds = Object.freeze(Array.from(networkV1FeatureIdsFromBuildPlan(plan.features)));
  return Object.freeze({
    token,
    bootstrapSpecifier: `pocketjs:network-bootstrap-v1-${token}`,
    takeIdentifier: `__pocket_take_${token}`,
    bindingIdentifier: `__pocket_binding_${token}`,
    pendingIdentifier: `__pocket_pending_${token}`,
    argumentsIdentifier: `__pocket_arguments_${token}`,
    planHashBytes,
    featureIds,
  });
}

function assertContext(context: NetworkPrivateBuildContext): void {
  if (
    !/^[0-9a-f]{24}$/.test(context.token) ||
    context.bootstrapSpecifier !==
      `pocketjs:network-bootstrap-v1-${context.token}` ||
    context.takeIdentifier !== `__pocket_take_${context.token}` ||
    context.bindingIdentifier !== `__pocket_binding_${context.token}` ||
    context.pendingIdentifier !== `__pocket_pending_${context.token}` ||
    context.argumentsIdentifier !== `__pocket_arguments_${context.token}` ||
    !Array.isArray(context.planHashBytes) ||
    !Object.isFrozen(context.planHashBytes) ||
    context.planHashBytes.length !== 32 ||
    context.planHashBytes.some(
      (byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
    ) ||
    !Array.isArray(context.featureIds) ||
    !Object.isFrozen(context.featureIds) ||
    context.featureIds.some(
      (feature, index) =>
        !Number.isInteger(feature) ||
        feature <= 0 ||
        feature > 0xffff ||
        (index > 0 && feature <= context.featureIds[index - 1]!),
    )
  ) {
    throw new TypeError("PocketJS network factory: invalid private build context");
  }
}

/**
 * Wrap Bun's deferred bootstrap IIFE. The public factory deliberately has no
 * formal binding parameter. A per-artifact one-shot capture function transfers
 * the frozen Host table into the compiler-only framework module, clears both
 * its pending slot and the factory argument, and then deletes itself before
 * application initialization begins.
 */
export function wrapNetworkBundleFactory(
  bundle: string,
  context: NetworkPrivateBuildContext,
): string {
  if (typeof bundle !== "string" || bundle.length === 0) {
    throw new TypeError("PocketJS network factory: bundle source must not be empty");
  }
  assertContext(context);

  const body = bundle
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  return `(function () {
  "use strict";
  let __pocketNetworkFactoryConsumedV1 = false;
  return function () {
    if (__pocketNetworkFactoryConsumedV1) {
      throw new TypeError("PocketJS network bundle factory was already invoked");
    }
    __pocketNetworkFactoryConsumedV1 = true;
    if (arguments.length !== 1) {
      throw new TypeError("PocketJS network bundle factory requires exactly one binding argument");
    }
    if (
      arguments[0] === null ||
      typeof arguments[0] !== "object" ||
      !Object.isFrozen(arguments[0])
    ) {
      throw new TypeError("PocketJS network bundle factory requires a frozen binding table");
    }
    let ${context.pendingIdentifier} = arguments[0];
    let ${context.argumentsIdentifier} = arguments;
    let ${context.takeIdentifier} = function () {
      if (${context.pendingIdentifier} === undefined) {
        throw new TypeError("PocketJS private network binding was already captured");
      }
      const value = ${context.pendingIdentifier};
      ${context.pendingIdentifier} = undefined;
      ${context.argumentsIdentifier}[0] = undefined;
      ${context.argumentsIdentifier} = undefined;
      ${context.takeIdentifier} = undefined;
      return value;
    };
    return (function () {
${body}
    }).call(undefined);
  };
})()`;
}

/** Preserve legacy artifacts byte-for-byte; wrap only the admitted mode. */
export function finalizeBundleArtifact(
  bundle: string,
  mode: BundleArtifactMode,
  context?: NetworkPrivateBuildContext,
): string {
  if (mode === "iife") return bundle;
  if (context === undefined) {
    throw new TypeError("PocketJS network factory: missing private build context");
  }
  return wrapNetworkBundleFactory(bundle, context);
}
