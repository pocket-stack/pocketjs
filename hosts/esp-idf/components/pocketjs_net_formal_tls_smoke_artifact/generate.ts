import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineCapabilityRegistry,
  definePlatformContractRegistry,
  defineTargetRegistry,
  type CapabilityId,
  type TargetProfile,
} from "../../../../contracts/spec/platforms.ts";
import {
  networkV1FeatureIdsFromBuildPlan,
  networkV1PlanHashBytes,
} from "../../../../contracts/spec/network/network-v1.ts";
import type { HostNetworkResolutionProfile } from
  "../../../../framework/src/manifest/network.ts";
import {
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../../../../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from
  "../../../../framework/src/manifest/resolve.ts";
import {
  testArtifactOutputDirectory,
  writeTestArtifactOutputs,
  type GeneratedTestArtifactOutput,
} from "../../../../tools/test-artifact-output.ts";

const COMPONENT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(COMPONENT, "../../../..");
const TARGET_ID = "esp-formal-network-tls-smoke-test";
const ORIGIN = "https://pocketjs.test:8443";
const SCHEME = "https";
const HOST = "pocketjs.test";
const PORT = 8443;
const REPORT_GLOBAL = "__pocketjsFormalNetworkTlsSmokeReportV1";
const CANCEL_GLOBAL = "__pocketjsFormalNetworkTlsSmokeCancelV1";
const PUBLIC_HTTP_SPECIFIER = "@pocketjs/framework/net/http";
const TLS_PROVIDER_ID = "pocketjs.net.esp-idf.esp-tls.v1.experimental";
export const EXPECTED_CA_DER_SHA256 =
  "sha256:318ae57f0fb82d12cf86431571fb6ec3556ecb74f530a5be6f741a482b5447af";

export const TEST_CAPABILITIES = defineCapabilityRegistry([
  "network.http.client",
  "network.http.client.tls",
] as const);

export type TestCapability = CapabilityId<typeof TEST_CAPABILITIES>;

const TEST_TARGET_DEFINITIONS = {
  [TARGET_ID]: {
    hostAbi: 1,
    platform: "esp-idf-formal-network-tls-test",
    form: "takeover",
    display: {
      physicalViewport: [1, 1],
      logicalViewports: [[1, 1]],
      presentations: ["native"],
      rasterDensity: 1,
    },
    capabilities: ["network.http.client", "network.http.client.tls"],
  },
} as const satisfies Readonly<Record<string, TargetProfile<TestCapability>>>;

const TEST_TARGETS = defineTargetRegistry<
  TestCapability,
  typeof TEST_TARGET_DEFINITIONS
>(TEST_TARGET_DEFINITIONS);

const TEST_CONTRACTS = definePlatformContractRegistry(
  TEST_CAPABILITIES,
  TEST_TARGETS,
);

export const TEST_NETWORK_PROFILE: HostNetworkResolutionProfile = {
  providers: {
    backendByRole: {
      "http.client": "pocketjs.net.http-client-core.v1.experimental",
    },
    tlsByRole: {
      "http.client": {
        source: "provider",
        id: TLS_PROVIDER_ID,
      },
    },
    netDriverId: "pocketjs.net.esp-idf.transport.v1.experimental",
  },
  hardLimits: {
    runtime: {
      connections: 4,
      pendingOperations: 8,
      completionDescriptors: 8,
      nativeBufferBytes: 524288,
    },
    http: {
      connections: 4,
      inflightRequests: 8,
      headerBytes: 8192,
      headerCount: 60,
      bufferedBodyBytes: 16384,
    },
  },
  developmentBuild: false,
};

export interface GeneratedMetadata {
  readonly schemaVersion: 1;
  readonly testOnly: true;
  readonly target: { readonly id: string; readonly hostAbi: number };
  readonly planHash: string;
  readonly planHashBytes: readonly number[];
  readonly featureIds: readonly number[];
  readonly providers: {
    readonly httpClientBackendId: string;
    readonly netDriverId: string;
    readonly tlsProviderId: string;
  };
  readonly factory: {
    readonly sourceBytes: number;
    readonly storageBytes: number;
    readonly sha256: string;
  };
  readonly endpoint: {
    readonly origin: string;
    readonly scheme: string;
    readonly host: string;
    readonly port: number;
    readonly healthUrl: string;
    readonly echoUrl: string;
  };
  readonly tls: {
    readonly providerId: string;
    readonly trustSource: "host-pinned-ca";
    readonly minVersion: "1.2";
    readonly maxVersion: "1.2";
    readonly verification: "full";
    readonly revocation: "host-default";
    readonly caPemBytes: number;
    readonly caDerSha256: string;
  };
  readonly reportGlobal: string;
  readonly cancelGlobal: string;
  readonly stagedSurfaceBuild: {
    readonly publicSpecifier: string;
    readonly permit: "test-only-staged-https-client-fetch";
    readonly exactAppId: string;
    readonly exactTargetId: string;
    readonly productionGateChanged: false;
  };
}

const encoder = new TextEncoder();

function textBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function cBytes(bytes: readonly number[] | Uint8Array, columns = 12): string {
  const values = Array.from(bytes);
  const lines: string[] = [];
  for (let offset = 0; offset < values.length; offset += columns) {
    lines.push(
      `    ${values.slice(offset, offset + columns)
        .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
        .join(", ")},`,
    );
  }
  return lines.join("\n");
}

function cFeatureIds(ids: readonly number[]): string {
  return ids
    .map((id) =>
      `    (pocketjs_network_v1_feature_id_t)0x${id.toString(16).padStart(4, "0")},`
    )
    .join("\n");
}

function cString(value: string): string {
  return JSON.stringify(value);
}

export function metadataSource(
  plan: ResolvedBuildPlan,
  metadata: GeneratedMetadata,
  caPem: Uint8Array,
): string {
  const factoryDigest = metadata.factory.sha256.slice("sha256:".length);
  const factoryHash = Array.from(Buffer.from(factoryDigest, "hex"));
  const caStorage = new Uint8Array(caPem.length + 1);
  caStorage.set(caPem);
  return `// GENERATED by generate.ts; do not edit.
// SPDX-License-Identifier: MIT

#include "pocketjs/net/formal_tls_smoke_artifact.h"

extern const uint8_t embedded_factory_start[]
    asm("_binary_factory_js_bin_start");

const uint8_t *const pocketjs_net_formal_tls_smoke_factory_bytes =
    embedded_factory_start;
const size_t pocketjs_net_formal_tls_smoke_factory_length =
    ${metadata.factory.sourceBytes}U;
const size_t pocketjs_net_formal_tls_smoke_factory_storage_length =
    ${metadata.factory.storageBytes}U;

const char pocketjs_net_formal_tls_smoke_plan_hash[] = ${cString(plan.planHash)};
const uint8_t pocketjs_net_formal_tls_smoke_plan_hash_bytes
    [POCKETJS_NETWORK_V1_PLAN_HASH_BYTES] = {
${cBytes(metadata.planHashBytes)}
};

const pocketjs_network_v1_feature_id_t
    pocketjs_net_formal_tls_smoke_feature_ids[] = {
${cFeatureIds(metadata.featureIds)}
};
const uint16_t pocketjs_net_formal_tls_smoke_feature_count =
    ${metadata.featureIds.length}U;

const char pocketjs_net_formal_tls_smoke_http_client_backend_id[] =
    ${cString(metadata.providers.httpClientBackendId)};
const char pocketjs_net_formal_tls_smoke_net_driver_id[] =
    ${cString(metadata.providers.netDriverId)};

const char pocketjs_net_formal_tls_smoke_factory_sha256[] =
    ${cString(metadata.factory.sha256)};
const uint8_t pocketjs_net_formal_tls_smoke_factory_sha256_bytes[32] = {
${cBytes(factoryHash)}
};

const pocketjs_net_formal_tls_smoke_endpoint_t
    pocketjs_net_formal_tls_smoke_endpoint = {
        .origin = ${cString(metadata.endpoint.origin)},
        .scheme = ${cString(metadata.endpoint.scheme)},
        .host = ${cString(metadata.endpoint.host)},
        .port = ${metadata.endpoint.port}U,
        .health_url = ${cString(metadata.endpoint.healthUrl)},
        .echo_url = ${cString(metadata.endpoint.echoUrl)},
};

const uint8_t pocketjs_net_formal_tls_smoke_ca_pem[] = {
${cBytes(caStorage)}
};
const size_t pocketjs_net_formal_tls_smoke_ca_pem_length = ${caPem.length}U;
const size_t pocketjs_net_formal_tls_smoke_ca_pem_storage_length =
    ${caStorage.length}U;
const char pocketjs_net_formal_tls_smoke_ca_der_sha256[] =
    ${cString(metadata.tls.caDerSha256)};
const char pocketjs_net_formal_tls_smoke_tls_provider_id[] =
    ${cString(metadata.providers.tlsProviderId)};

const char pocketjs_net_formal_tls_smoke_report_global[] =
    ${cString(metadata.reportGlobal)};
const char pocketjs_net_formal_tls_smoke_cancel_global[] =
    ${cString(metadata.cancelGlobal)};

_Static_assert(sizeof(pocketjs_net_formal_tls_smoke_plan_hash) == 72U,
               "plan hash text length drifted");
_Static_assert(sizeof(pocketjs_net_formal_tls_smoke_factory_sha256) == 72U,
               "artifact hash text length drifted");
_Static_assert(sizeof(pocketjs_net_formal_tls_smoke_ca_pem) ==
                   ${caStorage.length}U,
               "CA snapshot storage length drifted");
`;
}

export async function resolvePlan(): Promise<ResolvedBuildPlan> {
  const manifest = await Bun.file(join(COMPONENT, "manifest.json")).json();
  const result = validateAndResolveBuildPlan(
    manifest,
    { target: TARGET_ID, network: TEST_NETWORK_PROFILE },
    TEST_CONTRACTS,
  );
  if (!result.ok) {
    const detail = result.diagnostics
      .map((item) => `${item.code} ${item.path}: ${item.message}`)
      .join("\n");
    throw new Error(`formal TLS smoke manifest did not resolve:\n${detail}`);
  }
  if (!verifyPlanHash(result.plan) || result.plan.network === undefined) {
    throw new Error("formal TLS smoke resolver did not produce a verified network plan");
  }
  if (
    result.plan.app.id !== "dev.pocketjs.esp-formal-network-tls-smoke" ||
    result.plan.app.entry !== "app.ts" ||
    result.plan.target.id !== TARGET_ID
  ) {
    throw new Error("formal TLS smoke plan escaped its exact test-only identity");
  }
  const connect = result.plan.network.policy.connect;
  const backend = result.plan.network.providers.backendByRole["http.client"];
  const driver = result.plan.network.providers.netDriverId;
  const tlsProvider = result.plan.network.providers.tlsByRole["http.client"];
  if (
    connect.length !== 1 ||
    connect[0]?.protocol !== SCHEME ||
    connect[0]?.host !== HOST ||
    connect[0]?.port.min !== PORT ||
    connect[0]?.port.max !== PORT ||
    backend !== "pocketjs.net.http-client-core.v1.experimental" ||
    driver !== "pocketjs.net.esp-idf.transport.v1.experimental" ||
    Object.keys(result.plan.network.providers.backendByRole).length !== 1 ||
    Object.keys(result.plan.network.providers.tlsByRole).length !== 1 ||
    tlsProvider?.source !== "provider" ||
    tlsProvider.id !== TLS_PROVIDER_ID
  ) {
    throw new Error("formal TLS smoke plan endpoint or TLS provider drifted");
  }
  return result.plan;
}

export async function readCa(): Promise<{ pem: Uint8Array; derSha256: string }> {
  const pem = new Uint8Array(await Bun.file(
    join(COMPONENT, "fixtures/ca.cert.pem"),
  ).arrayBuffer());
  if (pem.length === 0 || pem.includes(0)) {
    throw new Error("formal TLS smoke CA PEM is empty or contains NUL");
  }
  const certificate = new X509Certificate(pem);
  const derSha256 = `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`;
  if (derSha256 !== EXPECTED_CA_DER_SHA256 || !certificate.ca) {
    throw new Error("formal TLS smoke CA identity or CA basic constraint drifted");
  }
  return { pem, derSha256 };
}

async function assertPublicBuildInput(): Promise<void> {
  const source = await Bun.file(join(COMPONENT, "app.ts")).text();
  if (source.split(`"${PUBLIC_HTTP_SPECIFIER}"`).length !== 2) {
    throw new Error("formal TLS smoke app must contain exactly one public HTTP import");
  }
}

async function buildFactory(plan: ResolvedBuildPlan): Promise<Uint8Array> {
  await assertPublicBuildInput();
  const temporary = await mkdtemp(join(tmpdir(), "pocketjs-formal-tls-smoke-"));
  try {
    const planPath = join(temporary, "resolved-plan.json");
    const output = join(temporary, "dist");
    await Bun.write(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const buildProcess = Bun.spawn([
      process.execPath,
      join(ROOT, "tools/build.ts"),
      `--plan=${planPath}`,
      `--project-root=${COMPONENT}`,
      `--outdir=${output}`,
      "--no-config",
      "--network-factory",
      "--test-only-staged-https-client-fetch",
    ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      buildProcess.exited,
      new Response(buildProcess.stdout).text(),
      new Response(buildProcess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`formal TLS smoke factory build failed:\n${stdout}\n${stderr}`);
    }
    const builtSource = await Bun.file(
      join(output, "esp-formal-network-tls-smoke.js"),
    ).text();
    const source = textBytes(builtSource.replace(/[\t ]+$/gm, ""));
    if (source.length === 0 || source.includes(0)) {
      throw new Error("formal TLS smoke factory source is empty or contains NUL");
    }
    const terminated = new Uint8Array(source.length + 1);
    terminated.set(source);
    return terminated;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function expectedOutputs(): Promise<readonly GeneratedTestArtifactOutput[]> {
  const [plan, ca] = await Promise.all([resolvePlan(), readCa()]);
  const factory = await buildFactory(plan);
  const source = factory.subarray(0, factory.length - 1);
  const featureIds = Array.from(networkV1FeatureIdsFromBuildPlan(plan.features));
  const metadata: GeneratedMetadata = {
    schemaVersion: 1,
    testOnly: true,
    target: { id: plan.target.id, hostAbi: plan.target.hostAbi },
    planHash: plan.planHash,
    planHashBytes: Array.from(networkV1PlanHashBytes(plan.planHash)),
    featureIds,
    providers: {
      httpClientBackendId:
        plan.network!.providers.backendByRole["http.client"]!,
      netDriverId: plan.network!.providers.netDriverId,
      tlsProviderId:
        plan.network!.providers.tlsByRole["http.client"]!.id,
    },
    factory: {
      sourceBytes: source.length,
      storageBytes: factory.length,
      sha256: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    },
    endpoint: {
      origin: ORIGIN,
      scheme: SCHEME,
      host: HOST,
      port: PORT,
      healthUrl: `${ORIGIN}/health`,
      echoUrl: `${ORIGIN}/echo`,
    },
    tls: {
      providerId:
        plan.network!.providers.tlsByRole["http.client"]!.id,
      trustSource: "host-pinned-ca",
      minVersion: "1.2",
      maxVersion: "1.2",
      verification: "full",
      revocation: "host-default",
      caPemBytes: ca.pem.length,
      caDerSha256: ca.derSha256,
    },
    reportGlobal: REPORT_GLOBAL,
    cancelGlobal: CANCEL_GLOBAL,
    stagedSurfaceBuild: {
      publicSpecifier: PUBLIC_HTTP_SPECIFIER,
      permit: "test-only-staged-https-client-fetch",
      exactAppId: plan.app.id,
      exactTargetId: plan.target.id,
      productionGateChanged: false,
    },
  };
  return [
    { name: "resolved-plan.json", bytes: textBytes(`${JSON.stringify(plan, null, 2)}\n`) },
    { name: "metadata.json", bytes: textBytes(`${JSON.stringify(metadata, null, 2)}\n`) },
    { name: "factory.js.bin", bytes: factory },
    {
      name: "formal_tls_smoke_metadata.c",
      bytes: textBytes(metadataSource(plan, metadata, ca.pem)),
    },
  ];
}

export async function generate(outputDirectory: string): Promise<void> {
  const outputs = await expectedOutputs();
  await writeTestArtifactOutputs(outputDirectory, outputs);
}

if (import.meta.main) {
  const outputDirectory = testArtifactOutputDirectory(process.argv.slice(2));
  await generate(outputDirectory);
  console.log(`PocketJS formal TLS smoke artifact generated in ${outputDirectory}`);
}
