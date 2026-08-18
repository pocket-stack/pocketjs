import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type {
  NetworkConnectPermission,
  NetworkListenPermission,
  NetworkPermissions,
  NetworkPort,
  NetworkResourceMinimum,
  PocketManifest,
} from "../../../contracts/spec/pocket-manifest.ts";
import {
  canonicalJson,
  type NetworkBackendRole,
  type NetworkTlsRole,
  type ResolvedNetworkBuildPlan,
  type ResolvedNetworkConnectPermission,
  type ResolvedNetworkListenPermission,
  type ResolvedNetworkPolicy,
  type ResolvedNetworkPort,
  type ResolvedNetworkProviders,
} from "./plan.ts";
import type { ContractDiagnostic } from "./validate.ts";

export interface HostNetworkResolutionProfile {
  readonly providers: ResolvedNetworkProviders;
  readonly hardLimits: NetworkResourceMinimum;
  readonly developmentBuild: boolean;
}

const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const BACKEND_CAPABILITIES: Readonly<Record<NetworkBackendRole, string>> = {
  "http.client": "network.http.client",
  "http.server": "network.http.server",
  "websocket.client": "network.websocket.client",
  "websocket.server": "network.websocket.server",
  "mqtt.client": "network.mqtt.client",
};

const TLS_CAPABILITIES: Readonly<Record<NetworkTlsRole, string>> = {
  "http.client": "network.http.client.tls",
  "http.server": "network.http.server.tls",
  "websocket.client": "network.websocket.client.tls",
  "websocket.server": "network.websocket.server.tls",
  "mqtt.client": "network.mqtt.client.tls",
  "tcp.client": "network.tcp.client.tls",
  "tcp.server": "network.tcp.server.tls",
};

const BASE_CAPABILITIES_BY_TLS_ROLE: Readonly<Record<NetworkTlsRole, string>> = {
  "http.client": "network.http.client",
  "http.server": "network.http.server",
  "websocket.client": "network.websocket.client",
  "websocket.server": "network.websocket.server",
  "mqtt.client": "network.mqtt.client",
  "tcp.client": "network.tcp.client",
  "tcp.server": "network.tcp.server",
};

const NATIVE_NETWORK_CAPABILITIES = new Set<string>([
  ...Object.values(BACKEND_CAPABILITIES),
  ...Object.values(TLS_CAPABILITIES),
  "network.websocket.server.upgrade",
  "network.tcp.client",
  "network.tcp.server",
  "network.udp",
  "network.http.client.h2",
  "network.http.server.h2",
  "network.http.client.h3",
  "network.http.server.h3",
  "network.http.client.compression",
  "network.http.server.compression",
  "network.websocket.client.compression",
  "network.websocket.server.compression",
  "network.mqtt.client.v5",
  "network.mqtt.client.qos2",
  "network.tcp.client.ipv6",
  "network.tcp.server.ipv6",
  "network.tcp.client.socket-options",
  "network.tcp.server.socket-options",
  "network.udp.ipv6",
  "network.udp.broadcast",
  "network.udp.multicast",
  ...Object.values(TLS_CAPABILITIES).flatMap((capability) => [
    `${capability}.custom-ca`,
    `${capability}.client-auth`,
    `${capability}.alpn`,
    `${capability}.v1-3`,
    `${capability}.revocation`,
  ]),
]);

const CAPABILITY_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    Object.entries(TLS_CAPABILITIES).map(([role, capability]) => [
      capability,
      [BASE_CAPABILITIES_BY_TLS_ROLE[role as NetworkTlsRole]],
    ]),
  ),
  ...Object.fromEntries(
    Object.values(TLS_CAPABILITIES).flatMap((capability) =>
      ["custom-ca", "client-auth", "alpn", "v1-3", "revocation"].map((feature) => [
        `${capability}.${feature}`,
        [capability],
      ])
    ),
  ),
  "network.websocket.server.upgrade": [
    "network.http.server",
    "network.websocket.server",
  ],
  "network.http.client.h2": ["network.http.client"],
  "network.http.server.h2": ["network.http.server"],
  "network.http.client.h3": ["network.http.client"],
  "network.http.server.h3": ["network.http.server"],
  "network.http.client.compression": ["network.http.client"],
  "network.http.server.compression": ["network.http.server"],
  "network.websocket.client.compression": ["network.websocket.client"],
  "network.websocket.server.compression": ["network.websocket.server"],
  "network.mqtt.client.v5": ["network.mqtt.client"],
  "network.mqtt.client.qos2": ["network.mqtt.client"],
  "network.tcp.client.ipv6": ["network.tcp.client"],
  "network.tcp.server.ipv6": ["network.tcp.server"],
  "network.tcp.client.socket-options": ["network.tcp.client"],
  "network.tcp.server.socket-options": ["network.tcp.server"],
  "network.udp.ipv6": ["network.udp"],
  "network.udp.broadcast": ["network.udp"],
  "network.udp.multicast": ["network.udp"],
};

