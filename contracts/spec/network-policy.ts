// PocketJS network policy — the typed contract between the application
// manifest (format 3, `permissions.network`), the Build Plan
// (`ResolvedBuildPlan.network`) and every network host.
//
// Ownership:
//   manifest  `permissions.network`   app intent: which endpoints it may
//                                     connect to / listen on, which host
//                                     credential ids it may name, and the
//                                     plaintext / local-network / dev-TLS
//                                     switches
//   resolver  resolveNetworkPolicy()  normalizes the intent into one canonical
//                                     ResolvedNetworkPolicy and writes it into
//                                     the plan (so it is covered by planHash)
//   host      canonicalNetworkPolicyJson(plan.network)
//                                     is the immutable policy JSON a host hands
//                                     to its network core at runtime creation
//                                     (engine/net `pnet_runtime_create`, the
//                                     Rust `NetPolicy::parse`, the sim hosts)
//
// A host never authors or widens this policy; it enforces it on every
// command (connect rule before DNS, every candidate address after DNS,
// listen rule before bind, again on redirects). The matcher below is the
// reference semantics; the C and Rust cores implement the same rules and
// the shared vectors (contracts/spec/vectors/network-policy.json) pin them.

import type { JsonSchema } from "./pocket-manifest.ts";

export const NETWORK_POLICY_VERSION = 1 as const;

/** The protocols the v1 modules speak; listen rules take the same tokens. */
export const NETWORK_POLICY_PROTOCOLS = ["http", "https", "ws", "wss"] as const;
export type NetworkPolicyProtocol = (typeof NETWORK_POLICY_PROTOCOLS)[number];

/** Plaintext protocols: refused unless the policy sets `insecureTransport`. */
export const NETWORK_PLAINTEXT_PROTOCOLS: readonly NetworkPolicyProtocol[] = ["http", "ws"];

export const NETWORK_DEFAULT_PORTS: Readonly<Record<NetworkPolicyProtocol, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

// ---------------------------------------------------------------------------
// Manifest intent (`permissions.network`)
// ---------------------------------------------------------------------------

/** A single port or an inclusive range. */
export type NetworkPortRule = number | { readonly min: number; readonly max: number };

export interface NetworkConnectRule {
  readonly protocol: NetworkPolicyProtocol;
  /** DNS name (lowercase ASCII / IDNA A-label), `*.suffix` (exactly one
   * label), or an IP literal. Never a bare `*`. */
  readonly host: string;
  readonly port: NetworkPortRule;
}

export interface NetworkListenRule {
  readonly protocol: NetworkPolicyProtocol;
  /** A bind address: IP literal only. */
  readonly address: string;
  /** A port, a range, or `"ephemeral"` (bind port 0; the host checks the
   * OS-assigned port against its own ephemeral range). */
  readonly port: NetworkPortRule | "ephemeral";
}

export interface NetworkPermissions {
  readonly connect?: readonly NetworkConnectRule[];
  readonly listen?: readonly NetworkListenRule[];
  /** Host credential ids the app may reference (`TlsOptions.credential`);
   * never key material. */
  readonly credentials?: readonly string[];
  /** Allow matched endpoints to resolve to loopback / link-local / private /
   * CGNAT / ULA addresses. Default false: a public hostname that resolves to
   * such an address is refused (`permission_denied`). */
  readonly localNetwork?: boolean;
  /** Allow plaintext `http:` / `ws:` rules to be used. Default false. */
  readonly insecureTransport?: boolean;
  /** Let a development build skip certificate verification when the caller
   * also asks for it per request. Refused outside development builds. */
  readonly allowInvalidTlsForDevelopment?: boolean;
}

const portRuleSchema = {
  anyOf: [
    { type: "integer", minimum: 1, maximum: 65535 },
    {
      type: "object",
      additionalProperties: false,
      required: ["min", "max"],
      properties: {
        min: { type: "integer", minimum: 1, maximum: 65535 },
        max: { type: "integer", minimum: 1, maximum: 65535 },
      },
    },
  ],
} as const satisfies JsonSchema;

/** Schema fragment for `permissions.network` (format 3 manifests). Shape
 * only; hostname / address / range / duplicate semantics are the resolver's
 * (`resolveNetworkPolicy`). */
