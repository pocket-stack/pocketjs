/** Compiler-only module id. It is never a package export or a disk module. */
export const NETWORK_PRIVATE_SPECIFIER = "pocketjs:internal/network-v1";

/** All specifiers in this namespace are reserved to the PocketJS compiler. */
export const NETWORK_PRIVATE_PREFIX = "pocketjs:internal/";

/** Legacy source sentinel rewritten only while compiling engine-owned code. */
export const NETWORK_BINDING_RESERVED_IDENTIFIER =
  "__POCKET_NETWORK_BINDING_V1__";

/** Name used by the unsafe first factory spike; retained only as an attack probe. */
export const LEGACY_NETWORK_FACTORY_PARAMETER =
  "__pocketNetworkBindingV1FactoryParameter";

/** Per-artifact names shared by the compiler plugin and factory finalizer. */
export interface NetworkPrivateBuildContext {
  readonly token: string;
  readonly bootstrapSpecifier: string;
  readonly takeIdentifier: string;
  readonly bindingIdentifier: string;
  readonly pendingIdentifier: string;
  readonly argumentsIdentifier: string;
  /** Raw digest bytes from the already-verified ResolvedBuildPlan. */
  readonly planHashBytes: readonly number[];
  /** Exact, sorted numeric projection of true network.* plan features. */
  readonly featureIds: readonly number[];
  /**
   * Compiler-internal permit for the exact ESP formal hardware-smoke
   * artifact. Normal build-context creation never sets this field.
   */
  readonly testOnlyStagedHttpClientFetch?: true;
  /**
   * Compiler-internal permit for the exact ESP formal TLS hardware-smoke
   * artifact. Normal build-context creation never sets this field.
   */
  readonly testOnlyStagedHttpsClientFetch?: true;
}