const RESOURCE_KEYS = {
  runtime: ["connections", "pendingOperations", "completionDescriptors", "nativeBufferBytes"],
  stream: ["receiveQueueBytes", "sendQueueBytes"],
  http: ["connections", "inflightRequests", "headerBytes", "headerCount", "bufferedBodyBytes"],
  websocket: ["connections", "messageBytes", "queuedMessages"],
  mqtt: ["connections", "packetBytes", "qos1Inflight", "receiveQueueBytes"],
  udp: ["sockets", "datagramBytes", "receiveDatagrams"],
} as const;

function diagnostic(
  diagnostics: ContractDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function canonicalIpv4(address: string): string | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    numbers.push(value);
  }
  return numbers.join(".");
}

function ipv6Groups(address: string): number[] | null {
  if (address.includes("%") || address.startsWith("[") || address.endsWith("]")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const pieces = side.split(":");
    const groups: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const ipv4 = canonicalIpv4(piece);
        if (!ipv4) return null;
        const octets = ipv4.split(".").map(Number);
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(Number.parseInt(piece, 16));
      }
    }
    return groups;
  };

  const left = parseSide(halves[0]!);
  const right = parseSide(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function canonicalIpv6(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups || groups.length !== 8) return null;

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }

  const before = groups.slice(0, bestStart < 0 ? groups.length : bestStart)
    .map((part) => part.toString(16)).join(":");
  if (bestStart < 0) return before;
  const after = groups.slice(bestStart + bestLength).map((part) => part.toString(16)).join(":");
  return `${before}::${after}`;
}

function canonicalIp(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return canonicalIpv4(address);
  if (family === 6) return canonicalIpv6(address);
  return null;
}

