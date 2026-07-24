import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import manifestJson from "./cli/symbian-toolchain.json";
import { pocketStackCacheRoot } from "./psp-toolchain.ts";

export interface PinnedDownload {
  readonly asset: string;
  readonly url: string;
  readonly sha256: string;
}

export interface SymbianToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly container: {
    readonly platform: "linux/amd64";
    readonly baseImage: string;
    readonly image: string;
    readonly volume: string;
    readonly signingVolume: string;
  };
  readonly gnupoc: PinnedDownload & {
    readonly repository: string;
    readonly rev: string;
  };
  readonly sdk: PinnedDownload & {
    readonly name: string;
    readonly extractRoot: string;
  };
  readonly gcce: PinnedDownload & {
    readonly version: string;
    readonly linuxArchive: string;
  };
  readonly qtSource: PinnedDownload & {
    readonly version: string;
    readonly extractRoot: string;
  };
  readonly downloadsCachePath: string;
  readonly receipt: string;
  readonly signing: {
    readonly certificate: string;
    readonly privateKey: string;
    readonly legacyCertificate: string;
    readonly legacyPrivateKey: string;
  };
  readonly markers: readonly string[];
  readonly device: {
    readonly usbVendorId: string;
    readonly usbProductId: string;
    readonly mtpName: string;
    readonly deployStorage: string;
    readonly deployFolder: string;
  };
  readonly probe: {
    readonly uid: string;
    readonly output: string;
  };
}

export const SYMBIAN_TOOLCHAIN = manifestJson as SymbianToolchainManifest;
export const SYMBIAN_DOWNLOADS = [
  SYMBIAN_TOOLCHAIN.gnupoc,
  SYMBIAN_TOOLCHAIN.sdk,
  SYMBIAN_TOOLCHAIN.gcce,
  SYMBIAN_TOOLCHAIN.qtSource,
] as const;

export function symbianDownloadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POCKETJS_SYMBIAN_DOWNLOADS?.trim();
  if (explicit) return resolve(explicit);
  return join(pocketStackCacheRoot(env), SYMBIAN_TOOLCHAIN.downloadsCachePath);
}

export function symbianDownloadPath(
  artifact: PinnedDownload,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(symbianDownloadsRoot(env), artifact.asset);
}

export interface SymbianReceipt {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly platform: string;
  readonly gnupocRev: string;
  readonly implementationSha256: string;
  readonly certificateSha256: string;
  readonly downloads: Readonly<Record<string, string>>;
  readonly markersSha256: Readonly<Record<string, string>>;
}

export function receiptMatchesSymbianManifest(
  receipt: unknown,
  implementationSha256?: string,
): receipt is SymbianReceipt {
  if (typeof receipt !== "object" || receipt === null) return false;
  const value = receipt as Partial<SymbianReceipt>;
  if (
    value.schemaVersion !== 1 ||
    value.toolchainVersion !== SYMBIAN_TOOLCHAIN.toolchainVersion ||
    value.platform !== SYMBIAN_TOOLCHAIN.container.platform ||
    value.gnupocRev !== SYMBIAN_TOOLCHAIN.gnupoc.rev ||
    !value.implementationSha256?.match(/^[a-f0-9]{64}$/) ||
    !value.certificateSha256?.match(/^[a-f0-9]{64}$/) ||
    (implementationSha256 !== undefined &&
      value.implementationSha256 !== implementationSha256) ||
    typeof value.downloads !== "object" ||
    value.downloads === null ||
    typeof value.markersSha256 !== "object" ||
    value.markersSha256 === null
  ) return false;
  return SYMBIAN_DOWNLOADS.every(
    (artifact) => value.downloads?.[artifact.asset] === artifact.sha256,
  ) && SYMBIAN_TOOLCHAIN.markers.every(
    (marker) => value.markersSha256?.[marker]?.match(/^[a-f0-9]{64}$/),
  );
}

