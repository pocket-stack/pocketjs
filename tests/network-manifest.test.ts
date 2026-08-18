import { describe, expect, test } from "bun:test";
import {
  generatePocketManifestV3Schema,
  POCKET_MANIFEST_V3_SCHEMA_ID,
} from "../contracts/spec/pocket-manifest.ts";
import {
  defineCapabilityRegistry,
  definePlatformContractRegistry,
  defineTargetRegistry,
  POCKET_TARGETS,
  type CapabilityId,
  type TargetProfile,
} from "../contracts/spec/platforms.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/src/manifest/host-build-inputs.ts";
import type { HostNetworkResolutionProfile } from "../framework/src/manifest/network.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";

const NETWORK_CAPABILITIES = defineCapabilityRegistry([
  "text.glyphs.baked",
  "network.http.client",
  "network.http.client.tls",
  "network.browser.http.client",
  "network.discovery.mdns",
  "network.udp",
  "network.udp.broadcast",
] as const);

type NetworkCapability = CapabilityId<typeof NETWORK_CAPABILITIES>;

const NETWORK_TARGET_DEFINITIONS = {
  "esp-test": {
    ...POCKET_TARGETS.psp,
    platform: "esp-idf",
    capabilities: [
      "text.glyphs.baked",
      "network.http.client",
      "network.http.client.tls",
      "network.discovery.mdns",
    ],
  },
  "plain-or-browser-test": {
    ...POCKET_TARGETS.psp,
    platform: "test",
    capabilities: [
      "text.glyphs.baked",
      "network.http.client",
      "network.browser.http.client",
    ],
  },
} as const satisfies Readonly<Record<string, TargetProfile<NetworkCapability>>>;

const NETWORK_TARGETS = defineTargetRegistry<
  NetworkCapability,
  typeof NETWORK_TARGET_DEFINITIONS
>(NETWORK_TARGET_DEFINITIONS);

const NETWORK_CONTRACTS = definePlatformContractRegistry(
  NETWORK_CAPABILITIES,
  NETWORK_TARGETS,
);

const networkProfile: HostNetworkResolutionProfile = {
  providers: {
    backendByRole: {
      "http.client": "pocketjs.net.esp-http.v1",
    },
    tlsByRole: {
      "http.client": {
        source: "backend",
        id: "pocketjs.net.esp-http.v1",
      },
    },
    netDriverId: "esp-idf.lwip.v1",
  },
  hardLimits: {
    runtime: {
      connections: 4,
      pendingOperations: 8,
      completionDescriptors: 32,
      nativeBufferBytes: 524288,
    },
    http: {
      connections: 2,
      inflightRequests: 2,
      headerBytes: 8192,
      headerCount: 32,
      bufferedBodyBytes: 262144,
    },
  },
  developmentBuild: false,
};

function httpManifest(): Record<string, any> {
  return {
    $schema: POCKET_MANIFEST_V3_SCHEMA_ID,
    pocket: 3,
    id: "dev.pocket-stack.network-test",
    name: "network-test",
    title: "Network Test",
    version: "1.0.0",
    engine: {
      capabilities: {
        requires: [
          "text.glyphs.baked",
          "network.http.client",
          "network.http.client.tls",
        ],
      },
    },
    permissions: {
      network: {
        connect: [
          { protocol: "https", host: "BÜCHER.Example.", port: 443 },
        ],
        listen: [],
        localNetwork: false,
        insecureTransport: false,
        broadcast: false,
        multicast: false,
        allowInvalidTlsForDevelopment: false,
        browserAmbientCredentials: false,
        browserOpaqueWebSocketRedirects: false,
        credentials: [],
      },
    },
    resources: {
      network: {
        minimum: {
          runtime: { connections: 2, nativeBufferBytes: 131072 },
          http: { headerBytes: 4096, bufferedBodyBytes: 65536 },
        },
      },
    },
    app: {
      entry: "app/main.tsx",
      output: "network-test",
      framework: "solid",
      viewport: { logical: [480, 272], presentation: "integer-fit" },
    },
  };
}

function resolveHttp(
  input: unknown,
  profile: HostNetworkResolutionProfile | undefined = networkProfile,
) {
  return validateAndResolveBuildPlan(
    input,
    { target: "esp-test", ...(profile ? { network: profile } : {}) },
    NETWORK_CONTRACTS,
  );
}