export const networkPermissionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connect: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "host", "port"],
        properties: {
          protocol: { enum: NETWORK_POLICY_PROTOCOLS },
          host: { type: "string", minLength: 1, maxLength: 255 },
          port: portRuleSchema,
        },
      },
    },
    listen: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "address", "port"],
        properties: {
          protocol: { enum: NETWORK_POLICY_PROTOCOLS },
          address: { type: "string", minLength: 1, maxLength: 64 },
          port: { anyOf: [...portRuleSchema.anyOf, { const: "ephemeral" }] },
        },
      },
    },
    credentials: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" },
      uniqueItems: true,
    },
    localNetwork: { type: "boolean" },
    insecureTransport: { type: "boolean" },
    allowInvalidTlsForDevelopment: { type: "boolean" },
  },
} as const satisfies JsonSchema;

// ---------------------------------------------------------------------------
// Resolved policy (the plan's `network` field)
// ---------------------------------------------------------------------------

export interface ResolvedNetworkPolicy {
  readonly version: typeof NETWORK_POLICY_VERSION;
  /** Sorted, deduplicated, hosts lowercase, single-port ranges collapsed. */
  readonly connect: readonly NetworkConnectRule[];
  /** Sorted, deduplicated, addresses canonical (RFC 5952 for IPv6). */
  readonly listen: readonly NetworkListenRule[];
  /** Sorted unique host credential ids. */
  readonly credentials: readonly string[];
  readonly localNetwork: boolean;
  readonly insecureTransport: boolean;
  readonly allowInvalidTlsForDevelopment: boolean;
}

/** The policy of a manifest without `permissions.network` (format 2 or
 * omitted): no endpoint is reachable, nothing can listen. */
export const DENY_ALL_NETWORK_POLICY: ResolvedNetworkPolicy = Object.freeze({
  version: NETWORK_POLICY_VERSION,
  connect: Object.freeze([]) as readonly NetworkConnectRule[],
  listen: Object.freeze([]) as readonly NetworkListenRule[],
  credentials: Object.freeze([]) as readonly string[],
  localNetwork: false,
  insecureTransport: false,
  allowInvalidTlsForDevelopment: false,
});

export interface NetworkPolicyDiagnostic {
  readonly code: string;
  /** RFC 6901 JSON Pointer below the caller's prefix. */
  readonly path: string;
  readonly message: string;
}

export interface ResolveNetworkPolicyOptions {
  /** JSON Pointer prefix of the permissions object (default
   * `/permissions/network`). */
  readonly path?: string;
  /** A development build admits `allowInvalidTlsForDevelopment: true`;
   * production admission refuses it. Default false. */
  readonly development?: boolean;
}

export type ResolveNetworkPolicyResult =
  | { readonly ok: true; readonly policy: ResolvedNetworkPolicy }
  | { readonly ok: false; readonly diagnostics: readonly NetworkPolicyDiagnostic[] };

// --- addresses --------------------------------------------------------------

export interface NetworkAddressLiteral {
  readonly family: 4 | 6;
  /** 4 or 16 bytes. */
  readonly bytes: Uint8Array;
}

function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

function parseIPv6(text: string): Uint8Array | null {
  // RFC 4291 text form: up to 8 hex groups, one `::` gap, optional dotted
  // IPv4 tail (the same grammar engine/net's pnet_parse_ipv6 accepts).
  if (text.length === 0) return null;
  const groups: number[] = [];
  let gap = -1;
  let i = 0;
  if (text.startsWith("::")) {
    gap = 0;
    i = 2;
  } else if (text.startsWith(":")) {
    return null;
  }
  while (i < text.length) {
    if (groups.length >= 8) return null;
    let j = i;
    let dotted = false;
    while (j < text.length && text[j] !== ":") {
      if (text[j] === ".") dotted = true;
      j++;
    }
    if (dotted) {
      if (j !== text.length || groups.length > 6) return null;
      const v4 = parseIPv4(text.slice(i));
      if (!v4) return null;
      groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      i = j;
      break;
    }
    if (j === i || j - i > 4 || !/^[0-9a-fA-F]+$/.test(text.slice(i, j))) return null;
    groups.push(parseInt(text.slice(i, j), 16));
    i = j;
    if (i < text.length) {
      i++; // ':'
      if (i < text.length && text[i] === ":") {
        if (gap >= 0) return null;
        gap = groups.length;
        i++;
        if (i === text.length) break;
      } else if (i === text.length) {
        return null;
      }
    }
  }
  if (gap < 0 && groups.length !== 8) return null;
  if (gap >= 0 && groups.length >= 8) return null;
  const out = new Uint8Array(16);
  const fill = 8 - groups.length;
  let gi = 0;
  for (let g = 0; g < 8; g++) {
    if (gap >= 0 && g >= gap && g < gap + fill) continue;
    out[g * 2] = groups[gi] >> 8;
    out[g * 2 + 1] = groups[gi] & 0xff;
    gi++;
  }
  return out;
}

