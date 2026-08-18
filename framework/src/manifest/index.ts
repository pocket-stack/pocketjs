/** Stable API for Pocket manifests and custom native hosts. */
export {
  NETWORK_CONNECT_PROTOCOLS,
  NETWORK_LISTEN_PROTOCOLS,
  POCKET_MANIFEST_SCHEMA_ID,
  POCKET_MANIFEST_VERSION,
  POCKET_MANIFEST_V3_SCHEMA_ID,
  POCKET_MANIFEST_V3_VERSION,
  pocketManifestV2Schema,
  pocketManifestV3Schema,
  type CapabilityProviderAlternative,
  type NetworkConnectPermission,
  type NetworkConnectProtocol,
  type NetworkListenPermission,
  type NetworkListenPort,
  type NetworkListenProtocol,
  type NetworkPermissions,
  type NetworkPort,
  type NetworkResourceMinimum,
  type PocketManifest,
  type PocketManifestV2,
  type PocketManifestV3,
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
  type HostNetworkBuildInputs,
} from "./host-build-inputs.ts";
export type { HostNetworkResolutionProfile } from "./network.ts";
export {
  validatePocketManifest,
  type ContractDiagnostic,
  type ValidationResult,
} from "./validate.ts";
export { vitaTitleId } from "./vita-package.ts";
