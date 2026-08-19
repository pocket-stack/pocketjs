import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan, type ResolveBuildRequest } from "../framework/src/manifest/resolve.ts";

/**
 * Private ESP-IDF network-host profiles, used only by the hardware gate
 * (hosts/esp-idf/examples/net-smoke). They deliberately stay out of the
 * production `POCKET_TARGETS` registry: the ESP-IDF host ships the network
 * modules, not a renderer, so these profiles advertise exactly the roles the
 * AtomS3R and Tab5 hosts implemented and passed on hardware — the HTTP
 * client (with ESP-TLS), the HTTP server (plaintext) and the WebSocket
 * client (with ESP-TLS) — and nothing about input or text. The display
 * facts are the boards' panels; the smoke firmware is headless and never
 * presents, but a plan names the panel the build was made for.
 *
 * The point of the profile is the plan: the smoke manifest (format 3)
 * resolves against it, the resolver normalizes `permissions.network` into
 * the plan, and the firmware embeds that canonical policy — the host never
 * authors one.
 */
export const ESP_IDF_DEV_HOST_ABI = 9;
export const ATOMS3R_DEV_TARGET_ID = "atoms3r-dev";
export const TAB5_DEV_TARGET_ID = "tab5-dev";
export const ATOMS3R_VIEWPORT = [128, 128] as const;
export const TAB5_VIEWPORT = [1280, 720] as const;

export const ESP_IDF_NETWORK_CAPABILITIES = [
  "network.http.client",
  "network.http.client.tls",
  "network.http.server",
  "network.websocket.client",
  "network.websocket.client.tls",
] as const;

export const ESP_IDF_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [ATOMS3R_DEV_TARGET_ID]: {
      hostAbi: ESP_IDF_DEV_HOST_ABI,
      platform: "esp-idf",
      form: "takeover",
      display: {
        physicalViewport: ATOMS3R_VIEWPORT,
        logicalViewports: [ATOMS3R_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: ESP_IDF_NETWORK_CAPABILITIES,
    },
    [TAB5_DEV_TARGET_ID]: {
      hostAbi: ESP_IDF_DEV_HOST_ABI,
      platform: "esp-idf",
      form: "takeover",
      display: {
        physicalViewport: TAB5_VIEWPORT,
        logicalViewports: [TAB5_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: ESP_IDF_NETWORK_CAPABILITIES,
    },
  }),
);

export type EspIdfBoard = "atoms3r" | "tab5";

export function espIdfTargetId(board: EspIdfBoard): string {
  return board === "tab5" ? TAB5_DEV_TARGET_ID : ATOMS3R_DEV_TARGET_ID;
}

export function espIdfPanel(board: EspIdfBoard): readonly [number, number] {
  return board === "tab5" ? TAB5_VIEWPORT : ATOMS3R_VIEWPORT;
}

export function resolveEspIdfBuildPlan(
  input: unknown,
  board: EspIdfBoard,
  options: Omit<ResolveBuildRequest, "target"> = {},
): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: espIdfTargetId(board), ...options },
    ESP_IDF_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket esp-idf: manifest did not resolve for ${board}: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