/** Parse an IP literal (`1.2.3.4`, `::1`, `[::1]`); null when it is not one. */
export function parseNetworkAddress(text: string): NetworkAddressLiteral | null {
  let body = text;
  if (body.length >= 2 && body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  if (body.includes(":")) {
    const bytes = parseIPv6(body);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIPv4(body);
  return bytes ? { family: 4, bytes } : null;
}

/** Canonical text: dotted quad, or RFC 5952 IPv6 (lowercase hex, longest
 * zero run of two or more groups compressed, no dotted tail). */
export function formatNetworkAddress(addr: NetworkAddressLiteral): string {
  if (addr.family === 4) return Array.from(addr.bytes).join(".");
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((addr.bytes[i * 2] << 8) | addr.bytes[i * 2 + 1]);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === best) {
      out += "::"; // the group before the run wrote no separator
      i += bestLen - 1;
      continue;
    }
    out += groups[i].toString(16);
    if (i < 7 && i + 1 !== best) out += ":";
  }
  return out;
}

export function networkAddressIsMulticast(addr: NetworkAddressLiteral): boolean {
  if (addr.family === 4) return (addr.bytes[0] & 0xf0) === 0xe0;
  return addr.bytes[0] === 0xff;
}

/** Public (globally routable unicast) classification shared with the C core
 * (`pnet_addr_is_public`): false for unspecified, loopback, RFC 1918,
 * link-local, CGNAT, multicast, broadcast, `::`/`::1`, fe80::/10, fc00::/7
 * and IPv4-mapped addresses whose IPv4 part is not public. */
export function networkAddressIsPublic(addr: NetworkAddressLiteral): boolean {
  const a = addr.bytes;
  if (addr.family === 4) {
    if (a[0] === 0) return false;
    if (a[0] === 10) return false;
    if (a[0] === 127) return false;
    if (a[0] === 169 && a[1] === 254) return false;
    if (a[0] === 172 && (a[1] & 0xf0) === 16) return false;
    if (a[0] === 192 && a[1] === 168) return false;
    if (a[0] === 100 && (a[1] & 0xc0) === 64) return false;
    if ((a[0] & 0xf0) === 0xe0) return false;
    if (a[0] === 255 && a[1] === 255 && a[2] === 255 && a[3] === 255) return false;
    return true;
  }
  let leadingZero = true;
  for (let i = 0; i < 15; i++) if (a[i] !== 0) leadingZero = false;
  if (leadingZero && (a[15] === 0 || a[15] === 1)) return false;
  if (a[0] === 0xfe && (a[1] & 0xc0) === 0x80) return false;
  if ((a[0] & 0xfe) === 0xfc) return false;
  if (a[0] === 0xff) return false;
  let mapped = true;
  for (let i = 0; i < 10; i++) if (a[i] !== 0) mapped = false;
  if (mapped && a[10] === 0xff && a[11] === 0xff) {
    return networkAddressIsPublic({ family: 4, bytes: a.subarray(12, 16) });
  }
  return true;
}

// --- hostnames --------------------------------------------------------------

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercase an ASCII hostname and drop one trailing root dot; null when it
 * is not a valid ASCII (A-label) hostname. */
export function normalizeNetworkHostname(host: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(host)) return null;
  let lower = host.toLowerCase();
  if (lower.length > 1 && lower.endsWith(".")) lower = lower.slice(0, -1);
  if (lower.length === 0 || lower.length > 253) return null;
  const labels = lower.split(".");
  if (!labels.every((label) => HOST_LABEL.test(label))) return null;
  // A name whose last label is all digits is a malformed IPv4 literal, never
  // a DNS name (WHATWG URL "ends in a number"); leading-zero octets such as
  // 192.168.001.020 are refused by the literal parser on purpose.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return lower;
}

