import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYMBIAN_DOWNLOADS,
  SYMBIAN_RUNTIME_DOWNLOADS,
  SYMBIAN_SETUP_DOWNLOADS,
  SYMBIAN_TOOLCHAIN,
  receiptMatchesSymbianManifest,
  symbianDockerBuildArguments,
  symbianDockerDoctorArguments,
  symbianDockerRunArguments,
  symbianDockerSetupArguments,
  symbianDownloadsRoot,
  symbianImplementationDigest,
} from "../tools/symbian-toolchain.ts";

const repository = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("canonical Symbian E7 toolchain", () => {
  test("pins every historical and upstream input by SHA-256", () => {
    expect(SYMBIAN_TOOLCHAIN).toMatchObject({
      schemaVersion: 1,
      toolchainVersion: "sr1-qt474-v1",
      container: {
        platform: "linux/amd64",
        signingVolume: "pocketjs-symbian-signing-v1",
      },
      gcce: { version: "4.6.3" },
      qtSource: { version: "4.7.4" },
      device: {
        usbVendorId: "0421",
        usbProductId: "0335",
        deployStorage: "Mass memory",
        deployFolder: "Installs",
      },
    });
    expect(SYMBIAN_TOOLCHAIN.container.baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(SYMBIAN_DOWNLOADS).toHaveLength(4);
    expect(SYMBIAN_RUNTIME_DOWNLOADS).toHaveLength(1);
    expect(SYMBIAN_SETUP_DOWNLOADS).toHaveLength(5);
    for (const artifact of SYMBIAN_SETUP_DOWNLOADS) {
      expect(artifact.url).toMatch(/^https:\/\//);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(SYMBIAN_TOOLCHAIN.quickjs).toMatchObject({
      version: "2026-06-04",
      rev: "0fc946fb670c0c29bc0135f510bcb0f595415a61",
    });
    expect(SYMBIAN_TOOLCHAIN.runtime).toMatchObject({
      uid: "0xE7A11010",
      rustToolchain: "nightly-2026-07-02",
      logicalViewport: [480, 272],
      frameRate: 30,
    });
    expect(SYMBIAN_TOOLCHAIN.markers).toEqual(expect.arrayContaining([
      "sdk/epoc32/include/e32base.h",
      "gcce/arm-2012.03/bin/arm-none-symbianelf-g++",
      "sdk/bin/qmake",
      "sdk/bin/moc",
      "sdk/bin/rcc",
      "sdk/bin/uic",
      "sdk/bin/elf2e32_qtwrapper",
      "bin/symbian-gcce-link",
      "bin/elf2e32",
      "bin/makesis",
      "bin/mifconv",
      "bin/rcomp",
      "bin/signsis",
    ]));
    expect(SYMBIAN_TOOLCHAIN.signing).toEqual({
      certificate: "current/pocketjs-e7-development.cer",
      privateKey: "current/pocketjs-e7-development.key",
      legacyCertificate: "signing/pocketjs-e7-development.cer",
      legacyPrivateKey: "signing/pocketjs-e7-development.key",
    });
  });

  test("resolves shared cache and an explicit downloads override", () => {
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      XDG_CACHE_HOME: "/tmp/cache",
    })).toBe("/tmp/cache/pocket-stack/symbian/downloads");
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      POCKET_STACK_CACHE_DIR: "/tmp/pocket-cache",
    })).toBe("/tmp/pocket-cache/symbian/downloads");
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      POCKETJS_SYMBIAN_DOWNLOADS: "/tmp/historical-inputs",
    })).toBe("/tmp/historical-inputs");
  });

  test("accepts only a receipt for the exact manifest inputs", () => {
    const downloads = Object.fromEntries(
      SYMBIAN_DOWNLOADS.map((artifact) => [artifact.asset, artifact.sha256]),
    );
    const receipt = {
      schemaVersion: 1,
      toolchainVersion: SYMBIAN_TOOLCHAIN.toolchainVersion,
      platform: SYMBIAN_TOOLCHAIN.container.platform,
      gnupocRev: SYMBIAN_TOOLCHAIN.gnupoc.rev,
      implementationSha256: "1".repeat(64),
      certificateSha256: "2".repeat(64),
      downloads,
      markersSha256: Object.fromEntries(
        SYMBIAN_TOOLCHAIN.markers.map((marker) => [marker, "3".repeat(64)]),
      ),
    };
    expect(receiptMatchesSymbianManifest(receipt)).toBe(true);
    expect(receiptMatchesSymbianManifest({
      ...receipt,
      downloads: { ...downloads, [SYMBIAN_TOOLCHAIN.sdk.asset]: "0".repeat(64) },
    })).toBe(false);
    expect(receiptMatchesSymbianManifest({
      ...receipt,
      markersSha256: {},
    })).toBe(false);
    expect(receiptMatchesSymbianManifest({ ...receipt, platform: "linux/arm64" })).toBe(false);
  });

  test("strict validation owns native tools, signatures, UID, and atomic output", () => {
    const setup = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-setup"),
      "utf8",
    );
    const doctor = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-doctor"),
      "utf8",
    );
    const codaUsbProbe = readFileSync(
      join(repository, "tools/symbian/coda-usb-probe.c"),
      "utf8",
    );
    const buildProbe = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-build-probe"),
      "utf8",
    );
    const buildApp = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-build-app"),
      "utf8",
    );
    const probeProject = readFileSync(
      join(repository, "hosts/symbian/probe/pocketjs-e7-probe.pro"),
      "utf8",
    );
    const dockerfile = readFileSync(
      join(repository, "tools/symbian/Dockerfile"),
      "utf8",
    );

    expect(setup).not.toContain("install_eka2_tools");
    expect(setup).toContain("Makefile.local-libelf");
    expect(setup).toContain("tools/mifconv.cpp");
    expect(setup).toContain("markersSha256: $markers");
    expect(setup).toContain("pocketjs-symbian-doctor");
    expect(doctor).toContain("sha256sum --check --status");
    expect(doctor).toContain("signsis -o");
    expect(doctor).toContain('cd "$smoke"');
    expect(doctor).toContain("makesis smoke.pkg smoke-unsigned.sis");
    expect(codaUsbProbe).toContain("NokiaVendorId = 0x0421");
    expect(codaUsbProbe).toContain("NokiaE7SuiteProductId = 0x0335");
    expect(codaUsbProbe).toContain("CodaControlInterface = 3");
    expect(codaUsbProbe).toContain("CodaDataInterface = 4");
    expect(codaUsbProbe).toContain("libusb_attach_kernel_driver");
    expect(codaUsbProbe).toContain("static int read_until(");
    expect(codaUsbProbe).toContain("CODA Locator: ready");
    expect(codaUsbProbe).not.toMatch(/imei|serial number/i);
    expect(buildProbe).toContain("output_stage=$(mktemp -d /out/");
    expect(buildProbe).toContain('mv -f "$candidate" "$output"');
    expect(buildProbe).toContain("actual_uid=$(od ");
    expect(buildApp).toContain("quickjs-symbian-gcce.patch");
    expect(buildApp).toContain("-std=gnu99");
    expect(buildApp).toContain("-O0");
    expect(buildApp).toContain("POCKETJS_CORE_LIBRARY");
    expect(buildApp).toContain("output_stage=$(mktemp -d /out/");
    expect(buildApp).toContain('mv -f "$candidate" "$output"');
    expect(buildApp).toContain("actual_uid=$(od ");
    expect(buildApp).toContain("sha256sum --check --status");
    expect(buildApp).toContain("SIS version must be three decimal components");
    expect(probeProject).toContain("QMAKE_LINK = /toolchain/current/bin/symbian-gcce-link");
    expect(probeProject).toContain("TARGET.UID3 = $$POCKETJS_SYMBIAN_UID");
    expect(probeProject).not.toContain(SYMBIAN_TOOLCHAIN.probe.uid);
    expect(dockerfile).toContain(
      `ARG POCKETJS_SYMBIAN_BASE_IMAGE=${SYMBIAN_TOOLCHAIN.container.baseImage}`,
    );
    expect(dockerfile).toContain("pocketjs-symbian-build-app");
  });

  test("Docker invocations are amd64, pinned, and narrowly mounted", () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-repository-"));
    temporary.push(root);
    cpSync(join(repository, "tools/cli"), join(root, "tools/cli"), { recursive: true });
    cpSync(join(repository, "tools/symbian"), join(root, "tools/symbian"), {
      recursive: true,
    });
    const output = join(root, "dist/symbian");
    mkdirSync(output, { recursive: true });
    const build = symbianDockerBuildArguments(root);
    const implementation = symbianImplementationDigest(root);
    expect(implementation).toMatch(/^[a-f0-9]{64}$/);
    expect(build).toEqual(expect.arrayContaining([
      "build",
      "--platform=linux/amd64",
      "--progress=plain",
      "--build-arg",
      `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
      "--build-arg",
      `POCKETJS_SYMBIAN_BASE_IMAGE=${SYMBIAN_TOOLCHAIN.container.baseImage}`,
      "--build-arg",
      `POCKETJS_SYMBIAN_TOOLCHAIN_VERSION=${SYMBIAN_TOOLCHAIN.toolchainVersion}`,
      "--tag",
      SYMBIAN_TOOLCHAIN.container.image,
    ]));

    const run = symbianDockerRunArguments("/usr/local/bin/build-probe", [], {
      repository: root,
      output,
      downloads: "/tmp/pocketjs-symbian-downloads",
    });
    expect(run).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      "--env",
      `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
      `type=bind,src=${root},dst=/workspace,readonly`,
      `type=bind,src=${output},dst=/out`,
      "type=bind,src=/tmp/pocketjs-symbian-downloads,dst=/downloads,readonly",
    ]));
    expect(run.join(" ")).not.toMatch(/--privileged|\/dev(?:\/|\s)|\/tmp\/home|\/Users\//);

    const setup = symbianDockerSetupArguments(
      "/tmp/pocketjs-symbian-downloads",
      root,
    );
    expect(setup).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing`,
      "type=bind,src=/tmp/pocketjs-symbian-downloads,dst=/downloads,readonly",
    ]));

    const doctor = symbianDockerDoctorArguments(root);
    expect(doctor).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
    ]));
  });
});