function canonicalDnsName(host: string): string | null {
  const withoutRoot = host.endsWith(".") ? host.slice(0, -1) : host;
  if (withoutRoot.length === 0 || withoutRoot.endsWith(".")) return null;
  const ascii = domainToASCII(withoutRoot).toLowerCase();
  if (ascii.length === 0 || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.some((label) =>
    label.length === 0 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) return null;
  return ascii;
}

function canonicalConnectHost(host: string): string | null {
  const ip = canonicalIp(host);
  if (ip) return ip;
  if (host.startsWith("*.")) {
    const suffix = canonicalDnsName(host.slice(2));
    return suffix ? `*.${suffix}` : null;
  }
  if (host.includes("*")) return null;
  return canonicalDnsName(host);
}

function canonicalPort(port: NetworkPort): Readonly<{ min: number; max: number }> | null {
  if (typeof port === "number") return { min: port, max: port };
  if (port.min > port.max) return null;
  return { min: port.min, max: port.max };
}

function requiredCapabilitiesForProtocol(
  protocol: NetworkConnectPermission["protocol"] | NetworkListenPermission["protocol"],
  direction: "connect" | "listen",
): readonly string[] {
  const role = direction === "connect" ? "client" : "server";
  switch (protocol) {
    case "http": return [`network.http.${role}`];
    case "https": return [`network.http.${role}`, `network.http.${role}.tls`];
    case "ws": return [`network.websocket.${role}`];
    case "wss": return [`network.websocket.${role}`, `network.websocket.${role}.tls`];
    case "mqtt": return ["network.mqtt.client"];
    case "mqtts": return ["network.mqtt.client", "network.mqtt.client.tls"];
    case "tcp": return [`network.tcp.${role}`];
    case "tcp-tls": return [`network.tcp.${role}`, `network.tcp.${role}.tls`];
    case "udp": return ["network.udp"];
  }
}

function protocolIsPlaintext(protocol: string): boolean {
  return protocol === "http" || protocol === "ws" || protocol === "mqtt" || protocol === "tcp";
}

function normalizePolicy(
  permissions: NetworkPermissions,
  features: Readonly<Record<string, boolean>>,
  profile: HostNetworkResolutionProfile,
  diagnostics: ContractDiagnostic[],
): ResolvedNetworkPolicy {
  const connect: ResolvedNetworkConnectPermission[] = [];
  const connectSeen = new Set<string>();
  permissions.connect.forEach((rule, index) => {
    const path = `/permissions/network/connect/${index}`;
    const host = canonicalConnectHost(rule.host);
    if (!host) {
      diagnostic(diagnostics, "network.invalidHost", `${path}/host`, "host must be a DNS name, one-label wildcard, or canonicalizable IP literal");
      return;
    }
    const port = canonicalPort(rule.port);
    if (!port) {
      diagnostic(diagnostics, "network.invalidPortRange", `${path}/port`, "port range min must not exceed max");
      return;
    }
    for (const capability of requiredCapabilitiesForProtocol(rule.protocol, "connect")) {
      if (features[capability] !== true) {
        diagnostic(diagnostics, "network.permissionCapabilityMissing", path, `${rule.protocol} connect permission requires selected capability ${capability}`);
      }
    }
    if (protocolIsPlaintext(rule.protocol) && !permissions.insecureTransport) {
      diagnostic(diagnostics, "network.insecureTransportDisabled", path, `${rule.protocol} permission is unusable while insecureTransport is false`);
    }
    const resolved: ResolvedNetworkConnectPermission = { protocol: rule.protocol, host, port };
    const key = canonicalJson(resolved);
    if (connectSeen.has(key)) {
      diagnostic(diagnostics, "network.duplicateEndpoint", path, "endpoint duplicates an earlier connect rule after normalization");
      return;
    }
    connectSeen.add(key);
    connect.push(resolved);
  });

  const listen: ResolvedNetworkListenPermission[] = [];
  const listenSeen = new Set<string>();
  permissions.listen.forEach((rule, index) => {
    const path = `/permissions/network/listen/${index}`;
    const address = canonicalIp(rule.address);
    if (!address) {
      diagnostic(diagnostics, "network.invalidListenAddress", `${path}/address`, "listen address must be an IPv4 or IPv6 literal without a zone id");
      return;
    }
    let port: ResolvedNetworkPort | null;
    if (rule.port === "ephemeral") port = { ephemeral: true };
    else port = canonicalPort(rule.port);
    if (!port) {
      diagnostic(diagnostics, "network.invalidPortRange", `${path}/port`, "port range min must not exceed max");
      return;
    }
    for (const capability of requiredCapabilitiesForProtocol(rule.protocol, "listen")) {
      if (features[capability] !== true) {
        diagnostic(diagnostics, "network.permissionCapabilityMissing", path, `${rule.protocol} listen permission requires selected capability ${capability}`);
      }
    }
    if (protocolIsPlaintext(rule.protocol) && !permissions.insecureTransport) {
      diagnostic(diagnostics, "network.insecureTransportDisabled", path, `${rule.protocol} permission is unusable while insecureTransport is false`);
    }
    const resolved: ResolvedNetworkListenPermission = { protocol: rule.protocol, address, port };
    const key = canonicalJson(resolved);
    if (listenSeen.has(key)) {
      diagnostic(diagnostics, "network.duplicateEndpoint", path, "endpoint duplicates an earlier listen rule after normalization");
      return;
    }
    listenSeen.add(key);
    listen.push(resolved);
  });

  if (permissions.broadcast && features["network.udp.broadcast"] !== true) {
    diagnostic(diagnostics, "network.permissionCapabilityMissing", "/permissions/network/broadcast", "broadcast permission requires selected capability network.udp.broadcast");
  }
  if (permissions.multicast && features["network.udp.multicast"] !== true) {
    diagnostic(diagnostics, "network.permissionCapabilityMissing", "/permissions/network/multicast", "multicast permission requires selected capability network.udp.multicast");
  }
  const hasTls = Object.values(TLS_CAPABILITIES).some((capability) => features[capability] === true);
  if (permissions.credentials.length > 0 && !hasTls) {
    diagnostic(diagnostics, "network.credentialsWithoutTls", "/permissions/network/credentials", "credential ids require a selected role-specific TLS capability");
  }
  if (permissions.allowInvalidTlsForDevelopment && !hasTls) {
    diagnostic(diagnostics, "network.invalidTlsWithoutTls", "/permissions/network/allowInvalidTlsForDevelopment", "invalid-TLS development authority requires a selected role-specific TLS capability");
  }
  if (permissions.allowInvalidTlsForDevelopment && !profile.developmentBuild) {
    diagnostic(diagnostics, "network.productionInvalidTls", "/permissions/network/allowInvalidTlsForDevelopment", "production network profiles reject invalid-TLS development authority");
  }
  if (permissions.browserAmbientCredentials &&
    features["network.browser.http.client"] !== true &&
    features["network.browser.websocket.client"] !== true) {
    diagnostic(diagnostics, "network.permissionCapabilityMissing", "/permissions/network/browserAmbientCredentials", "browser ambient credentials require a selected Browser network capability");
  }
  if (permissions.browserOpaqueWebSocketRedirects &&
    features["network.browser.websocket.client"] !== true) {
    diagnostic(diagnostics, "network.permissionCapabilityMissing", "/permissions/network/browserOpaqueWebSocketRedirects", "opaque WebSocket redirects require selected capability network.browser.websocket.client");
  }

  const compareCanonical = (left: unknown, right: unknown): number => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  connect.sort(compareCanonical);
  listen.sort(compareCanonical);
  return {
    version: 1,
    connect,
    listen,
    localNetwork: permissions.localNetwork,
    insecureTransport: permissions.insecureTransport,
    broadcast: permissions.broadcast,
    multicast: permissions.multicast,
    allowInvalidTlsForDevelopment: permissions.allowInvalidTlsForDevelopment,
    browserAmbientCredentials: permissions.browserAmbientCredentials,
    browserOpaqueWebSocketRedirects: permissions.browserOpaqueWebSocketRedirects,
    credentials: [...permissions.credentials].sort(),
  };
}

function validProviderId(
  value: unknown,
  path: string,
  diagnostics: ContractDiagnostic[],
): value is string {
  if (typeof value === "string" && PROVIDER_ID.test(value)) return true;
  diagnostic(diagnostics, "network.invalidProviderId", path, "provider id must be a stable dotted identifier");
  return false;
}

function resolveProviders(
  features: Readonly<Record<string, boolean>>,
  input: ResolvedNetworkProviders,
  diagnostics: ContractDiagnostic[],
): ResolvedNetworkProviders {
  const backendByRole: Partial<Record<NetworkBackendRole, string>> = {};
  for (const role of Object.keys(BACKEND_CAPABILITIES).sort() as NetworkBackendRole[]) {
    if (features[BACKEND_CAPABILITIES[role]] !== true) continue;
    const id = input.backendByRole[role];
    if (id === undefined) {
      diagnostic(diagnostics, "network.backendMissing", `/networkProfile/providers/backendByRole/${role}`, `selected capability ${BACKEND_CAPABILITIES[role]} requires a ${role} backend`);
    } else if (validProviderId(id, `/networkProfile/providers/backendByRole/${role}`, diagnostics)) {
      backendByRole[role] = id;
    }
  }

  const tlsByRole: Partial<Record<NetworkTlsRole, { source: "provider" | "backend"; id: string }>> = {};
  for (const role of Object.keys(TLS_CAPABILITIES).sort() as NetworkTlsRole[]) {
    const tlsCapability = TLS_CAPABILITIES[role];
    if (features[tlsCapability] !== true) continue;
    if (features[BASE_CAPABILITIES_BY_TLS_ROLE[role]] !== true) {
      diagnostic(diagnostics, "network.tlsBaseMissing", `/engine/capabilities`, `${tlsCapability} requires ${BASE_CAPABILITIES_BY_TLS_ROLE[role]}`);
    }
    const selection = input.tlsByRole[role];
    if (!selection) {
      diagnostic(diagnostics, "network.tlsProviderMissing", `/networkProfile/providers/tlsByRole/${role}`, `selected capability ${tlsCapability} requires a ${role} TLS source`);
      continue;
    }
    if (selection.source !== "provider" && selection.source !== "backend") {
      diagnostic(diagnostics, "network.invalidTlsSource", `/networkProfile/providers/tlsByRole/${role}/source`, "TLS source must be provider or backend");
      continue;
    }
    if (!validProviderId(selection.id, `/networkProfile/providers/tlsByRole/${role}/id`, diagnostics)) continue;
    if (selection.source === "backend") {
      const backendId = backendByRole[role as NetworkBackendRole];
      if (!backendId || backendId !== selection.id) {
        diagnostic(diagnostics, "network.backendTlsMismatch", `/networkProfile/providers/tlsByRole/${role}`, "backend TLS source id must equal the selected backend id for that role");
        continue;
      }
    }
    tlsByRole[role] = { source: selection.source, id: selection.id };
  }

  const netDriverId = validProviderId(input.netDriverId, "/networkProfile/providers/netDriverId", diagnostics)
    ? input.netDriverId
    : "invalid";
  return { backendByRole, tlsByRole, netDriverId };
}

function resolveResources(
  requested: NetworkResourceMinimum,
  hard: NetworkResourceMinimum,
  diagnostics: ContractDiagnostic[],
): NetworkResourceMinimum {
  const resolved: Record<string, Record<string, number>> = {};
  for (const group of Object.keys(RESOURCE_KEYS) as Array<keyof typeof RESOURCE_KEYS>) {
    const requestedGroup = requested[group] as Readonly<Record<string, number>> | undefined;
    if (!requestedGroup) continue;
    const hardGroup = hard[group] as Readonly<Record<string, number>> | undefined;
    const output: Record<string, number> = {};
    for (const key of RESOURCE_KEYS[group]) {
      const value = requestedGroup[key];
      if (value === undefined) continue;
      const maximum = hardGroup?.[key];
      const path = `/resources/network/minimum/${group}/${key}`;
      if (!Number.isSafeInteger(maximum) || maximum! <= 0) {
        diagnostic(diagnostics, "network.resourceUnsupported", path, `target network profile does not provide a hard limit for ${group}.${key}`);
      } else if (value > maximum!) {
        diagnostic(diagnostics, "network.resourceExceeded", path, `requested minimum ${value} exceeds target hard limit ${maximum}`);
      }
      output[key] = value;
    }
    if (Object.keys(output).length > 0) resolved[group] = output;
  }
  return resolved as NetworkResourceMinimum;
}

function validateSelectedNetworkCapabilities(
  features: Readonly<Record<string, boolean>>,
  diagnostics: ContractDiagnostic[],
): boolean {
  let selected = false;
  for (const [capability, available] of Object.entries(features)) {
    // Browser network profiles are a staged target and never produce the
    // native provider/policy projection consumed by custom device Hosts.
    if (!available || !capability.startsWith("network.") ||
      capability.startsWith("network.browser.")) continue;
    if (!NATIVE_NETWORK_CAPABILITIES.has(capability)) {
      diagnostic(diagnostics, "network.capabilityUnsupported", "/engine/capabilities", `${capability} is not a format-3 native network capability`);
      continue;
    }
    selected = true;
    for (const dependency of CAPABILITY_DEPENDENCIES[capability] ?? []) {
      if (features[dependency] !== true) {
        diagnostic(diagnostics, "network.capabilityDependencyMissing", "/engine/capabilities", `${capability} requires selected capability ${dependency}`);
      }
    }
  }
  return selected;
}

export function resolveNetworkBuildPlan(
  manifest: PocketManifest,
  features: Readonly<Record<string, boolean>>,
  profile: HostNetworkResolutionProfile | undefined,
  diagnostics: ContractDiagnostic[],
): ResolvedNetworkBuildPlan | undefined {
  const permissions = manifest.pocket === 3 ? manifest.permissions?.network : undefined;
  const resources = manifest.pocket === 3 ? manifest.resources?.network : undefined;
  const selected = validateSelectedNetworkCapabilities(features, diagnostics);

  if (!selected) {
    if (permissions || resources) {
      diagnostic(diagnostics, "network.authorityUnused", "/permissions/network", "network permissions/resources require a selected native network capability");
    }
    return undefined;
  }
  if (manifest.pocket !== 3) {
    diagnostic(diagnostics, "network.manifestVersion", "/pocket", "native network capabilities require Pocket manifest format 3");
    return undefined;
  }
  if (!permissions) {
    diagnostic(diagnostics, "network.permissionsMissing", "/permissions/network", "selected native network capabilities require permissions.network");
  }
  if (!resources) {
    diagnostic(diagnostics, "network.resourcesMissing", "/resources/network", "selected native network capabilities require resources.network.minimum");
  }
  if (!profile) {
    diagnostic(diagnostics, "network.profileMissing", "/target", "target did not supply a network resolution profile");
  }
  if (!permissions || !resources || !profile) return undefined;

  return {
    policy: normalizePolicy(permissions, features, profile, diagnostics),
    providers: resolveProviders(features, profile.providers, diagnostics),
    resources: {
      minimum: resolveResources(resources.minimum, profile.hardLimits, diagnostics),
    },
  };
}