/** `*.example.com` matches exactly one non-empty label (`a.example.com`),
 * never the suffix itself nor `a.b.example.com`; plain names compare
 * case-insensitively; IP literals compare by canonical address. */
export function networkHostMatches(rule: string, host: string): boolean {
  const ruleAddr = parseNetworkAddress(rule);
  if (ruleAddr) {
    const hostAddr = parseNetworkAddress(host);
    return hostAddr !== null && formatNetworkAddress(hostAddr) === formatNetworkAddress(ruleAddr);
  }
  const target = normalizeNetworkHostname(host);
  if (target === null) return false;
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1); // ".example.com"
    if (target.length <= suffix.length || !target.endsWith(suffix)) return false;
    const label = target.slice(0, target.length - suffix.length);
    return label.length > 0 && !label.includes(".");
  }
  return rule === target;
}

// --- ports ------------------------------------------------------------------

function portBounds(rule: NetworkPortRule): readonly [number, number] {
  return typeof rule === "number" ? [rule, rule] : [rule.min, rule.max];
}

export function networkPortMatches(rule: NetworkPortRule | "ephemeral", port: number): boolean {
  if (rule === "ephemeral") return port === 0;
  const [min, max] = portBounds(rule);
  return port >= min && port <= max;
}

// --- resolution -------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePortRule(
  value: unknown,
  allowEphemeral: boolean,
  path: string,
  diagnostics: NetworkPolicyDiagnostic[],
): NetworkPortRule | "ephemeral" | null {
  if (value === "ephemeral") {
    if (allowEphemeral) return "ephemeral";
    diagnostics.push({ code: "network.ephemeralConnect", path, message: "connect rules take a port or a range, not \"ephemeral\"" });
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      diagnostics.push({ code: "network.invalidPort", path, message: "port must be an integer from 1 through 65535" });
      return null;
    }
    return value;
  }
  if (isRecord(value) && Number.isInteger(value.min) && Number.isInteger(value.max)) {
    const min = value.min as number;
    const max = value.max as number;
    if (min < 1 || max > 65535) {
      diagnostics.push({ code: "network.invalidPort", path, message: "port range must stay within 1 through 65535" });
      return null;
    }
    if (min > max) {
      diagnostics.push({ code: "network.reversedPortRange", path, message: `port range ${min}-${max} is reversed` });
      return null;
    }
    return min === max ? min : { min, max };
  }
  diagnostics.push({ code: "network.invalidPort", path, message: "port must be an integer or {min, max}" });
  return null;
}

function portKey(rule: NetworkPortRule | "ephemeral"): string {
  if (rule === "ephemeral") return "ephemeral";
  const [min, max] = portBounds(rule);
  return `${String(min).padStart(5, "0")}-${String(max).padStart(5, "0")}`;
}

function ruleKey(protocol: string, host: string, port: NetworkPortRule | "ephemeral"): string {
  return `${protocol} ${host} ${portKey(port)}`;
}

/**
 * Normalize `permissions.network` into the canonical ResolvedNetworkPolicy:
 * hostnames lowercase without a trailing dot, IP literals in canonical text,
 * single-port ranges collapsed, rules and credentials sorted, exact
 * duplicates refused, `allowInvalidTlsForDevelopment` refused outside
 * development builds. `undefined` resolves to DENY_ALL_NETWORK_POLICY.
 */
