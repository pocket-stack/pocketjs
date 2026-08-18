import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  definePlatformContractRegistry,
  defineTargetRegistry,
  type TargetProfile,
} from "../../../../contracts/spec/platforms.ts";
import {
  networkV1FeatureIdsFromBuildPlan,
  networkV1PlanHashBytes,
} from "../../../../contracts/spec/network/network-v1.ts";
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
import {
  metadataSource,
  readCa,
  TEST_CAPABILITIES,
  TEST_NETWORK_PROFILE,
  type GeneratedMetadata,
  type TestCapability,
} from "../pocketjs_net_formal_tls_smoke_artifact/generate.ts";

const COMPONENT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(COMPONENT, "../../../..");
const TARGET_ID = "esp-formal-network-tls-conformance-test";
const APP_ID = "dev.pocketjs.esp-formal-network-tls-conformance";
const OUTPUT = "esp-formal-network-tls-conformance";
const ORIGIN = "https://pocketjs.test:8443";
const HOST = "pocketjs.test";
const PORT = 8443;
const REPORT_GLOBAL = "__pocketjsFormalNetworkTlsSmokeReportV1";
const CANCEL_GLOBAL = "__pocketjsFormalNetworkTlsSmokeCancelV1";
const PUBLIC_HTTP_SPECIFIER = "@pocketjs/framework/net/http";
const HTTP_BACKEND_ID = "pocketjs.net.http-client-core.v1.experimental";
const TLS_PROVIDER_ID = "pocketjs.net.esp-idf.esp-tls.v1.experimental";
const NET_DRIVER_ID = "pocketjs.net.esp-idf.transport.v1.experimental";

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

const encoder = new TextEncoder();

function textBytes(value: string): Uint8Array {
  return encoder.encode(value);
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
    throw new Error(`formal TLS conformance manifest did not resolve:\n${detail}`);
  }
  const plan = result.plan;
  const network = plan.network;
  const connect = network?.policy.connect ?? [];
  const providers = network?.providers;
  const tlsProvider = providers?.tlsByRole["http.client"];
  const featureIds = Array.from(networkV1FeatureIdsFromBuildPlan(plan.features));
  if (
    !verifyPlanHash(plan) ||
    network === undefined ||
    plan.app.id !== APP_ID ||
    plan.app.entry !== "app.ts" ||
    plan.app.output !== OUTPUT ||
    plan.target.id !== TARGET_ID ||
    plan.target.hostAbi !== 1 ||
    featureIds.length !== 2 ||
    featureIds[0] !== 0x0100 ||
    featureIds[1] !== 0x0101 ||
    connect.length !== 1 ||
    connect[0]?.protocol !== "https" ||
    connect[0]?.host !== HOST ||
    connect[0]?.port.min !== PORT ||
    connect[0]?.port.max !== PORT ||
    Object.keys(providers?.backendByRole ?? {}).length !== 1 ||
    providers?.backendByRole["http.client"] !== HTTP_BACKEND_ID ||
    Object.keys(providers?.tlsByRole ?? {}).length !== 1 ||
    tlsProvider?.source !== "provider" ||
    tlsProvider.id !== TLS_PROVIDER_ID ||
    providers?.netDriverId !== NET_DRIVER_ID
  ) {
    throw new Error("formal TLS conformance plan escaped its exact test identity");
  }
  return plan;
}

async function assertPublicBuildInput(): Promise<void> {
  const source = await Bun.file(join(COMPONENT, "app.ts")).text();
  if (source.split(`"${PUBLIC_HTTP_SPECIFIER}"`).length !== 2) {
    throw new Error("formal TLS conformance app must have one public HTTP import");
  }
}

async function buildFactory(plan: ResolvedBuildPlan): Promise<Uint8Array> {
  await assertPublicBuildInput();
  const temporary = await mkdtemp(join(tmpdir(), "pocketjs-formal-tls-conformance-"));
  try {
    const planPath = join(temporary, "resolved-plan.json");
    const output = join(temporary, "dist");
    await Bun.write(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const child = Bun.spawn([
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
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`formal TLS conformance build failed:\n${stdout}\n${stderr}`);
    }
    const built = await Bun.file(join(output, `${OUTPUT}.js`)).text();
    const source = textBytes(built.replace(/[\t ]+$/gm, ""));
    if (source.length === 0 || source.includes(0)) {
      throw new Error("formal TLS conformance factory is empty or contains NUL");
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
      httpClientBackendId: HTTP_BACKEND_ID,
      netDriverId: NET_DRIVER_ID,
      tlsProviderId: TLS_PROVIDER_ID,
    },
    factory: {
      sourceBytes: source.length,
      storageBytes: factory.length,
      sha256: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    },
    endpoint: {
      origin: ORIGIN,
      scheme: "https",
      host: HOST,
      port: PORT,
      healthUrl: `${ORIGIN}/health`,
      echoUrl: `${ORIGIN}/echo`,
    },
    tls: {
      providerId: TLS_PROVIDER_ID,
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
      exactAppId: APP_ID,
      exactTargetId: TARGET_ID,
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
  console.log(
    `PocketJS formal TLS conformance artifact generated in ${outputDirectory}`,
  );
}
