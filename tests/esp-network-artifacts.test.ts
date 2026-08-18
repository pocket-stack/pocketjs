import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  networkV1FeatureIdsFromBuildPlan,
  networkV1PlanHashBytes,
} from "../contracts/spec/network/network-v1.ts";
import { transformFile } from "../framework/compiler/jsx-plugin.ts";
import {
  finalizeBuildPlan,
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../framework/src/manifest/plan.ts";
import { generate as generateHttp } from
  "../hosts/esp-idf/components/pocketjs_net_formal_smoke_artifact/generate.ts";
import { generate as generateTlsConformance } from
  "../hosts/esp-idf/components/pocketjs_net_formal_tls_conformance_artifact/generate.ts";
import { generate as generateTlsSmoke } from
  "../hosts/esp-idf/components/pocketjs_net_formal_tls_smoke_artifact/generate.ts";
import { createNetworkFactoryBuildContext } from
  "../tools/network-bundle-factory.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPONENTS = join(ROOT, "hosts/esp-idf/components");
const HTTP_COMPONENT = join(COMPONENTS, "pocketjs_net_formal_smoke_artifact");
const TLS_COMPONENT = join(COMPONENTS, "pocketjs_net_formal_tls_smoke_artifact");
const CONFORMANCE_COMPONENT = join(
  COMPONENTS,
  "pocketjs_net_formal_tls_conformance_artifact",
);
const EXPECTED_CA_DER_SHA256 =
  "sha256:318ae57f0fb82d12cf86431571fb6ec3556ecb74f530a5be6f741a482b5447af";

type Permit = "none" | "http" | "https" | "both";

interface ArtifactCase {
  readonly name: string;
  readonly component: string;
  readonly generated: string;
  readonly metadataSource: string;
  readonly planHash: string;
  readonly featureIds: readonly number[];
  readonly origin: string;
}

interface ArtifactMetadata {
  readonly planHashBytes: readonly number[];
  readonly featureIds: readonly number[];
  readonly endpoint: { readonly origin: string };
  readonly factory: {
    readonly storageBytes: number;
    readonly sourceBytes: number;
    readonly sha256: string;
  };
  readonly providers: Record<string, string>;
  readonly tls?: {
    readonly trustSource: string;
    readonly minVersion: string;
    readonly maxVersion: string;
    readonly verification: string;
    readonly revocation: string;
    readonly caDerSha256: string;
    readonly caPemBytes: number;
  };
  readonly target?: { readonly id: string; readonly hostAbi: number };
  readonly stagedSurfaceBuild?: {
    readonly permit: string;
    readonly exactAppId: string;
    readonly exactTargetId: string;
    readonly publicSpecifier: string;
    readonly productionGateChanged: boolean;
  };
}

let temporary = "";
let artifacts: readonly ArtifactCase[] = [];

async function readJson<T>(path: string): Promise<T> {
  return await Bun.file(path).json() as T;
}

async function readPlan(artifact: ArtifactCase): Promise<ResolvedBuildPlan> {
  return await readJson(join(artifact.generated, "resolved-plan.json"));
}

async function spawnBuild(
  artifact: ArtifactCase,
  planPath: string,
  output: string,
  permit: Permit,
): Promise<{ exitCode: number; output: string }> {
  const stdoutPath = `${output}.stdout.log`;
  const stderrPath = `${output}.stderr.log`;
  const child = Bun.spawn({
    cmd: [
      "bun",
      join(ROOT, "tools/build.ts"),
      `--plan=${planPath}`,
      `--project-root=${artifact.component}`,
      `--outdir=${output}`,
      "--no-config",
      "--network-factory",
      ...(permit === "http" || permit === "both"
        ? ["--test-only-staged-http-client-fetch"]
        : []),
      ...(permit === "https" || permit === "both"
        ? ["--test-only-staged-https-client-fetch"]
        : []),
    ],
    cwd: ROOT,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    Bun.file(stdoutPath).text(),
    Bun.file(stderrPath).text(),
  ]);
  return {
    exitCode,
    output: `exit=${exitCode} signal=${String(child.signalCode)}\n${stdout}\n${stderr}`,
  };
}

async function expectRefused(
  artifact: ArtifactCase,
  plan: ResolvedBuildPlan,
  label: string,
  permit: Permit,
  message: string,
): Promise<void> {
  const planPath = join(temporary, `${label}.json`);
  await Bun.write(planPath, `${JSON.stringify(plan)}\n`);
  const result = await spawnBuild(
    artifact,
    planPath,
    join(temporary, `${label}-build`),
    permit,
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain(message);
}

async function runProbe(
  component: string,
  generated: string,
): Promise<Record<string, unknown>> {
  const label = component === HTTP_COMPONENT ? "http" : "tls";
  const stdoutPath = join(temporary, `${label}-probe.stdout.log`);
  const stderrPath = join(temporary, `${label}-probe.stderr.log`);
  const child = Bun.spawn({
    cmd: ["bun", join(component, "runtime_probe.ts")],
    cwd: ROOT,
    env: {
      ...process.env,
      POCKETJS_TEST_ARTIFACT_DIR: generated,
    },
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    Bun.file(stdoutPath).text(),
    Bun.file(stderrPath).text(),
  ]);
  expect(
    exitCode,
    `exit=${exitCode} signal=${String(child.signalCode)}\n${stdout}\n${stderr}`,
  ).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pocketjs-net-artifacts-"));
  const httpGenerated = join(temporary, "http");
  const tlsGenerated = join(temporary, "tls");
  const conformanceGenerated = join(temporary, "conformance");
  await generateHttp(httpGenerated);
  await generateTlsSmoke(tlsGenerated);
  await generateTlsConformance(conformanceGenerated);
  artifacts = Object.freeze([
    {
      name: "http-smoke",
      component: HTTP_COMPONENT,
      generated: httpGenerated,
      metadataSource: "formal_smoke_metadata.c",
      planHash:
        "sha256:04856acc82e7aa31648b015e62a63a4cadf6f48a3d1d3f46f3987539520b63fd",
      featureIds: [0x0100],
      origin: "http://172.16.10.126:8088",
    },
    {
      name: "tls-smoke",
      component: TLS_COMPONENT,
      generated: tlsGenerated,
      metadataSource: "formal_tls_smoke_metadata.c",
      planHash:
        "sha256:9240cfa29c1678b49b6fed67104a39b2ad32f5dedab372af1c2a0bde3d602654",
      featureIds: [0x0100, 0x0101],
      origin: "https://pocketjs.test:8443",
    },
    {
      name: "tls-conformance",
      component: CONFORMANCE_COMPONENT,
      generated: conformanceGenerated,
      metadataSource: "formal_tls_smoke_metadata.c",
      planHash:
        "sha256:fe3014e4d3628eb60aaeedd414432eb8c9a5932e904b258a9d05a17c7f6abcce",
      featureIds: [0x0100, 0x0101],
      origin: "https://pocketjs.test:8443",
    },
  ]);
});

afterAll(async () => {
  if (temporary.length > 0) {
    await rm(temporary, { recursive: true, force: true });
  }
});

describe("ESP network test artifacts", () => {
  test("generate deterministic plans, metadata, and NUL-terminated factories", async () => {
    const hashes = new Set<string>();
    for (const artifact of artifacts) {
      const [plan, metadata, storageBuffer, metadataSource] = await Promise.all([
        readPlan(artifact),
        readJson<ArtifactMetadata>(join(artifact.generated, "metadata.json")),
        Bun.file(join(artifact.generated, "factory.js.bin")).arrayBuffer(),
        Bun.file(join(artifact.generated, artifact.metadataSource)).text(),
      ]);
      expect(verifyPlanHash(plan), artifact.name).toBe(true);
      expect(plan.planHash, artifact.name).toBe(artifact.planHash);
      expect(metadata.planHashBytes, artifact.name).toEqual(
        Array.from(networkV1PlanHashBytes(plan.planHash)),
      );
      expect(metadata.featureIds, artifact.name).toEqual(
        Array.from(networkV1FeatureIdsFromBuildPlan(plan.features)),
      );
      expect(metadata.featureIds, artifact.name).toEqual(artifact.featureIds);
      expect(metadata.endpoint.origin, artifact.name).toBe(artifact.origin);
      expect(metadataSource, artifact.name).toContain(
        'asm("_binary_factory_js_bin_start")',
      );
      expect(metadataSource, artifact.name).not.toContain(
        "_binary_generated_factory_js_bin_start",
      );

      const storage = new Uint8Array(storageBuffer);
      expect(storage.at(-1), artifact.name).toBe(0);
      expect(storage.subarray(0, -1).includes(0), artifact.name).toBe(false);
      expect(storage.length, artifact.name).toBe(metadata.factory.storageBytes);
      expect(storage.length - 1, artifact.name).toBe(metadata.factory.sourceBytes);
      expect(
        `sha256:${createHash("sha256").update(storage.subarray(0, -1)).digest("hex")}`,
        artifact.name,
      ).toBe(metadata.factory.sha256);
      hashes.add(plan.planHash);
    }
    expect(hashes.size).toBe(artifacts.length);
  });

  test("snapshot the intended HTTP and TLS providers and public test CA", async () => {
    const [http, tls, conformance, pem] = await Promise.all([
      readJson<ArtifactMetadata>(join(artifacts[0]!.generated, "metadata.json")),
      readJson<ArtifactMetadata>(join(artifacts[1]!.generated, "metadata.json")),
      readJson<ArtifactMetadata>(join(artifacts[2]!.generated, "metadata.json")),
      Bun.file(join(TLS_COMPONENT, "fixtures/ca.cert.pem")).text(),
    ]);
    expect(http.providers).toEqual({
      httpClientBackendId: "pocketjs.net.http-client-core.v1.experimental",
      netDriverId: "pocketjs.net.esp-idf.transport.v1.experimental",
    });
    expect(tls.providers).toEqual({
      httpClientBackendId: "pocketjs.net.http-client-core.v1.experimental",
      netDriverId: "pocketjs.net.esp-idf.transport.v1.experimental",
      tlsProviderId: "pocketjs.net.esp-idf.esp-tls.v1.experimental",
    });
    expect(tls.tls).toMatchObject({
      trustSource: "host-pinned-ca",
      minVersion: "1.2",
      maxVersion: "1.2",
      verification: "full",
      revocation: "host-default",
      caDerSha256: EXPECTED_CA_DER_SHA256,
    });
    const certificate = new X509Certificate(pem);
    expect(certificate.ca).toBe(true);
    expect(
      `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`,
    ).toBe(EXPECTED_CA_DER_SHA256);
    expect(tls.tls?.caPemBytes).toBe(Buffer.byteLength(pem));
    expect(conformance.target).toEqual({
      id: "esp-formal-network-tls-conformance-test",
      hostAbi: 1,
    });
    expect(conformance.stagedSurfaceBuild).toEqual({
      permit: "test-only-staged-https-client-fetch",
      exactAppId: "dev.pocketjs.esp-formal-network-tls-conformance",
      exactTargetId: "esp-formal-network-tls-conformance-test",
      publicSpecifier: "@pocketjs/framework/net/http",
      productionGateChanged: false,
    });
  });

  test("keeps test permits private and limited to the fetch binding", async () => {
    for (const artifact of artifacts.slice(0, 2)) {
      const plan = await readPlan(artifact);
      const normal = createNetworkFactoryBuildContext(plan);
      await expect(transformFile(
        `/virtual/${artifact.name}-default.ts`,
        'import { fetch } from "@pocketjs/framework/net/http"; void fetch;',
        "solid",
        { features: plan.features, networkPrivate: normal },
      )).rejects.toThrow("staged surface");
      const permitted = Object.freeze({
        ...normal,
        ...(artifact === artifacts[0]
          ? { testOnlyStagedHttpClientFetch: true as const }
          : { testOnlyStagedHttpsClientFetch: true as const }),
      });
      await expect(transformFile(
        `/virtual/${artifact.name}-permitted.ts`,
        'import { fetch } from "@pocketjs/framework/net/http"; void fetch;',
        "solid",
        { features: plan.features, networkPrivate: permitted },
      )).resolves.toBeDefined();
      await expect(transformFile(
        `/virtual/${artifact.name}-headers.ts`,
        'import { Headers } from "@pocketjs/framework/net/http"; void Headers;',
        "solid",
        { features: plan.features, networkPrivate: permitted },
      )).rejects.toThrow("staged surface");
    }
  });

  test("rejects absent, crossed, ambiguous, and mutated permits", async () => {
    const [http, tls, conformance] = artifacts;
    const httpPlanPath = join(http!.generated, "resolved-plan.json");
    const tlsPlanPath = join(tls!.generated, "resolved-plan.json");
    const conformancePlanPath = join(conformance!.generated, "resolved-plan.json");

    const absent = await spawnBuild(
      http!,
      httpPlanPath,
      join(temporary, "absent-permit"),
      "none",
    );
    expect(absent.exitCode).not.toBe(0);
    expect(absent.output).toContain("staged surface");

    const httpWithTlsPermit = await spawnBuild(
      http!,
      httpPlanPath,
      join(temporary, "http-with-tls-permit"),
      "https",
    );
    expect(httpWithTlsPermit.exitCode).not.toBe(0);
    expect(httpWithTlsPermit.output).toContain(
      "restricted to the exact ESP formal TLS test plans and entries",
    );

    const tlsWithHttpPermit = await spawnBuild(
      tls!,
      tlsPlanPath,
      join(temporary, "tls-with-http-permit"),
      "http",
    );
    expect(tlsWithHttpPermit.exitCode).not.toBe(0);
    expect(tlsWithHttpPermit.output).toContain(
      "restricted to the exact ESP formal network smoke plan and entry",
    );

    const both = await spawnBuild(
      conformance!,
      conformancePlanPath,
      join(temporary, "both-permits"),
      "both",
    );
    expect(both.exitCode).not.toBe(0);
    expect(both.output).toContain("mutually exclusive");

    const crossed = await spawnBuild(
      conformance!,
      tlsPlanPath,
      join(temporary, "crossed-tls-entry"),
      "https",
    );
    expect(crossed.exitCode).not.toBe(0);
    expect(crossed.output).toContain(
      "restricted to the exact ESP formal TLS test plans and entries",
    );

    const httpPlan = await readPlan(http!);
    const { planHash: _httpHash, ...httpContent } = httpPlan;
    await expectRefused(
      http!,
      finalizeBuildPlan({
        ...httpContent,
        network: {
          ...httpContent.network!,
          policy: {
            ...httpContent.network!.policy,
            connect: [{
              protocol: "http",
              host: "172.16.10.127",
              port: { min: 8088, max: 8088 },
            }],
          },
        },
      }),
      "mutated-http-policy",
      "http",
      "restricted to the exact ESP formal network smoke plan and entry",
    );

    const conformancePlan = await readPlan(conformance!);
    const { planHash: _tlsHash, ...conformanceContent } = conformancePlan;
    await expectRefused(
      conformance!,
      finalizeBuildPlan({
        ...conformanceContent,
        network: {
          ...conformanceContent.network!,
          providers: {
            ...conformanceContent.network!.providers,
            tlsByRole: {
              "http.client": {
                source: "provider",
                id: "pocketjs.net.attacker",
              },
            },
          },
        },
      }),
      "mutated-tls-provider",
      "https",
      "restricted to the exact ESP formal TLS test plans and entries",
    );
  });

  test("mounts only at invocation and reports bounded Host refusal", async () => {
    const [httpReport, tlsReport] = await Promise.all([
      runProbe(HTTP_COMPONENT, artifacts[0]!.generated),
      runProbe(TLS_COMPONENT, artifacts[1]!.generated),
    ]);
    for (const report of [httpReport, tlsReport]) {
      expect(report).toMatchObject({
        phase: "failed",
        done: true,
        ok: false,
        roundsTotal: 20,
        roundsStarted: 1,
        roundsPassed: 0,
        requestsPassed: 0,
        frameCalls: 0,
        errorCode: "permission_denied",
      });
    }
  });

  test("rejects non-canonical Host IPv4 spellings", async () => {
    const binary = join(temporary, "ipv4-validation-test");
    const compile = Bun.spawn({
      cmd: [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-I${join(TLS_COMPONENT, "test_host/fake_include")}`,
        `-I${join(TLS_COMPONENT, "private")}`,
        join(TLS_COMPONENT, "src/formal_tls_smoke_ipv4.c"),
        join(TLS_COMPONENT, "test_host/ipv4_validation_test.c"),
        "-o",
        binary,
      ],
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(await compile.exited).toBe(0);
    expect(await Bun.spawn({ cmd: [binary] }).exited).toBe(0);
  });
});