export function resolveNetworkPolicy(
  permissions: NetworkPermissions | undefined,
  options: ResolveNetworkPolicyOptions = {},
): ResolveNetworkPolicyResult {
  if (permissions === undefined) return { ok: true, policy: DENY_ALL_NETWORK_POLICY };
  const prefix = options.path ?? "/permissions/network";
  const diagnostics: NetworkPolicyDiagnostic[] = [];

  const connect: NetworkConnectRule[] = [];
  const connectKeys = new Map<string, string>();
  (permissions.connect ?? []).forEach((rule, index) => {
    const path = `${prefix}/connect/${index}`;
    if (!NETWORK_POLICY_PROTOCOLS.includes(rule.protocol)) {
      diagnostics.push({ code: "network.unknownProtocol", path: `${path}/protocol`, message: `unknown protocol ${JSON.stringify(rule.protocol)}` });
      return;
    }
    let host: string | null = null;
    const literal = typeof rule.host === "string" ? parseNetworkAddress(rule.host) : null;
    if (literal) {
      host = formatNetworkAddress(literal);
    } else if (typeof rule.host === "string" && rule.host.startsWith("*.")) {
      const suffix = normalizeNetworkHostname(rule.host.slice(2));
      if (suffix !== null && !parseNetworkAddress(suffix)) host = `*.${suffix}`;
    } else if (typeof rule.host === "string") {
      host = normalizeNetworkHostname(rule.host);
    }
    if (host === null) {
      diagnostics.push({
        code: "network.invalidHost",
        path: `${path}/host`,
        message: "host must be a lowercase ASCII hostname, a single-label wildcard (*.example.com) or an IP literal",
      });
      return;
    }
    const port = normalizePortRule(rule.port, false, `${path}/port`, diagnostics);
    if (port === null) return;
    const key = ruleKey(rule.protocol, host, port);
    const previous = connectKeys.get(key);
    if (previous) {
      diagnostics.push({ code: "network.duplicateRule", path, message: `rule was already declared at ${previous}` });
      return;
    }
    connectKeys.set(key, path);
    connect.push({ protocol: rule.protocol, host, port: port as NetworkPortRule });
  });

  const listen: NetworkListenRule[] = [];
  const listenKeys = new Map<string, string>();
  (permissions.listen ?? []).forEach((rule, index) => {
    const path = `${prefix}/listen/${index}`;
    if (!NETWORK_POLICY_PROTOCOLS.includes(rule.protocol)) {
      diagnostics.push({ code: "network.unknownProtocol", path: `${path}/protocol`, message: `unknown protocol ${JSON.stringify(rule.protocol)}` });
      return;
    }
    const literal = typeof rule.address === "string" ? parseNetworkAddress(rule.address) : null;
    if (!literal) {
      diagnostics.push({ code: "network.invalidAddress", path: `${path}/address`, message: "listen address must be an IP literal" });
      return;
    }
    const address = formatNetworkAddress(literal);
    const port = normalizePortRule(rule.port, true, `${path}/port`, diagnostics);
    if (port === null) return;
    const key = ruleKey(rule.protocol, address, port);
    const previous = listenKeys.get(key);
    if (previous) {
      diagnostics.push({ code: "network.duplicateRule", path, message: `rule was already declared at ${previous}` });
      return;
    }
    listenKeys.set(key, path);
    listen.push({ protocol: rule.protocol, address, port });
  });

  const credentials = [...new Set(permissions.credentials ?? [])].sort();
  if (credentials.length !== (permissions.credentials ?? []).length) {
    diagnostics.push({ code: "network.duplicateCredential", path: `${prefix}/credentials`, message: "credential ids must be unique" });
  }

  const allowInvalidTls = permissions.allowInvalidTlsForDevelopment === true;
  if (allowInvalidTls && !options.development) {
    diagnostics.push({
      code: "network.developmentOnly",
      path: `${prefix}/allowInvalidTlsForDevelopment`,
      message: "allowInvalidTlsForDevelopment is admitted only by development builds",
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const byKey = <T extends { protocol: string; port: NetworkPortRule | "ephemeral" }>(hostOf: (rule: T) => string) =>
    (left: T, right: T) => {
      const l = ruleKey(left.protocol, hostOf(left), left.port);
      const r = ruleKey(right.protocol, hostOf(right), right.port);
      return l < r ? -1 : l > r ? 1 : 0;
    };
  connect.sort(byKey<NetworkConnectRule>((rule) => rule.host));
  listen.sort(byKey<NetworkListenRule>((rule) => rule.address));

  return {
    ok: true,
    policy: {
      version: NETWORK_POLICY_VERSION,
      connect,
      listen,
      credentials,
      localNetwork: permissions.localNetwork === true,
      insecureTransport: permissions.insecureTransport === true,
      allowInvalidTlsForDevelopment: allowInvalidTls,
    },
  };
}

// --- enforcement (reference semantics) ---------------------------------------

export function networkPolicyAllowsConnect(
  policy: ResolvedNetworkPolicy,
  protocol: string,
  host: string,
  port: number,
): boolean {
  if (NETWORK_PLAINTEXT_PROTOCOLS.includes(protocol as NetworkPolicyProtocol) && !policy.insecureTransport) return false;
  return policy.connect.some(
    (rule) => rule.protocol === protocol && networkPortMatches(rule.port, port) && networkHostMatches(rule.host, host),
  );
}

/** A resolved candidate address is usable when it is public, or when the
 * policy grants `localNetwork`; multicast never is. */
export function networkPolicyAllowsAddress(policy: ResolvedNetworkPolicy, addr: NetworkAddressLiteral): boolean {
  if (networkAddressIsMulticast(addr)) return false;
  if (networkAddressIsPublic(addr)) return true;
  return policy.localNetwork;
}

export function networkPolicyAllowsListen(
  policy: ResolvedNetworkPolicy,
  protocol: string,
  address: string,
  port: number,
): boolean {
  if (NETWORK_PLAINTEXT_PROTOCOLS.includes(protocol as NetworkPolicyProtocol) && !policy.insecureTransport) return false;
  const addr = parseNetworkAddress(address);
  if (!addr) return false;
  const canonical = formatNetworkAddress(addr);
  return policy.listen.some(
    (rule) => rule.protocol === protocol && rule.address === canonical && networkPortMatches(rule.port, port),
  );
}

export function networkPolicyHasCredential(policy: ResolvedNetworkPolicy, id: string): boolean {
  return policy.credentials.includes(id);
}

// --- canonical JSON (what a host hands to its core) --------------------------

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("network policy contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`network policy contains non-JSON value ${typeof value}`);
}

/** RFC 8785-shaped canonical JSON of a resolved policy: sorted keys, no
 * whitespace. Byte-identical for equal policies; this string is the native
 * policy input of every host. */
export function canonicalNetworkPolicyJson(policy: ResolvedNetworkPolicy): string {
  return canonical({
    version: policy.version,
    connect: policy.connect,
    listen: policy.listen,
    credentials: policy.credentials,
    localNetwork: policy.localNetwork,
    insecureTransport: policy.insecureTransport,
    allowInvalidTlsForDevelopment: policy.allowInvalidTlsForDevelopment,
  });
}

/** Parse canonical (or any) policy JSON back into a ResolvedNetworkPolicy:
 * hosts that receive the JSON (sim, browser dev host) use this and then the
 * matcher above. Throws on a malformed or unsupported document. */
export function parseNetworkPolicyJson(json: string, options: ResolveNetworkPolicyOptions = {}): ResolvedNetworkPolicy {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new TypeError("network policy must be a JSON object");
  if (parsed.version !== undefined && parsed.version !== NETWORK_POLICY_VERSION) {
    throw new TypeError(`unsupported network policy version ${String(parsed.version)}`);
  }
  const { version: _version, ...permissions } = parsed;
  for (const key of ["connect", "listen", "credentials"] as const) {
    if (permissions[key] !== undefined && !Array.isArray(permissions[key])) {
      throw new TypeError(`network policy ${key} must be an array`);
    }
  }
  for (const key of ["localNetwork", "insecureTransport", "allowInvalidTlsForDevelopment"] as const) {
    if (permissions[key] !== undefined && typeof permissions[key] !== "boolean") {
      throw new TypeError(`network policy ${key} must be a boolean`);
    }
  }
  for (const key of Object.keys(permissions)) {
    if (!["connect", "listen", "credentials", "localNetwork", "insecureTransport", "allowInvalidTlsForDevelopment"].includes(key)) {
      throw new TypeError(`network policy has an unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const rule of [...(permissions.connect as unknown[] ?? []), ...(permissions.listen as unknown[] ?? [])]) {
    if (!isRecord(rule)) throw new TypeError("network policy rules must be objects");
  }
  for (const id of (permissions.credentials as unknown[] ?? [])) {
    if (typeof id !== "string" || id.length === 0) throw new TypeError("network policy credential ids must be non-empty strings");
  }
  const result = resolveNetworkPolicy(permissions as NetworkPermissions, { path: "", development: true, ...options });
  if (!result.ok) {
    throw new TypeError(`invalid network policy: ${result.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; ")}`);
  }
  return result.policy;
}
