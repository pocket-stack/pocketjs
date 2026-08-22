/** Stable API for Pocket manifests and custom native hosts. */
export {
  POCKET_MANIFEST_SCHEMA_ID,
  POCKET_MANIFEST_VERSION,
  pocketManifestV2Schema,
  type PocketManifestV2,
} from "../../../contracts/spec/pocket-manifest.ts";
export {
  POCKET_ENVIRONMENT_SCHEMA_ID,
  POCKET_ENVIRONMENT_VERSION,
  pocketEnvironmentV1Schema,
  type EnvironmentInstallationState,
  type PocketEnvironmentPackageV1,
  type PocketEnvironmentV1,
  type SupervisorBackgroundPolicy,
} from "../../../contracts/spec/pocket-environment.ts";
export {
  type PocketCapabilityId,
  type PresentationMode,
  type Viewport,
} from "../../../contracts/spec/platforms.ts";
export {
  extractHostBuildInputs,
  hostBuildEnvironment,
  type ExtractHostBuildInputsOptions,
  type HostBuildEnvironmentOptions,
  type HostBuildInputs,
} from "./host-build-inputs.ts";
export {
  validatePocketManifest,
  type ContractDiagnostic,
  type ValidationResult,
} from "./validate.ts";
export {
  resolveEnvironmentPlan,
  validateAndResolveEnvironmentPlan,
  validatePocketEnvironment,
  type EnvironmentPackageInput,
  type EnvironmentResolutionResult,
  type ResolvedEnvironmentPackage,
  type ResolvedEnvironmentPlan,
} from "./environment.ts";
export { vitaTitleId } from "./vita-package.ts";
