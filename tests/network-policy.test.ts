// The TypeScript reference of the network policy contract against the shared
// vectors. engine/net (pnet_unit_test) and engine/crates/pocket-net run the
// same file; a decision that differs between the three is a conformance
// failure, not a host quirk.
import { describe, expect, test } from "bun:test";
import {
  DENY_ALL_NETWORK_POLICY,
  canonicalNetworkPolicyJson,
  formatNetworkAddress,
  networkAddressIsMulticast,
  networkAddressIsPublic,
  networkPolicyAllowsAddress,
  networkPolicyAllowsConnect,
  networkPolicyAllowsListen,
  parseNetworkAddress,
  parseNetworkPolicyJson,
  resolveNetworkPolicy,
  type ResolvedNetworkPolicy,
} from "../contracts/spec/network-policy.ts";

interface Vectors {
  readonly policies: Readonly<Record<string, unknown>>;
  readonly invalid: readonly { name: string; policy: unknown }[];
  readonly connect: readonly { policy: string; protocol: string; host: string; port: number; allowed: boolean }[];
  readonly address: readonly { address: string; public: boolean; multicast: boolean }[];
  readonly listen: readonly { policy: string; protocol: string; address: string; port: number; allowed: boolean }[];
}

const vectors = (await Bun.file(new URL("../contracts/spec/vectors/network-policy.json", import.meta.url)).json()) as Vectors;

const policies = new Map<string, ResolvedNetworkPolicy>();
for (const [name, document] of Object.entries(vectors.policies)) {
  policies.set(name, parseNetworkPolicyJson(JSON.stringify(document)));
}

describe("network policy vectors", () => {
  test("every vector policy is canonical: parse → canonical JSON reproduces the document", () => {
    for (const [name, document] of Object.entries(vectors.policies)) {
      const policy = policies.get(name)!;
      expect(JSON.parse(canonicalNetworkPolicyJson(policy))).toEqual(document);
      // Canonical JSON is a fixed point.
      expect(canonicalNetworkPolicyJson(parseNetworkPolicyJson(canonicalNetworkPolicyJson(policy)))).toBe(canonicalNetworkPolicyJson(policy));
    }
    expect(policies.get("deny-all")).toEqual(DENY_ALL_NETWORK_POLICY);
  });

  test("invalid documents are refused", () => {
    for (const { name, policy } of vectors.invalid) {
      expect(() => parseNetworkPolicyJson(JSON.stringify(policy)), name).toThrow();
    }
  });

  test("connect decisions", () => {
    for (const v of vectors.connect) {
      const policy = policies.get(v.policy)!;
      expect(networkPolicyAllowsConnect(policy, v.protocol, v.host, v.port), JSON.stringify(v)).toBe(v.allowed);
    }
  });

  test("address classification and the localNetwork gate", () => {
    const open = policies.get("standard")!; // localNetwork: true
    const closed = policies.get("secure-only")!; // localNetwork: false
    for (const v of vectors.address) {
      const addr = parseNetworkAddress(v.address);
      expect(addr, v.address).not.toBeNull();
      expect(networkAddressIsPublic(addr!), v.address).toBe(v.public);
      expect(networkAddressIsMulticast(addr!), v.address).toBe(v.multicast);
      expect(networkPolicyAllowsAddress(closed, addr!), v.address).toBe(v.public);
      expect(networkPolicyAllowsAddress(open, addr!), v.address).toBe(!v.multicast);
      // Canonical text round-trips.
      expect(formatNetworkAddress(parseNetworkAddress(formatNetworkAddress(addr!))!)).toBe(formatNetworkAddress(addr!));
    }
  });

  test("listen decisions", () => {
    for (const v of vectors.listen) {
      const policy = policies.get(v.policy)!;
      expect(networkPolicyAllowsListen(policy, v.protocol, v.address, v.port), JSON.stringify(v)).toBe(v.allowed);
    }
  });
});

describe("network policy resolution", () => {
  test("normalizes, sorts and collapses manifest intent", () => {
    const result = resolveNetworkPolicy({
      connect: [
        { protocol: "https", host: "B.Example.com.", port: { min: 443, max: 443 } },
        { protocol: "https", host: "a.example.com", port: 443 },
        { protocol: "http", host: "[::1]", port: { min: 1, max: 65535 } },
      ],
      listen: [{ protocol: "http", address: "0000:0000:0000:0000:0000:0000:0000:0001", port: "ephemeral" }],
      credentials: ["b", "a"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toEqual({
      version: 1,
      connect: [
        { protocol: "http", host: "::1", port: { min: 1, max: 65535 } },
        { protocol: "https", host: "a.example.com", port: 443 },
        { protocol: "https", host: "b.example.com", port: 443 },
      ],
      listen: [{ protocol: "http", address: "::1", port: "ephemeral" }],
      credentials: ["a", "b"],
      localNetwork: false,
      insecureTransport: false,
      allowInvalidTlsForDevelopment: false,
    });
  });

  test("reports every fault with its pointer under the caller's prefix", () => {
    const result = resolveNetworkPolicy(
      {
        connect: [{ protocol: "https", host: "*", port: 443 }, { protocol: "https", host: "ok.example", port: 443 }, { protocol: "https", host: "OK.example", port: 443 }],
        listen: [{ protocol: "http", address: "0.0.0.0", port: { min: 2, max: 1 } }],
        allowInvalidTlsForDevelopment: true,
      },
      { path: "/x" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["network.invalidHost", "/x/connect/0/host"],
      ["network.duplicateRule", "/x/connect/2"],
      ["network.reversedPortRange", "/x/listen/0/port"],
      ["network.developmentOnly", "/x/allowInvalidTlsForDevelopment"],
    ]);
  });
});