describe("pocket.json v3 network schema", () => {
  test("publishes a byte-exact strict format-3 schema", async () => {
    expect(POCKET_MANIFEST_V3_SCHEMA_ID).toBe("https://pocketjs.dev/schema/pocket-3.json");
    const committed = await Bun.file(
      new URL("../contracts/schema/pocket-3.json", import.meta.url),
    ).text();
    expect(committed).toBe(generatePocketManifestV3Schema());
    expect(validatePocketManifest(httpManifest()).ok).toBe(true);
    const siteBuild = await Bun.file(new URL("../site/build.ts", import.meta.url)).text();
    expect(siteBuild).toContain(
      'copy(ROOT + "contracts/schema/pocket-3.json", "schema/pocket-3.json")',
    );
  });

  test("rejects unknown policy fields, port zero, and malformed alternatives", () => {
    const unknown = httpManifest();
    unknown.permissions.network.proxy = "ambient";
    const unknownResult = validatePocketManifest(unknown);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(unknownResult.diagnostics).toContainEqual({
        code: "schema.additionalProperty",
        path: "/permissions/network/proxy",
        message: "unknown property",
      });
    }

    const zero = httpManifest();
    zero.permissions.network.listen = [
      { protocol: "http", address: "127.0.0.1", port: 0 },
    ];
    expect(validatePocketManifest(zero).ok).toBe(false);

    const emptyOption = httpManifest();
    emptyOption.engine.capabilities.requiresOneOf = [{ options: [[]] }];
    expect(validatePocketManifest(emptyOption).ok).toBe(false);

    const mismatchedVersion = httpManifest();
    mismatchedVersion.pocket = 2;
    const mismatchResult = validatePocketManifest(mismatchedVersion);
    expect(mismatchResult.ok).toBe(false);
    if (!mismatchResult.ok) {
      expect(mismatchResult.diagnostics).toContainEqual({
        code: "schema.const",
        path: "/pocket",
        message: "expected 3",
      });
    }
  });
});

