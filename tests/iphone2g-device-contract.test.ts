import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const toolSource = readFileSync(join(repository, "tools/iphone2g.ts"), "utf8");
const deviceSource = readFileSync(
  join(repository, "hosts/iphone2g/device_tool.c"),
  "utf8",
);

function sourceBlock(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`missing ${label} source block`);
  return match[1];
}

function sourceBetween(
  source: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing ${label} source block`);
  return source.slice(start, end);
}

function withoutWhitespace(source: string): string {
  return source.replace(/\s+/g, "");
}

describe("iPhone 2G device transport contract", () => {
  test("stages exactly eight key-only bootstrap files with the scoped device helper", () => {
    const expectedModes = sourceBlock(
      toolSource,
      /const expectedModes:[^=]+ = \[([\s\S]*?)\n    \];/,
      "bootstrap mode manifest",
    );
    const stagedFiles = [
      ...expectedModes.matchAll(/^\s*\["([^"]+)",\s*0o[0-7]+\],?$/gm),
    ].map((match) => match[1]);

    expect(stagedFiles).toEqual([
      "root/usr/sbin/sshd",
      "root/usr/libexec/pocketjs-device",
      "root/usr/lib/libcrypto.0.9.8.dylib",
      "root/private/etc/ssh/moduli",
      "root/private/etc/ssh/sshd_config",
      "root/private/etc/ssh/ssh_host_rsa_key",
      "root/Library/LaunchDaemons/com.openssh.sshd.plist",
      "data/root/.ssh/authorized_keys_pocketjs",
    ]);
    expect(expectedModes).not.toContain("sftp");

    const receipt = sourceBetween(
      toolSource,
      'join(stage, "bootstrap-receipt.json")',
      "rmSync(destination",
      "bootstrap receipt",
    );
    const compactReceipt = withoutWhitespace(receipt);
    expect(compactReceipt).toContain("files,");
    expect(compactReceipt).toContain('protocol:"PJS2G002"');
    expect(compactReceipt).toContain('listenAddress:"127.0.0.1"');
    expect(compactReceipt).toContain("passwordAuthentication:false");
    expect(compactReceipt).toContain("sftp:false");
  });

  test("keeps the host encoder and ARMv6 receiver on one fixed framed bundle schema", () => {
    const hostFiles = sourceBlock(
      toolSource,
      /const DEVICE_BUNDLE_FILES = \[([\s\S]*?)\] as const;/,
      "host bundle file manifest",
    );
    const deviceFiles = sourceBlock(
      deviceSource,
      /static const BundleFile BUNDLE_FILES\[\] = \{([\s\S]*?)\n\};/,
      "device bundle file manifest",
    );
    const hostNames = [...hostFiles.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    const deviceNames = [...deviceFiles.matchAll(/\{"([^"]+)",/g)].map(
      (match) => match[1],
    );

    expect(hostNames).toEqual([
      "PocketJSDemo",
      "Info.plist",
      "PkgInfo",
      "Icon.png",
      "build-receipt.json",
    ]);
    expect(deviceNames).toEqual(hostNames);
    expect(toolSource).toContain('Buffer.from("PJS2G002", "ascii")');
    expect(toolSource).toContain('Buffer.from(identifier, "ascii")');
    expect(toolSource).toContain(
      "length.writeBigUInt64BE(BigInt(bytes.length))",
    );
    expect(deviceSource).toContain(
      "static const unsigned char PACKAGE_MAGIC[8] = {'P', 'J', 'S', '2', 'G', '0', '0', '2'};",
    );
    expect(deviceSource).toContain("result = (result << 8) | encoded[index]");
    expect(deviceSource).toContain("bundle stream has trailing bytes");
    expect(deviceSource).toContain("transaction=pending");
    const compactToolSource = withoutWhitespace(toolSource);
    expect(compactToolSource).toMatch(
      /deviceCommand\(\["\/usr\/libexec\/pocketjs-device","commit",identifier,?\]\)/,
    );
    expect(compactToolSource).toMatch(
      /deviceCommand\(\["\/usr\/libexec\/pocketjs-device","rollback",identifier,?\]\)/,
    );
    expect(toolSource).toContain("ensureDeviceRootReadOnly()");
    expect(toolSource).toContain("recoverPendingDeviceTransaction()");
    expect(deviceSource).toContain('strcmp(argv[1], "transaction-state")');
  });

  test("records the actual linked sysroot and deployed bundle bytes in its receipts", () => {
    expect(toolSource).toContain("const sysrootFiles = Object.fromEntries(");
    expect(toolSource).toContain(
      "Object.keys(IPHONE2G_TOOLCHAIN.compiler.sysrootFiles)",
    );
    expect(toolSource).toContain("sysrootRawSha256: sha256File(");
    expect(toolSource).toContain("bundleFiles,");
    expect(toolSource).toContain("buildId,");
    expect(toolSource).toContain("hostTools,");
    expect(toolSource).toContain("fields.build_id !== receipt.buildId");
    expect(toolSource).toContain('receiptMode: "0644"');
    expect(withoutWhitespace(toolSource)).toMatch(
      /sourceSha256:sha256File\(join\(repository,"hosts\/iphone2g\/device_tool\.c",?\),?\)/,
    );
  });
});
