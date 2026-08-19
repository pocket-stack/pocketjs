import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalNetworkPolicyJson, parseNetworkPolicyJson } from "../contracts/spec/network-policy.ts";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";
import { hostInputsHeader, smokeManifest, type SmokeRig } from "../tools/esp-idf.ts";
import {
  ATOMS3R_DEV_TARGET_ID,
  ESP_IDF_DEV_CONTRACTS,
  ESP_IDF_DEV_HOST_ABI,
  ESP_IDF_NETWORK_CAPABILITIES,
  TAB5_DEV_TARGET_ID,
  resolveEspIdfBuildPlan,
} from "../tools/esp-idf-profile.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = join(REPOSITORY, "hosts/esp-idf/examples/net-smoke/pocket.json");

function smokeBase(): Record<string, any> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

const RIG: SmokeRig = {
  board: "atoms3r",
  macHost: "172.16.10.225",
  macHttpPort: 8790,
  macWsPort: 8791,
  peerHost: "172.16.10.145",
  peerPort: 8080,
  servePort: 8080,
  tlsHost: "example.com",
  tickHz: 60,
};

describe("private ESP-IDF network-host profiles", () => {
  test("stay private and advertise exactly the hardware-proven network roles", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(ATOMS3R_DEV_TARGET_ID);
    expect(POCKET_TARGETS).not.toHaveProperty(TAB5_DEV_TARGET_ID);
    for (const id of [ATOMS3R_DEV_TARGET_ID, TAB5_DEV_TARGET_ID] as const) {
      const profile = ESP_IDF_DEV_CONTRACTS.targets[id];
      expect(profile.hostAbi).toBe(ESP_IDF_DEV_HOST_ABI);
      expect(profile.platform).toBe("esp-idf");
      expect(profile.capabilities).toEqual(ESP_IDF_NETWORK_CAPABILITIES);
      // No server TLS, no input, no text: the host does not implement them.
      expect(profile.capabilities).not.toContain("network.http.server.tls");
      expect(profile.capabilities.some((c: string) => c.startsWith("input.") || c.startsWith("text."))).toBe(false);
    }
  });

  test("the smoke manifest is format 3 and resolves on both boards with the rig's endpoints merged", () => {
    const base = smokeBase();
    expect(base.pocket).toBe(3);
    expect(validatePocketManifest(base).ok).toBe(true);
    for (const board of ["atoms3r", "tab5"] as const) {
      const manifest = smokeManifest(base, { ...RIG, board });
      const plan = resolveEspIdfBuildPlan(manifest, board);
      expect(verifyPlanHash(plan)).toBe(true);
      expect(plan.target.id).toBe(board === "tab5" ? TAB5_DEV_TARGET_ID : ATOMS3R_DEV_TARGET_ID);
      expect(plan.viewport.logical).toEqual(board === "tab5" ? [1280, 720] : [128, 128]);
      expect(plan.features).toEqual({
        "network.http.client": true,
        "network.http.client.tls": true,
        "network.http.server": true,
        "network.websocket.client": true,
      });
      // The policy is the plan's: rig endpoints + the manifest's TLS hosts,
      // canonical and sorted, the serve port as the only listen rule.
      expect(plan.network.connect).toEqual([
        { protocol: "http", host: "172.16.10.145", port: 8080 },
        { protocol: "http", host: "172.16.10.225", port: { min: 8790, max: 8792 } },
        { protocol: "https", host: "example.com", port: 443 },
        { protocol: "https", host: "expired.badssl.com", port: 443 },
        { protocol: "https", host: "self-signed.badssl.com", port: 443 },
        { protocol: "https", host: "untrusted-root.badssl.com", port: 443 },
        { protocol: "https", host: "wrong.host.badssl.com", port: 443 },
        { protocol: "ws", host: "172.16.10.225", port: 8791 },
      ]);
      expect(plan.network.listen).toEqual([{ protocol: "http", address: "0.0.0.0", port: 8080 }]);
      expect(plan.network.insecureTransport).toBe(true);
      expect(plan.network.localNetwork).toBe(true);
      expect(plan.network.allowInvalidTlsForDevelopment).toBe(false);
    }
  });

  test("the firmware inputs are the plan's projection: canonical policy JSON and a header of plan facts", () => {
    const plan = resolveEspIdfBuildPlan(smokeManifest(smokeBase(), RIG), "atoms3r");
    const inputs = extractHostBuildInputs(plan);
    // What main.c embeds and hands to pnet_runtime_create verbatim.
    expect(inputs.network.policyJson).toBe(canonicalNetworkPolicyJson(plan.network));
    expect(parseNetworkPolicyJson(inputs.network.policyJson)).toEqual(plan.network);
    const header = hostInputsHeader(inputs, RIG);
    expect(header).toContain(`#define POCKETJS_PLAN_HASH "${plan.planHash}"`);
    expect(header).toContain('#define POCKETJS_TARGET "atoms3r-dev"');
    expect(header).toContain("#define POCKETJS_TICK_HZ 60");
    expect(header).toContain("#define POCKETJS_FEATURE_NETWORK_HTTP_SERVER 1");
    expect(header).toContain("#define POCKETJS_FEATURE_NETWORK_WEBSOCKET_CLIENT 1");
    expect(header).toContain("#define POCKETJS_FEATURE_NETWORK_HTTP_CLIENT_TLS 1");
    expect(header).not.toContain("SERVER_TLS");
  });

  test("a rig without peers still resolves (the suite skips what is not configured)", () => {
    const manifest = smokeManifest(smokeBase(), { ...RIG, macHost: undefined, peerHost: undefined, tlsHost: undefined });
    const plan = resolveEspIdfBuildPlan(manifest, "atoms3r");
    expect(plan.network.connect.every((rule) => rule.protocol === "https")).toBe(true);
    expect(plan.network.listen).toEqual([{ protocol: "http", address: "0.0.0.0", port: 8080 }]);
  });
});
