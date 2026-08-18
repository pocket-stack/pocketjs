/** Private storage for the build-admitted network limits projection. */

export interface InstalledNetworkLimit {
  readonly default: number;
  readonly hard: number;
  readonly minimum: number;
}

export interface InstalledNetworkLimitsSnapshot {
  readonly values: readonly Readonly<{
    readonly name: string;
    readonly default: number;
    readonly hard: number;
    readonly minimum: number;
  }>[];
  readonly features: readonly string[];
}

export type InstalledNetworkLimitsProvider = (
  protocol: "http" | "websocket" | "mqtt" | "tcp" | "udp" | undefined,
  role: "client" | "server" | undefined,
) => InstalledNetworkLimitsSnapshot;

let installedProvider: InstalledNetworkLimitsProvider | undefined;

/** Compiler-private one-shot mount hook; this file is not a package export. */
export function installNetworkLimitsProvider(
  provider: InstalledNetworkLimitsProvider,
): void {
  if (installedProvider !== undefined) {
    throw new TypeError("PocketJS network limits provider is already installed");
  }
  installedProvider = provider;
}

export function queryInstalledNetworkLimits(
  protocol: "http" | "websocket" | "mqtt" | "tcp" | "udp" | undefined,
  role: "client" | "server" | undefined,
): InstalledNetworkLimitsSnapshot | undefined {
  return installedProvider?.(protocol, role);
}
