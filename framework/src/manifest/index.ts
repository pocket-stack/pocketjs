/** Stable API for Pocket manifests and custom native hosts. */
export {
  POCKET_MANIFEST_SCHEMA_ID,
  POCKET_MANIFEST_VERSION,
  pocketManifestV2Schema,
  type PocketManifestV2,
} from "../../../contracts/spec/pocket-manifest.ts";
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
export { vitaTitleId } from "./vita-package.ts";