describe("format-3 network resolution", () => {
  test("selects the first complete requiresOneOf provider option", () => {
    const input = httpManifest();
    input.engine.capabilities.requires = ["text.glyphs.baked"];
    input.engine.capabilities.requiresOneOf = [{
      options: [
        ["network.http.client", "network.http.client.tls"],
        ["network.browser.http.client"],
      ],
    }];
    const esp = resolveHttp(input);
    expect(esp.ok).toBe(true);
    if (!esp.ok) return;
    expect(esp.plan.selectedCapabilityOptions).toEqual([[
      "network.http.client",
      "network.http.client.tls",
    ]]);
    expect(esp.plan.features).toMatchObject({
      "network.browser.http.client": false,
      "network.http.client": true,
      "network.http.client.tls": true,
    });

    const browserChoice = structuredClone(input);
    delete browserChoice.permissions;
    delete browserChoice.resources;
    const browser = validateAndResolveBuildPlan(
      browserChoice,
      { target: "plain-or-browser-test" },
      NETWORK_CONTRACTS,
    );
    expect(browser.ok).toBe(true);
    if (!browser.ok) return;
    expect(browser.plan.selectedCapabilityOptions).toEqual([["network.browser.http.client"]]);
    expect(browser.plan.network).toBeUndefined();
  });

  test("treats empty endpoint lists as deny-all and an empty minimum as Host defaults", () => {
    const input = httpManifest();
    input.permissions.network.connect = [];
    input.permissions.network.listen = [];
    input.resources.network.minimum = {};
    const result = resolveHttp(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.network?.policy.connect).toEqual([]);
    expect(result.plan.network?.policy.listen).toEqual([]);
    expect(result.plan.network?.resources.minimum).toEqual({});
  });

  test("normalizes endpoint tuples and makes their order hash-independent", () => {
    const leftInput = httpManifest();
    leftInput.permissions.network.connect.push({
      protocol: "https",
      host: "api.example.com",
      port: { min: 443, max: 443 },
    });
    const rightInput = structuredClone(leftInput);
    rightInput.permissions.network.connect.reverse();
    rightInput.permissions.network.connect[1].host = "bücher.example";

    const left = resolveHttp(leftInput);
    const right = resolveHttp(rightInput);
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.plan.network?.policy.connect).toEqual([
      {
        protocol: "https",
        host: "api.example.com",
        port: { min: 443, max: 443 },
      },
      {
        protocol: "https",
        host: "xn--bcher-kva.example",
        port: { min: 443, max: 443 },
      },
    ]);
    expect(left.plan.planHash).toBe(right.plan.planHash);
  });

  test("puts provider selection, policy, and resources under planHash", () => {
    const first = resolveHttp(httpManifest());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.plan.network).toMatchObject({
      policy: { version: 1 },
      providers: {
        backendByRole: { "http.client": "pocketjs.net.esp-http.v1" },
        tlsByRole: {
          "http.client": {
            source: "backend",
            id: "pocketjs.net.esp-http.v1",
          },
        },
        netDriverId: "esp-idf.lwip.v1",
      },
      resources: {
        minimum: {
          runtime: { connections: 2, nativeBufferBytes: 131072 },
          http: { headerBytes: 4096, bufferedBodyBytes: 65536 },
        },
      },
    });

    const changedProfile = structuredClone(networkProfile) as any;
    changedProfile.providers.netDriverId = "esp-idf.lwip.v2";
    const changed = resolveHttp(httpManifest(), changedProfile);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.plan.planHash).not.toBe(first.plan.planHash);
  });

  test("fails closed on missing policy, profile, providers, and resource budget", () => {
    const withoutPolicy = httpManifest();
    delete withoutPolicy.permissions;
    const policyResult = resolveHttp(withoutPolicy);
    expect(policyResult.ok).toBe(false);
    if (!policyResult.ok) {
      expect(policyResult.diagnostics.map((item) => item.code)).toContain("network.permissionsMissing");
    }

    const profileResult = validateAndResolveBuildPlan(
      httpManifest(),
      { target: "esp-test" },
      NETWORK_CONTRACTS,
    );
    expect(profileResult.ok).toBe(false);
    if (!profileResult.ok) {
      expect(profileResult.diagnostics.map((item) => item.code)).toContain("network.profileMissing");
    }

    const withoutBackend = structuredClone(networkProfile) as any;
    delete withoutBackend.providers.backendByRole["http.client"];
    const backendResult = resolveHttp(httpManifest(), withoutBackend);
    expect(backendResult.ok).toBe(false);
    if (!backendResult.ok) {
      expect(backendResult.diagnostics.map((item) => item.code)).toContain("network.backendMissing");
    }

    const overBudget = httpManifest();
    overBudget.resources.network.minimum.http.headerBytes = 16384;
    const resourceResult = resolveHttp(overBudget);
    expect(resourceResult.ok).toBe(false);
    if (!resourceResult.ok) {
      expect(resourceResult.diagnostics.map((item) => item.code)).toContain("network.resourceExceeded");
    }
  });

  test("reports the format-3 requirement once for a format-2 network manifest", () => {
    const legacy = httpManifest();
    legacy.$schema = "https://pocketjs.dev/schema/pocket-2.json";
    legacy.pocket = 2;
    delete legacy.permissions;
    delete legacy.resources;
    const result = validateAndResolveBuildPlan(
      legacy,
      { target: "esp-test", network: networkProfile },
      NETWORK_CONTRACTS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.filter((item) => item.code === "network.manifestVersion"))
      .toEqual([{
        code: "network.manifestVersion",
        path: "/pocket",
        message: "native network capabilities require Pocket manifest format 3",
      }]);
  });

  test("rejects reserved capabilities and role extensions without their base", () => {
    const reserved = httpManifest();
    reserved.engine.capabilities.requires = [
      "text.glyphs.baked",
      "network.discovery.mdns",
    ];
    const reservedResult = resolveHttp(reserved);
    expect(reservedResult.ok).toBe(false);
    if (!reservedResult.ok) {
      expect(reservedResult.diagnostics.map((item) => item.code))
        .toContain("network.capabilityUnsupported");
    }

    const missingBase = httpManifest();
    missingBase.engine.capabilities.requires = [
      "text.glyphs.baked",
      "network.http.client.tls",
    ];
    const dependencyResult = resolveHttp(missingBase);
    expect(dependencyResult.ok).toBe(false);
    if (!dependencyResult.ok) {
      expect(dependencyResult.diagnostics.map((item) => item.code))
        .toContain("network.capabilityDependencyMissing");
    }
  });

  test("rejects duplicate normalized endpoints and production invalid-TLS authority", () => {
    const duplicate = httpManifest();
    duplicate.permissions.network.connect.push({
      protocol: "https",
      host: "xn--bcher-kva.example",
      port: { min: 443, max: 443 },
    });
    duplicate.permissions.network.allowInvalidTlsForDevelopment = true;
    const result = resolveHttp(duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "network.duplicateEndpoint",
      "network.productionInvalidTls",
    ]));
  });
});

describe("network HostBuildInputs", () => {
  test("projects a deeply frozen, checksummed native network input", () => {
    const result = resolveHttp(httpManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inputs = extractHostBuildInputs(result.plan, { expectedTarget: "esp-test" });
    expect(inputs.network?.planHash).toBe(result.plan.planHash);
    expect(inputs.network?.features["network.http.client"]).toBe(true);
    expect(Object.isFrozen(inputs.network)).toBe(true);
    expect(Object.isFrozen(inputs.network?.policy.connect)).toBe(true);
    expect(Object.isFrozen(inputs.network?.providers.backendByRole)).toBe(true);
    expect(() => {
      (inputs.network!.policy.connect as any[]).push("mutated");
    }).toThrow();

    const environment = hostBuildEnvironment(inputs, {
      outputDirectory: "/tmp/pocket-network",
      embedApp: true,
    });
    expect(environment.POCKETJS_PLAN_HASH).toBe(result.plan.planHash);
    expect(JSON.parse(environment.POCKETJS_NETWORK_BUILD_INPUTS!)).toEqual(inputs.network);
  });
});
