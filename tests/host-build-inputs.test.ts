import { describe, expect, test } from "bun:test";
import {
  DENY_ALL_NETWORK_POLICY,
  canonicalNetworkPolicyJson,
} from "../contracts/spec/network-policy.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/src/manifest/host-build-inputs.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const portableInput: unknown = await Bun.file(
  new URL("./fixtures/manifests/portable-psp.json", import.meta.url),
).json();

function portablePlan() {
  const result = validateAndResolveBuildPlan(portableInput, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

describe("custom host build boundary", () => {
  test("projects a verified plan onto stable host inputs", () => {
    const plan = portablePlan();
    expect(extractHostBuildInputs(plan, { expectedTarget: "psp" })).toEqual({
      appOutput: "main",
      target: "psp",
      hostAbi: 1,
      planHash: plan.planHash,
      viewport: {
        logical: [480, 272],
        physical: [480, 272],
        presentation: "integer-fit",
        rasterDensity: 1,
      },
      features: {
        "input.analog.left": true,
        "input.buttons": true,
        "text.glyphs.baked": true,
      },
      // A format-2 manifest carries no permissions: the host receives the
      // deny-all policy, spelled in the canonical form every core parses.
      network: {
        policy: DENY_ALL_NETWORK_POLICY,
        policyJson: canonicalNetworkPolicyJson(DENY_ALL_NETWORK_POLICY),
      },
    });
    expect(extractHostBuildInputs(plan).network.policyJson).toBe(
      '{"allowInvalidTlsForDevelopment":false,"connect":[],"credentials":[],"insecureTransport":false,"listen":[],"localNetwork":false,"version":1}',
    );
  });

  test("projects a format-3 network policy verbatim and refuses a tampered one", () => {
    const manifest = structuredClone(portableInput) as Record<string, any>;
    manifest.$schema = "https://pocketjs.dev/schema/pocket-3.json";
    manifest.pocket = 3;
    manifest.permissions = {
      network: {
        connect: [
          { protocol: "https", host: "API.Example.com.", port: 443 },
          { protocol: "http", host: "192.168.1.20", port: { min: 8080, max: 8080 } },
        ],
        listen: [{ protocol: "http", address: "0:0:0:0:0:0:0:0", port: "ephemeral" }],
        credentials: ["device-cert"],
        insecureTransport: true,
        localNetwork: true,
      },
    };
    const result = validateAndResolveBuildPlan(manifest, { target: "psp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inputs = extractHostBuildInputs(result.plan);
    expect(inputs.network.policy).toEqual({
      version: 1,
      connect: [
        { protocol: "http", host: "192.168.1.20", port: 8080 },
        { protocol: "https", host: "api.example.com", port: 443 },
      ],
      listen: [{ protocol: "http", address: "::", port: "ephemeral" }],
      credentials: ["device-cert"],
      localNetwork: true,
      insecureTransport: true,
      allowInvalidTlsForDevelopment: false,
    });
    expect(inputs.network.policyJson).toBe(canonicalNetworkPolicyJson(result.plan.network));
    // Widening the policy after resolution breaks the checksum.
    const widened = structuredClone(result.plan) as any;
    widened.network.connect.push({ protocol: "https", host: "evil.example", port: 443 });
    expect(() => extractHostBuildInputs(widened)).toThrow("invalid ResolvedBuildPlan checksum");
  });

  test("rejects a modified plan and an unexpected target", () => {
    const plan = portablePlan();
    expect(() => extractHostBuildInputs({ ...plan, app: { ...plan.app, output: "other" } }))
      .toThrow("invalid ResolvedBuildPlan checksum");
    expect(() => extractHostBuildInputs(plan, { expectedTarget: "vita" }))
      .toThrow("expected target vita, got psp");
  });

  test("generates one target-neutral native environment", () => {
    const inputs = extractHostBuildInputs(portablePlan());
    expect(hostBuildEnvironment(inputs, {
      outputDirectory: "/tmp/pocket",
      embedApp: false,
    })).toEqual({
      POCKETJS_APP_OUTPUT: "main",
      POCKETJS_EMBED_APP: "0",
      POCKETJS_OUTPUT_DIR: "/tmp/pocket",
      POCKETJS_TARGET: "psp",
      POCKETJS_HOST_ABI: "1",
      POCKETJS_LOGICAL_WIDTH: "480",
      POCKETJS_LOGICAL_HEIGHT: "272",
      POCKETJS_PHYSICAL_WIDTH: "480",
      POCKETJS_PHYSICAL_HEIGHT: "272",
      POCKETJS_PRESENTATION: "integer-fit",
      POCKETJS_RASTER_DENSITY: "1",
      POCKETJS_PLAN_HASH: inputs.planHash,
      POCKETJS_NETWORK_POLICY: canonicalNetworkPolicyJson(DENY_ALL_NETWORK_POLICY),
    });
  });
});