const SYMBIAN_IMPLEMENTATION_FILES = [
  "tools/cli/symbian-toolchain.json",
  "tools/symbian/Dockerfile",
  "tools/symbian/Dockerfile.dockerignore",
  "tools/symbian/container/pocketjs-symbian-setup",
  "tools/symbian/container/pocketjs-symbian-doctor",
  "tools/symbian/container/pocketjs-symbian-build-probe",
  "tools/symbian/container/symbian-gcce-link",
  "tools/symbian/container/patches/makesis-openssl-1.1.patch",
  "tools/symbian/container/patches/makesis-openssl-1.1-pem-eof.patch",
] as const;

export function symbianImplementationDigest(repository: string): string {
  const root = absoluteMount(repository, "repository");
  const hash = createHash("sha256");
  for (const relative of SYMBIAN_IMPLEMENTATION_FILES) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function localSymbianReceipt(path: string): SymbianReceipt | undefined {
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return receiptMatchesSymbianManifest(receipt) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

export interface SymbianDockerMounts {
  readonly repository: string;
  readonly output: string;
  readonly downloads?: string;
}

function absoluteMount(path: string, name: string): string {
  const value = resolve(path);
  if (!isAbsolute(value)) throw new Error(`${name} must resolve to an absolute path`);
  return value;
}

/**
 * Build one least-privilege Docker invocation. USB stays on the macOS host;
 * the container receives only the named toolchain volume and narrow binds.
 */
export function symbianDockerRunArguments(
  entrypoint: string,
  args: readonly string[],
  mounts: SymbianDockerMounts,
): string[] {
  const repository = absoluteMount(mounts.repository, "repository");
  const output = absoluteMount(mounts.output, "output");
  const implementation = symbianImplementationDigest(repository);
  const result = [
    "run",
    "--rm",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--network=none",
    "--env",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
    "--mount",
    `type=bind,src=${repository},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${output},dst=/out`,
  ];
  if (mounts.downloads) {
    result.push(
      "--mount",
      `type=bind,src=${absoluteMount(mounts.downloads, "downloads")},dst=/downloads,readonly`,
    );
  }
  result.push(
    "--entrypoint",
    entrypoint,
    SYMBIAN_TOOLCHAIN.container.image,
    ...args,
  );
  return result;
}

export function symbianDockerBuildArguments(repository: string): string[] {
  const root = absoluteMount(repository, "repository");
  const implementation = symbianImplementationDigest(root);
  return [
    "build",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--progress=plain",
    "--build-arg",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--build-arg",
    `POCKETJS_SYMBIAN_BASE_IMAGE=${SYMBIAN_TOOLCHAIN.container.baseImage}`,
    "--build-arg",
    `POCKETJS_SYMBIAN_TOOLCHAIN_VERSION=${SYMBIAN_TOOLCHAIN.toolchainVersion}`,
    "--file",
    join(root, "tools/symbian/Dockerfile"),
    "--tag",
    SYMBIAN_TOOLCHAIN.container.image,
    root,
  ];
}

export function symbianDockerSetupArguments(downloads: string, repository: string): string[] {
  const implementation = symbianImplementationDigest(repository);
  return [
    "run",
    "--rm",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--network=none",
    "--env",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing`,
    "--mount",
    `type=bind,src=${absoluteMount(downloads, "downloads")},dst=/downloads,readonly`,
    "--entrypoint",
    "/usr/local/bin/pocketjs-symbian-setup",
    SYMBIAN_TOOLCHAIN.container.image,
  ];
}

export function symbianDockerDoctorArguments(repository: string): string[] {
  const implementation = symbianImplementationDigest(repository);
  return [
    "run",
    "--rm",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--network=none",
    "--env",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
    "--entrypoint",
    "/usr/local/bin/pocketjs-symbian-doctor",
    SYMBIAN_TOOLCHAIN.container.image,
  ];
}

export function hasSymbianDownloads(env: NodeJS.ProcessEnv = process.env): boolean {
  return SYMBIAN_DOWNLOADS.every((artifact) => existsSync(symbianDownloadPath(artifact, env)));
}
