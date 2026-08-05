import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapControllerScript } from "../tools/iphone2g.ts";

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
  const end =
    start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing ${label} source block`);
  return source.slice(start, end);
}

function withoutWhitespace(source: string): string {
  return source.replace(/\s+/g, "");
}

describe("iPhone 2G device transport contract", () => {
  test("stages only the signed helper, key-only config, and client key", () => {
    const expectedModes = sourceBlock(
      toolSource,
      /const expectedModes:[^=]+ = \[([\s\S]*?)\n    \];/,
      "bootstrap mode manifest",
    );
    const stagedFiles = [
      ...expectedModes.matchAll(/^\s*\["([^"]+)",\s*0o[0-7]+\],?$/gm),
    ].map((match) => match[1]);

    expect(stagedFiles).toEqual([
      "root/usr/libexec/pocketjs-device",
      "root/private/etc/ssh/sshd_config",
      "data/root/.ssh/authorized_keys",
    ]);
    expect(expectedModes).not.toContain("sftp");
    expect(expectedModes).not.toContain("usr/sbin/sshd");
    expect(expectedModes).not.toContain("ssh_host_rsa_key");
    expect(expectedModes).not.toContain("LaunchDaemons");

    const receipt = sourceBetween(
      toolSource,
      'join(stage, "bootstrap-receipt.json")',
      "rmSync(destination",
      "bootstrap receipt",
    );
    const compactReceipt = withoutWhitespace(receipt);
    expect(compactReceipt).toContain("files,");
    expect(compactReceipt).toContain('protocol:"PJS2G003"');
    expect(compactReceipt).toContain("signed:true");
    expect(compactReceipt).toContain('productVersion:"3.1.3"');
    expect(compactReceipt).toContain('buildVersion:"7E18"');
    expect(compactReceipt).toContain('mountPolicy:"rw-root-data"');
    expect(compactReceipt).toContain("passwordAuthentication:false");
    expect(compactReceipt).toContain("preserveDeviceSshd:true");
    expect(compactReceipt).toContain("preserveDeviceHostKey:true");
    expect(compactReceipt).toContain("preserveDeviceLaunchdPlist:true");
    expect(compactReceipt).toContain("sftp:false");
  });

  test("installs bootstrap transactionally before disabling password SSH", () => {
    const compact = withoutWhitespace(toolSource);
    expect(toolSource).toContain("async function installBootstrap()");
    expect(toolSource).toContain("PJS_BOOTSTRAP_KEY_READY");
    expect(toolSource).toContain("PJS_BOOTSTRAP_SECURE_READY");
    expect(toolSource).toContain("PJS_BOOTSTRAP_COMMITTED");
    expect(toolSource).toContain('runBinary("/bin/sh", ["-n"]');
    expect(toolSource).toContain("/usr/sbin/sysctl -n hw.machine");
    expect(toolSource).toContain('"3.1.3\\n7E18\\niPhone1,1\\n"');
    expect(compact.indexOf("verifyInstalledBootstrap(receipt);")).toBeLessThan(
      compact.indexOf('controller.stdin.write("secure\\n")'),
    );
    expect(toolSource).toContain('SSHPASS: "alpine"');
    expect(toolSource).toContain("PreferredAuthentications=password");
    expect(toolSource).toContain("PubkeyAuthentication=no");
    expect(toolSource).toContain("password SSH remained enabled");
    expect(toolSource).toContain(
      "preserved CustomHJ sshd, host key, and launchd plist",
    );
    expect(toolSource).toContain("/bin/chown 0:0");
    expect(toolSource).toContain("/bin/sed 's,/,-,g'");
    expect(toolSource).not.toContain("/usr/sbin/chown");
    expect(toolSource).not.toContain("/usr/bin/sed");
    const generated = bootstrapControllerScript("a".repeat(32));
    const syntax = spawnSync("/bin/sh", ["-n"], {
      input: generated,
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  test("scopes legacy SSH algorithms and manages the USB tunnel", () => {
    for (const option of [
      "HostKeyAlgorithms=+ssh-rsa",
      "PubkeyAcceptedAlgorithms=+ssh-rsa",
      "diffie-hellman-group14-sha1",
      "diffie-hellman-group1-sha1",
      "aes128-cbc",
      "3des-cbc",
      "hmac-sha1",
      "hmac-md5",
    ]) {
      expect(toolSource).toContain(option);
    }
    expect(toolSource).toContain("async function withManagedTunnel");
    expect(toolSource).toContain('command === "tunnel"');
    expect(toolSource).toContain('command === "install-bootstrap"');
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
    expect(toolSource).toContain('join(repository, "hosts/iphone2g/Icon.png")');
    expect(toolSource).not.toContain(
      'join(repository, "assets/images/logo.png"), join(bundle, "Icon.png")',
    );
    expect(toolSource).toContain('Buffer.from("PJS2G003", "ascii")');
    expect(toolSource).toContain('Buffer.from(identifier, "ascii")');
    expect(toolSource).toContain(
      "length.writeBigUInt64BE(BigInt(bytes.length))",
    );
    expect(deviceSource).toContain(
      "static const unsigned char PACKAGE_MAGIC[8] = {'P', 'J', 'S', '2', 'G', '0', '0', '3'};",
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
    expect(toolSource).toContain("ensureDeviceMountPolicy()");
    expect(toolSource).toContain("recoverPendingDeviceTransaction()");
    expect(toolSource).toContain(
      "cd / && /bin/su mobile -c '/usr/bin/uicache'",
    );
    expect(deviceSource).toContain('strcmp(argv[1], "transaction-state")');
    expect(deviceSource).toContain('strcmp(argv[1], "mount-state")');
    expect(deviceSource).not.toContain('run_mount("-ur")');
    expect(deviceSource).not.toContain('run_mount("-uw")');
    expect(deviceSource).toContain('mount_is_read_write("/")');
    expect(deviceSource).toContain('mount_is_read_write("/private/var")');
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
    expect(toolSource).toContain("signed: true");
    expect(toolSource).toContain('signer: "ldid -S"');
    expect(toolSource).toContain('mustRun(ldid, ["-S", executable])');
    expect(toolSource).toContain('mustRun(ldid, ["-S", output])');
    expect(toolSource).toContain('loadCommands.includes("LC_CODE_SIGNATURE")');
    expect(toolSource).toContain(
      "GraphicsServices must remain a dlsym-only 1.x fallback on 3.1.3",
    );
    expect(withoutWhitespace(toolSource)).toMatch(
      /sourceSha256:sha256File\(join\(repository,"hosts\/iphone2g\/device_tool\.c",?\),?\)/,
    );
  });

  test("treats device-status as live frame and touch acceptance", () => {
    expect(toolSource).toContain("const positiveAcceptanceCounters = [");
    expect(toolSource).toContain('"guest_frames"');
    expect(toolSource).toContain('"touch_sequences"');
    expect(toolSource).toContain('"last_touch_hit"');
    expect(toolSource).toContain('fields.state !== "running"');
    expect(toolSource).toContain(
      "runtime acceptance requires running frames and a successful touch hit",
    );
  });

  test("launches only the currently deployed build through SpringBoard", () => {
    expect(toolSource).toContain('command === "launch"');
    expect(toolSource).toContain('"pocketjs-iphone2g-demo://launch"');
    expect(toolSource).toContain('"/usr/bin/uiopen"');
    expect(toolSource).toContain(
      "installed app does not match the current local build; deploy first",
    );
  });
});
