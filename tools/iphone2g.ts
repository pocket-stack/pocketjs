import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  IPHONE2G_TOOLCHAIN,
  inspectIPhone2GToolchain,
  iphone2gCacheRoot,
  iphone2gCsuPath,
  iphone2gLegacyKitPath,
  iphone2gQuickJsPath,
  iphone2gRamdiskPath,
  iphone2gSysrootPath,
  sha256File,
} from "./iphone2g-toolchain.ts";
import { resolveIPhone2GBuildPlan } from "./iphone2g-profile.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const command = Bun.argv[2] ?? "doctor";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface BinaryCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function run(
  executable: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runBinary(
  executable: string,
  args: readonly string[],
  input?: Uint8Array,
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): BinaryCommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd,
    env,
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout),
    stderr: result.stderr.toString(),
  };
}

function mustRun(
  executable: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = run(executable, args, cwd, env);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.exitCode})${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function xcrunFind(tool: string): string | undefined {
  const result = run("xcrun", ["--find", tool]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function commandPath(tool: string): string | undefined {
  const result = run("/usr/bin/which", [tool]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "[ok]" : "[missing]"} ${label}: ${detail}`);
  return ok;
}

function doctor(): void {
  const status = inspectIPhone2GToolchain();
  const clang = xcrunFind("clang");
  const linker = xcrunFind(IPHONE2G_TOOLCHAIN.compiler.linker);
  const rustup = commandPath("rustup");
  const rustc = rustup
    ? run(rustup, [
        "which",
        "--toolchain",
        IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
        "rustc",
      ])
    : undefined;
  const ldid = commandPath("ldid");
  const checks = [
    check("Xcode clang", !!clang, clang || "install/select Xcode"),
    check(
      "classic linker",
      !!linker,
      linker || "Xcode no longer provides ld-classic",
    ),
    check(
      "stock 4A102 firmware",
      status.firmware,
      join(status.cacheRoot, "downloads"),
    ),
    check(
      "decrypted root filesystem",
      status.rootFilesystem,
      join(status.cacheRoot, "sysroot-1.1.4"),
    ),
    check("read-only-derived sysroot", status.sysroot, iphone2gSysrootPath()),
    check("Apple Csu-76", status.csu, iphone2gCsuPath()),
    check("pinned QuickJS", status.quickjs, iphone2gQuickJsPath()),
    check("pinned Legacy-iOS-Kit", status.legacyKit, iphone2gLegacyKitPath()),
    check("verified SSH ramdisk", status.ramdisk, iphone2gRamdiskPath()),
    check(
      `Rust ${IPHONE2G_TOOLCHAIN.compiler.rustToolchain}`,
      rustc?.exitCode === 0,
      rustc?.stdout.trim() || "install the pinned nightly with rustup",
    ),
    check(
      "OpenSSH 4.7p1 package",
      status.openssh,
      join(status.cacheRoot, "downloads/bootstrap"),
    ),
    check(
      "OpenSSL 0.9.8g package",
      status.openssl,
      join(status.cacheRoot, "downloads/bootstrap"),
    ),
  ];
  console.log(
    `${ldid ? "[ok]" : "[optional]"} ldid: ${ldid || "not required by iPhone OS 1.1.4"}`,
  );
  console.log(`cache: ${status.cacheRoot}`);
  if (checks.some((ok) => !ok)) process.exitCode = 1;
}

function ensureQuickJs(): void {
  const destination = iphone2gQuickJsPath();
  const compiler = IPHONE2G_TOOLCHAIN.compiler;
  if (inspectIPhone2GToolchain().quickjs) return;
  if (existsSync(destination)) {
    throw new Error(
      `refusing to replace an unverified QuickJS directory: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    compiler.quickJsRepository,
    destination,
  ]);
  mustRun("git", [
    "-C",
    destination,
    "checkout",
    "--detach",
    compiler.quickJsRevision,
  ]);
  const revision = mustRun("git", ["-C", destination, "rev-parse", "HEAD"]);
  const versionPath = join(destination, "libquickjs-sys/embed/quickjs/VERSION");
  const version = existsSync(versionPath)
    ? readFileSync(versionPath, "utf8").trim()
    : "";
  if (
    revision !== compiler.quickJsRevision ||
    version !== compiler.quickJsVersion ||
    !inspectIPhone2GToolchain().quickjs
  ) {
    throw new Error(`QuickJS verification failed at ${destination}`);
  }
}

function ensureSources(): void {
  ensureCsu();
  ensureQuickJs();
  ensureLegacyKit();
}

function ensureLegacyKit(): void {
  const destination = iphone2gLegacyKitPath();
  const manifest = IPHONE2G_TOOLCHAIN.ramdisk;
  if (inspectIPhone2GToolchain().legacyKit) return;
  if (existsSync(destination)) {
    throw new Error(
      `refusing to replace an unverified Legacy-iOS-Kit directory: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    manifest.repository,
    destination,
  ]);
  mustRun("git", [
    "-C",
    destination,
    "checkout",
    "--detach",
    manifest.revision,
  ]);
  const revision = mustRun("git", ["-C", destination, "rev-parse", "HEAD"]);
  if (revision !== manifest.revision || !inspectIPhone2GToolchain().legacyKit) {
    throw new Error(`Legacy-iOS-Kit verification failed at ${destination}`);
  }
}

function ensureCsu(): void {
  const destination = iphone2gCsuPath();
  const manifest = IPHONE2G_TOOLCHAIN.compiler.csu;
  if (inspectIPhone2GToolchain().csu) return;
  if (existsSync(destination)) {
    throw new Error(
      `refusing to replace an unverified Csu directory: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--branch",
    manifest.tag,
    "--single-branch",
    manifest.repository,
    destination,
  ]);
  const revision = mustRun("git", ["-C", destination, "rev-parse", "HEAD"]);
  if (revision !== manifest.revision || !inspectIPhone2GToolchain().csu) {
    throw new Error(`Apple Csu verification failed at ${destination}`);
  }
}

function buildDemo(): void {
  const manifestPath = join(repository, "apps/iphone2g-demo/pocket.json");
  const plan = resolveIPhone2GBuildPlan(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const planPath = join(repository, ".pocket/iphone2g/iphone2g-demo.plan.json");
  const output = join(repository, "dist/iphone2g/guest");
  mkdirSync(dirname(planPath), { recursive: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  mustRun(process.execPath, [
    join(repository, "tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${repository}`,
    `--outdir=${output}`,
  ]);
  console.log(`PocketJS iPhone 2G: guest bundle -> ${output}`);
}

function buildRuntime(): void {
  ensureSources();
  const status = inspectIPhone2GToolchain();
  if (!status.sysroot || !status.csu || !status.quickjs) {
    throw new Error(
      "PocketJS iPhone 2G: run `bun tools/iphone2g.ts doctor` and provide the verified sysroot/sources first",
    );
  }

  const clang = xcrunFind("clang");
  const linker = xcrunFind(IPHONE2G_TOOLCHAIN.compiler.linker);
  if (!clang || !linker)
    throw new Error(
      "PocketJS iPhone 2G: Xcode clang/ld-classic is unavailable",
    );
  const macosSdkPath = mustRun("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const hostTools = {
    xcode: mustRun("xcodebuild", ["-version"]),
    clang: mustRun(clang, ["--version"]),
    classicLinker: linker,
    macosSdkPath,
    macosSdkVersion: mustRun("xcrun", [
      "--sdk",
      "macosx",
      "--show-sdk-version",
    ]),
  };

  const sysroot = iphone2gSysrootPath();
  const csu = iphone2gCsuPath();
  const quickjs = join(iphone2gQuickJsPath(), "libquickjs-sys/embed/quickjs");
  const build = join(repository, ".pocket-build/iphone2g/runtime");
  // Building core/alloc/compiler_builtins for this custom ARMv6 target is the
  // slow part of the toolchain. Keep Cargo's target directory outside the
  // disposable native-object directory so subsequent demo builds reuse it.
  const rustTarget = join(iphone2gCacheRoot(), "build/rust-target");
  const bundle = join(repository, "dist/iphone2g/PocketJSDemo.app");
  const guestJavaScript = join(
    repository,
    "dist/iphone2g/guest/iphone2g-demo-main.js",
  );
  const guestPack = join(
    repository,
    "dist/iphone2g/guest/iphone2g-demo-main.pak",
  );
  if (!existsSync(guestJavaScript) || !existsSync(guestPack)) {
    throw new Error(
      "PocketJS iPhone 2G: guest bundle is absent; run `bun tools/iphone2g.ts build-demo`",
    );
  }
  // This nonce binds a device acceptance record to one concrete deployment,
  // including rebuilds whose guest bytes happen to be unchanged.
  const buildId = randomBytes(16).toString("hex");
  rmSync(build, { recursive: true, force: true });
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  mkdirSync(rustTarget, { recursive: true });
  mkdirSync(bundle, { recursive: true });

  const common = [
    "-target",
    IPHONE2G_TOOLCHAIN.compiler.target,
    `-miphoneos-version-min=${IPHONE2G_TOOLCHAIN.compiler.minimumVersion}`,
    "-march=armv6",
    "-Os",
    "-fno-stack-protector",
    "-fno-builtin",
    "-fno-common",
    "-fwrapv",
    "-funsigned-char",
    "-U_FORTIFY_SOURCE",
    "-D_FORTIFY_SOURCE=0",
    "-isysroot",
    macosSdkPath,
  ];
  const compile = (
    source: string,
    output: string,
    extra: readonly string[] = [],
  ) => {
    mustRun(clang, [...common, ...extra, "-c", source, "-o", output]);
  };
  const firstPartyWarnings = [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-incompatible-sysroot",
  ];
  compile(join(csu, "start.s"), join(build, "csu-start.o"), [
    "-x",
    "assembler-with-cpp",
  ]);
  compile(join(csu, "dyld_glue.s"), join(build, "csu-dyld-glue.o"), [
    "-x",
    "assembler-with-cpp",
    "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header",
    "-DCRT",
  ]);
  compile(
    join(repository, "hosts/iphone2g/crt_globals.c"),
    join(build, "crt_globals.o"),
    firstPartyWarnings,
  );
  compile(
    join(repository, "hosts/iphone2g/runtime.c"),
    join(build, "runtime.o"),
    [
      ...firstPartyWarnings,
      `-DPOCKET_BUILD_ID="${buildId}"`,
      "-Wno-cast-function-type-mismatch",
    ],
  );
  compile(
    join(repository, "hosts/iphone2g/pocket_runtime.c"),
    join(build, "pocket_runtime.o"),
    [...firstPartyWarnings, "-isystem", quickjs],
  );
  compile(
    join(repository, "hosts/iphone2g/compat.c"),
    join(build, "compat.o"),
    firstPartyWarnings,
  );

  const quickJsObjects: string[] = [];
  for (const source of [
    "quickjs.c",
    "cutils.c",
    "dtoa.c",
    "libregexp.c",
    "libunicode.c",
  ]) {
    const object = join(build, `quickjs-${source.replace(/\.c$/, "")}.o`);
    compile(join(quickjs, source), object, [
      "-I",
      quickjs,
      `-DCONFIG_VERSION=\"${IPHONE2G_TOOLCHAIN.compiler.quickJsVersion}\"`,
    ]);
    quickJsObjects.push(object);
  }

  const rustup = commandPath("rustup");
  if (!rustup) throw new Error("PocketJS iPhone 2G: rustup is unavailable");
  const rustc = mustRun(rustup, [
    "which",
    "--toolchain",
    IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
    "rustc",
  ]);
  const cargo = mustRun(rustup, [
    "which",
    "--toolchain",
    IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
    "cargo",
  ]);
  const coreDirectory = join(repository, "engine/symbian");
  const rustTargetSpec = join(
    repository,
    "hosts/iphone2g/armv6-apple-ios.json",
  );
  mustRun(
    cargo,
    [
      "build",
      "--release",
      "--locked",
      "--features",
      "bare-platform",
      "--target",
      rustTargetSpec,
      "-Z",
      "json-target-spec",
      "-Z",
      "build-std=core,alloc,compiler_builtins",
      "-Z",
      "build-std-features=compiler-builtins-mem",
    ],
    coreDirectory,
    {
      ...process.env,
      RUSTC: rustc,
      CARGO_TARGET_DIR: rustTarget,
      IPHONEOS_DEPLOYMENT_TARGET: "10.0",
    },
  );
  const coreLibrary = join(
    rustTarget,
    "armv6-apple-ios/release/libpocketjs_symbian_core.a",
  );
  if (!existsSync(coreLibrary)) {
    throw new Error(
      `PocketJS iPhone 2G: Rust core archive is absent: ${coreLibrary}`,
    );
  }

  const embeddedJavaScript = join(build, "app.js.bin");
  writeFileSync(
    embeddedJavaScript,
    Buffer.concat([readFileSync(guestJavaScript), Buffer.from([0])]),
  );

  const executable = join(bundle, "PocketJSDemo");
  mustRun(linker, [
    "-arch",
    "armv6",
    "-syslibroot",
    sysroot,
    "-L/usr/lib",
    "-F/System/Library/Frameworks",
    "-iphoneos_version_min",
    IPHONE2G_TOOLCHAIN.compiler.minimumVersion,
    "-no_pie",
    "-no_uuid",
    "-no_function_starts",
    "-no_data_in_code_info",
    "-no_source_version",
    "-no_compact_unwind",
    "-no_adhoc_codesign",
    "-no_encryption",
    "-e",
    "start",
    "-o",
    executable,
    join(build, "csu-start.o"),
    join(build, "csu-dyld-glue.o"),
    join(build, "crt_globals.o"),
    join(build, "runtime.o"),
    join(build, "pocket_runtime.o"),
    join(build, "compat.o"),
    "-force_load",
    coreLibrary,
    ...quickJsObjects,
    "-sectcreate",
    "__DATA",
    "__pocket_js",
    embeddedJavaScript,
    "-sectcreate",
    "__DATA",
    "__pocket_pak",
    guestPack,
    "-framework",
    "UIKit",
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "GraphicsServices",
    "-lobjc",
    "-lSystem",
    "-lgcc_s_v6.1",
  ]);

  cpSync(
    join(repository, "hosts/iphone2g/Info.plist"),
    join(bundle, "Info.plist"),
  );
  cpSync(join(repository, "hosts/iphone2g/PkgInfo"), join(bundle, "PkgInfo"));
  cpSync(join(repository, "assets/images/logo.png"), join(bundle, "Icon.png"));
  mustRun("sips", [
    "--resampleHeightWidth",
    "57",
    "57",
    join(bundle, "Icon.png"),
  ]);
  chmodSync(executable, 0o755);
  for (const name of ["Info.plist", "PkgInfo", "Icon.png"])
    chmodSync(join(bundle, name), 0o644);
  mustRun("plutil", ["-lint", join(bundle, "Info.plist")]);

  const fileInfo = mustRun("file", [executable]);
  const dependencies = mustRun("xcrun", ["otool-classic", "-L", executable]);
  const loadCommands = mustRun("xcrun", ["otool-classic", "-l", executable]);
  const symbols = mustRun("xcrun", ["nm-classic", executable]);
  if (!fileInfo.includes("Mach-O executable arm_v6")) {
    throw new Error(`PocketJS iPhone 2G: unexpected binary: ${fileInfo}`);
  }
  for (const dependency of [
    "UIKit.framework/UIKit",
    "Foundation.framework/Foundation",
    "CoreGraphics.framework/CoreGraphics",
    "GraphicsServices.framework/GraphicsServices",
    "libobjc.A.dylib",
    "libSystem.B.dylib",
    "libgcc_s_v6.1.dylib",
  ]) {
    if (!dependencies.includes(dependency)) {
      throw new Error(
        `PocketJS iPhone 2G: linked binary is missing ${dependency}`,
      );
    }
  }
  for (const marker of [
    "LC_VERSION_MIN_IPHONEOS",
    "version 1.1.4",
    "sectname __pocket_js",
    "sectname __pocket_pak",
  ]) {
    if (!loadCommands.includes(marker)) {
      throw new Error(
        `PocketJS iPhone 2G: linked binary is missing load-command marker ${marker}`,
      );
    }
  }
  for (const symbol of [
    "_main",
    "_pocket_runtime_boot",
    "_ui_hit_test_bounds",
  ]) {
    if (!symbols.includes(symbol)) {
      throw new Error(
        `PocketJS iPhone 2G: linked binary is missing runtime symbol ${symbol}`,
      );
    }
  }

  const sysrootFiles = Object.fromEntries(
    Object.keys(IPHONE2G_TOOLCHAIN.compiler.sysrootFiles).map((relative) => [
      relative,
      sha256File(join(sysroot, relative)),
    ]),
  );
  const bundleFiles = Object.fromEntries(
    ["PocketJSDemo", "Info.plist", "PkgInfo", "Icon.png"].map((name) => {
      const path = join(bundle, name);
      return [
        name,
        {
          sha256: sha256File(path),
          bytes: lstatSync(path).size,
          mode: (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0"),
        },
      ];
    }),
  );
  const receipt = join(bundle, "build-receipt.json");
  writeFileSync(
    receipt,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        toolchainVersion: IPHONE2G_TOOLCHAIN.toolchainVersion,
        target: IPHONE2G_TOOLCHAIN.compiler.target,
        minimumVersion: IPHONE2G_TOOLCHAIN.compiler.minimumVersion,
        sysrootRawSha256: sha256File(
          join(
            iphone2gCacheRoot(),
            "sysroot-1.1.4",
            IPHONE2G_TOOLCHAIN.firmware.rootFilesystem.rawAsset,
          ),
        ),
        sysrootFiles,
        csuRevision: IPHONE2G_TOOLCHAIN.compiler.csu.revision,
        quickJsRevision: IPHONE2G_TOOLCHAIN.compiler.quickJsRevision,
        quickJsVersion: IPHONE2G_TOOLCHAIN.compiler.quickJsVersion,
        rustToolchain: IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
        hostTools,
        buildId,
        guestJavaScriptSha256: sha256File(guestJavaScript),
        guestJavaScriptBytes: lstatSync(guestJavaScript).size,
        guestPackSha256: sha256File(guestPack),
        guestPackBytes: lstatSync(guestPack).size,
        coreLibrarySha256: sha256File(coreLibrary),
        executableSha256: sha256File(executable),
        bundleFiles,
        receiptMode: "0644",
        unsigned: true,
      },
      null,
      2,
    )}\n`,
  );
  chmodSync(receipt, 0o644);
  console.log(fileInfo);
  console.log(`PocketJS iPhone 2G: runtime bundle -> ${bundle}`);
}

const SSHD_CONFIG = `Protocol 2
HostKey /etc/ssh/ssh_host_rsa_key
PermitRootLogin yes
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys_pocketjs
StrictModes yes
PasswordAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
GatewayPorts no
X11Forwarding no
UsePrivilegeSeparation no
UseDNS no
`;

const SSHD_LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openssh.sshd</string>
  <key>Program</key>
  <string>/usr/sbin/sshd</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/sshd</string>
    <string>-i</string>
  </array>
  <key>SessionCreate</key>
  <true/>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockNodeName</key>
      <string>127.0.0.1</string>
      <key>SockServiceName</key>
      <string>ssh</string>
    </dict>
  </dict>
  <key>inetdCompatibility</key>
  <dict>
    <key>Wait</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;

function identityPath(): string {
  const explicit = process.env.POCKETJS_IPHONE2G_IDENTITY?.trim();
  return explicit
    ? resolve(explicit)
    : join(homedir(), ".ssh", "iphone2g_pocketjs");
}

function copyBootstrapFile(
  source: string,
  destination: string,
  mode: number,
): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  chmodSync(destination, mode);
}

function buildBootstrapDeviceTool(output: string, scratch: string): void {
  const status = inspectIPhone2GToolchain();
  const clang = xcrunFind("clang");
  const linker = xcrunFind(IPHONE2G_TOOLCHAIN.compiler.linker);
  if (!status.sysroot || !status.csu || !clang || !linker) {
    throw new Error(
      "PocketJS iPhone 2G: verified sysroot, Csu, clang, and ld-classic are required for the device helper",
    );
  }

  const build = join(scratch, "device-tool");
  const sdk = mustRun("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const common = [
    "-target",
    IPHONE2G_TOOLCHAIN.compiler.target,
    `-miphoneos-version-min=${IPHONE2G_TOOLCHAIN.compiler.minimumVersion}`,
    "-march=armv6",
    "-Os",
    "-fno-stack-protector",
    "-fno-builtin",
    "-fno-common",
    "-fwrapv",
    "-funsigned-char",
    "-U_FORTIFY_SOURCE",
    "-D_FORTIFY_SOURCE=0",
    "-isysroot",
    sdk,
  ];
  const compile = (
    source: string,
    destination: string,
    extra: readonly string[] = [],
  ) => {
    mustRun(clang, [...common, ...extra, "-c", source, "-o", destination]);
  };
  mkdirSync(build, { recursive: true });
  compile(join(iphone2gCsuPath(), "start.s"), join(build, "start.o"), [
    "-x",
    "assembler-with-cpp",
  ]);
  compile(join(iphone2gCsuPath(), "dyld_glue.s"), join(build, "dyld-glue.o"), [
    "-x",
    "assembler-with-cpp",
    "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header",
    "-DCRT",
  ]);
  compile(
    join(repository, "hosts/iphone2g/crt_globals.c"),
    join(build, "crt-globals.o"),
    ["-Wall", "-Wextra", "-Werror", "-Wno-incompatible-sysroot"],
  );
  compile(
    join(repository, "hosts/iphone2g/device_tool.c"),
    join(build, "device-tool.o"),
    ["-Wall", "-Wextra", "-Werror", "-Wno-incompatible-sysroot"],
  );
  mkdirSync(dirname(output), { recursive: true });
  mustRun(linker, [
    "-arch",
    "armv6",
    "-syslibroot",
    iphone2gSysrootPath(),
    "-L/usr/lib",
    "-iphoneos_version_min",
    IPHONE2G_TOOLCHAIN.compiler.minimumVersion,
    "-no_pie",
    "-no_uuid",
    "-no_function_starts",
    "-no_data_in_code_info",
    "-no_source_version",
    "-no_compact_unwind",
    "-no_adhoc_codesign",
    "-no_encryption",
    "-e",
    "start",
    "-o",
    output,
    join(build, "start.o"),
    join(build, "dyld-glue.o"),
    join(build, "crt-globals.o"),
    join(build, "device-tool.o"),
    "-lSystem",
    "-lgcc_s.1",
  ]);
  const fileInfo = mustRun("file", [output]);
  const dependencies = mustRun("xcrun", ["otool-classic", "-L", output]);
  const loadCommands = mustRun("xcrun", ["otool-classic", "-l", output]);
  if (
    !fileInfo.includes("Mach-O executable arm_v6") ||
    !dependencies.includes("/usr/lib/libSystem.B.dylib") ||
    !dependencies.includes("/usr/lib/libgcc_s.1.dylib") ||
    !loadCommands.includes("version 1.1.4")
  ) {
    throw new Error(
      "PocketJS iPhone 2G: generated device helper failed its ARMv6/1.1.4 audit",
    );
  }
  chmodSync(output, 0o755);
}

function verifyRsaKey(
  privateKey: string,
  publicKey: string,
  label: string,
): string {
  const privateText = readFileSync(privateKey, "utf8");
  const publicLines = readFileSync(publicKey, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (
    !privateText.startsWith("-----BEGIN RSA PRIVATE KEY-----") ||
    publicLines.length !== 1
  ) {
    throw new Error(`PocketJS iPhone 2G: ${label} must be one RSA PEM keypair`);
  }
  const stored = publicLines[0].trim().split(/\s+/).slice(0, 2).join(" ");
  const derived = mustRun("ssh-keygen", ["-y", "-f", privateKey])
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const fingerprint = mustRun("ssh-keygen", ["-lf", publicKey]);
  if (
    !stored.startsWith("ssh-rsa ") ||
    stored !== derived ||
    !/^2048\s/.test(fingerprint) ||
    !fingerprint.endsWith(" (RSA)")
  ) {
    throw new Error(
      `PocketJS iPhone 2G: ${label} must be a matching 2048-bit RSA keypair`,
    );
  }
  return publicLines[0].trim();
}

function prepareBootstrap(): void {
  const status = inspectIPhone2GToolchain();
  if (!status.openssh || !status.openssl) {
    throw new Error(
      "PocketJS iPhone 2G: pinned OpenSSH/OpenSSL packages are absent or corrupt",
    );
  }

  const cache = iphone2gCacheRoot();
  const packages = join(cache, "downloads/bootstrap");
  const bootstrapRoot = join(cache, "bootstrap");
  const scratch = join(bootstrapRoot, `.prepare-${process.pid}`);
  const keyRoot = join(bootstrapRoot, "keys");
  const destination = join(bootstrapRoot, "stage");
  mkdirSync(bootstrapRoot, { recursive: true, mode: 0o700 });
  chmodSync(bootstrapRoot, 0o700);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });

  try {
    for (const [name, asset] of [
      ["openssh", IPHONE2G_TOOLCHAIN.bootstrap.openssh.asset],
      ["openssl", IPHONE2G_TOOLCHAIN.bootstrap.openssl.asset],
    ] as const) {
      const archive = join(scratch, name);
      const files = join(scratch, `${name}-files`);
      mkdirSync(archive, { recursive: true });
      mkdirSync(files, { recursive: true });
      mustRun("bsdtar", ["-xf", join(packages, asset), "-C", archive]);
      mustRun("bsdtar", ["-xzf", join(archive, "data.tar.gz"), "-C", files]);
    }

    const stage = join(scratch, "stage");
    const selected: Array<readonly [string, string, number]> = [
      [
        join(scratch, "openssh-files/usr/sbin/sshd"),
        "root/usr/sbin/sshd",
        0o755,
      ],
      [
        join(scratch, "openssl-files/usr/lib/libcrypto.0.9.8.dylib"),
        "root/usr/lib/libcrypto.0.9.8.dylib",
        0o555,
      ],
      [
        join(scratch, "openssh-files/etc/ssh/moduli"),
        "root/private/etc/ssh/moduli",
        0o644,
      ],
    ];
    for (const [source, relative, mode] of selected) {
      const expected =
        IPHONE2G_TOOLCHAIN.bootstrap.files[relative.replace(/^root\//, "")];
      if (!expected || sha256File(source) !== expected) {
        throw new Error(
          `PocketJS iPhone 2G: selected bootstrap file failed verification: ${relative}`,
        );
      }
      copyBootstrapFile(source, join(stage, relative), mode);
    }
    buildBootstrapDeviceTool(
      join(stage, "root/usr/libexec/pocketjs-device"),
      scratch,
    );

    mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
    chmodSync(keyRoot, 0o700);
    const hostKey = join(keyRoot, "ssh_host_rsa_key");
    if (!existsSync(hostKey)) {
      mustRun("ssh-keygen", [
        "-q",
        "-t",
        "rsa",
        "-b",
        "2048",
        "-m",
        "PEM",
        "-N",
        "",
        "-C",
        "iphone2g-host",
        "-f",
        hostKey,
      ]);
    }
    chmodSync(hostKey, 0o600);
    const hostPublicKey = verifyRsaKey(hostKey, `${hostKey}.pub`, "host key");

    const identity = identityPath();
    if (!existsSync(identity)) {
      mkdirSync(dirname(identity), { recursive: true });
      mustRun("ssh-keygen", [
        "-q",
        "-t",
        "rsa",
        "-b",
        "2048",
        "-m",
        "PEM",
        "-N",
        "",
        "-C",
        "pocketjs-iphone2g",
        "-f",
        identity,
      ]);
    }
    chmodSync(identity, 0o600);
    const publicKey = verifyRsaKey(
      identity,
      `${identity}.pub`,
      "client identity",
    );

    copyBootstrapFile(
      hostKey,
      join(stage, "root/private/etc/ssh/ssh_host_rsa_key"),
      0o600,
    );
    writeFileSync(
      join(stage, "root/private/etc/ssh/sshd_config"),
      SSHD_CONFIG,
      { mode: 0o644 },
    );
    mkdirSync(join(stage, "root/Library/LaunchDaemons"), { recursive: true });
    writeFileSync(
      join(stage, "root/Library/LaunchDaemons/com.openssh.sshd.plist"),
      SSHD_LAUNCHD_PLIST,
      { mode: 0o644 },
    );
    mustRun("plutil", [
      "-lint",
      join(stage, "root/Library/LaunchDaemons/com.openssh.sshd.plist"),
    ]);
    mkdirSync(join(stage, "data/root/.ssh"), { recursive: true, mode: 0o700 });
    chmodSync(join(stage, "data/root/.ssh"), 0o700);
    writeFileSync(
      join(stage, "data/root/.ssh/authorized_keys_pocketjs"),
      `${publicKey}\n`,
      { mode: 0o600 },
    );

    const expectedModes: Array<readonly [string, number]> = [
      ["root/usr/sbin/sshd", 0o755],
      ["root/usr/libexec/pocketjs-device", 0o755],
      ["root/usr/lib/libcrypto.0.9.8.dylib", 0o555],
      ["root/private/etc/ssh/moduli", 0o644],
      ["root/private/etc/ssh/sshd_config", 0o644],
      ["root/private/etc/ssh/ssh_host_rsa_key", 0o600],
      ["root/Library/LaunchDaemons/com.openssh.sshd.plist", 0o644],
      ["data/root/.ssh/authorized_keys_pocketjs", 0o600],
    ];
    const files = Object.fromEntries(
      expectedModes.map(([relative, mode]) => {
        const path = join(stage, relative);
        const actualMode = lstatSync(path).mode & 0o777;
        if (actualMode !== mode) {
          throw new Error(
            `PocketJS iPhone 2G: ${relative} mode is ${actualMode.toString(8)}, expected ${mode.toString(8)}`,
          );
        }
        return [
          relative,
          { sha256: sha256File(path), mode: mode.toString(8).padStart(4, "0") },
        ];
      }),
    );

    const sshConfig = join(cache, "bootstrap/ssh_config");
    const knownHosts = join(cache, "bootstrap/known_hosts");
    const hostKeyFields = hostPublicKey.split(/\s+/).slice(0, 2).join(" ");
    writeFileSync(knownHosts, `[127.0.0.1]:2222 ${hostKeyFields}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      sshConfig,
      `Host iphone2g-pocketjs
  HostName 127.0.0.1
  Port 2222
  User root
  IdentityFile ${identity}
  IdentitiesOnly yes
  UserKnownHostsFile ${knownHosts}
  StrictHostKeyChecking yes
  HostKeyAlgorithms +ssh-rsa
  PubkeyAcceptedAlgorithms +ssh-rsa
  KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group1-sha1
  MACs +hmac-sha1
`,
    );
    chmodSync(sshConfig, 0o600);
    writeFileSync(
      join(stage, "bootstrap-receipt.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          packageSha256: {
            openssh: IPHONE2G_TOOLCHAIN.bootstrap.openssh.sha256,
            openssl: IPHONE2G_TOOLCHAIN.bootstrap.openssl.sha256,
          },
          files,
          deviceHelper: {
            sourceSha256: sha256File(
              join(repository, "hosts/iphone2g/device_tool.c"),
            ),
            protocol: "PJS2G002",
          },
          clientIdentity: identity,
          hostKeyFingerprint: mustRun("ssh-keygen", ["-lf", hostKey]),
          policy: {
            passwordAuthentication: false,
            listenAddress: "127.0.0.1",
            sftp: false,
            afc2: false,
            fstabMutation: false,
            basebandMutation: false,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    rmSync(destination, { recursive: true, force: true });
    cpSync(stage, destination, { recursive: true, preserveTimestamps: true });
    chmodSync(destination, 0o700);
    console.log(`PocketJS iPhone 2G: key-only bootstrap -> ${destination}`);
    console.log(`PocketJS iPhone 2G: dedicated SSH config -> ${sshConfig}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const DEVICE_BUNDLE_FILES = [
  "PocketJSDemo",
  "Info.plist",
  "PkgInfo",
  "Icon.png",
  "build-receipt.json",
] as const;

interface BootstrapReceipt {
  readonly schemaVersion: 1;
  readonly files: Readonly<
    Record<string, { readonly sha256: string; readonly mode: string }>
  >;
  readonly deviceHelper: {
    readonly sourceSha256: string;
    readonly protocol: "PJS2G002";
  };
  readonly policy: {
    readonly passwordAuthentication: false;
    readonly listenAddress: "127.0.0.1";
    readonly sftp: false;
    readonly afc2: false;
    readonly fstabMutation: false;
    readonly basebandMutation: false;
  };
}

function verifiedBootstrapReceipt(): BootstrapReceipt {
  const stage = join(iphone2gCacheRoot(), "bootstrap/stage");
  const receiptPath = join(stage, "bootstrap-receipt.json");
  if (!existsSync(receiptPath)) {
    throw new Error(
      "PocketJS iPhone 2G: run `bun iphone2g prepare-bootstrap` first",
    );
  }
  const receipt = JSON.parse(
    readFileSync(receiptPath, "utf8"),
  ) as BootstrapReceipt;
  const expectedFiles = [
    "root/usr/sbin/sshd",
    "root/usr/libexec/pocketjs-device",
    "root/usr/lib/libcrypto.0.9.8.dylib",
    "root/private/etc/ssh/moduli",
    "root/private/etc/ssh/sshd_config",
    "root/private/etc/ssh/ssh_host_rsa_key",
    "root/Library/LaunchDaemons/com.openssh.sshd.plist",
    "data/root/.ssh/authorized_keys_pocketjs",
  ];
  const validPolicy =
    receipt.policy?.passwordAuthentication === false &&
    receipt.policy.listenAddress === "127.0.0.1" &&
    receipt.policy.sftp === false &&
    receipt.policy.afc2 === false &&
    receipt.policy.fstabMutation === false &&
    receipt.policy.basebandMutation === false;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.deviceHelper?.protocol !== "PJS2G002" ||
    receipt.deviceHelper.sourceSha256 !==
      sha256File(join(repository, "hosts/iphone2g/device_tool.c")) ||
    !validPolicy ||
    JSON.stringify(Object.keys(receipt.files ?? {})) !==
      JSON.stringify(expectedFiles)
  ) {
    throw new Error(
      "PocketJS iPhone 2G: local bootstrap receipt is stale or violates device policy",
    );
  }
  for (const relative of expectedFiles) {
    const path = join(stage, relative);
    const expected = receipt.files[relative];
    const actualMode = existsSync(path)
      ? (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0")
      : "";
    if (
      !expected ||
      !existsSync(path) ||
      sha256File(path) !== expected.sha256 ||
      actualMode !== expected.mode
    ) {
      throw new Error(
        `PocketJS iPhone 2G: local bootstrap file is stale: ${relative}`,
      );
    }
  }
  return receipt;
}

function deviceSshConfig(): string {
  verifiedBootstrapReceipt();
  return join(iphone2gCacheRoot(), "bootstrap/ssh_config");
}

function deviceSshArgs(command: readonly string[]): string[] {
  const config = deviceSshConfig();
  if (!existsSync(config))
    throw new Error("PocketJS iPhone 2G: dedicated SSH config is absent");
  return [
    "-F",
    config,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "iphone2g-pocketjs",
    ...command,
  ];
}

function deviceCommand(
  command: readonly string[],
  input?: Uint8Array,
): BinaryCommandResult {
  return runBinary("/usr/bin/ssh", deviceSshArgs(command), input);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rootMountLine(): string | undefined {
  const mounts = deviceCommand(["/sbin/mount"]);
  if (mounts.exitCode !== 0) return undefined;
  return mounts.stdout
    .toString()
    .split(/\r?\n/)
    .find((line) => line.includes(" on / "));
}

function ensureDeviceRootReadOnly(): void {
  const state = deviceCommand(["/usr/libexec/pocketjs-device", "root-state"]);
  if (state.exitCode === 0 && state.stdout.toString() === "root_readonly=1\n")
    return;
  const remount = deviceCommand(["/sbin/mount", "-ur", "/"]);
  const verified = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "root-state",
  ]);
  if (
    remount.exitCode !== 0 ||
    verified.exitCode !== 0 ||
    verified.stdout.toString() !== "root_readonly=1\n" ||
    !rootMountLine()?.includes("read-only")
  ) {
    throw new Error(
      "PocketJS iPhone 2G: CRITICAL: device root could not be returned read-only",
    );
  }
}

function rollbackDeviceInstall(identifier: string): string | undefined {
  const rollback = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "rollback",
    identifier,
  ]);
  try {
    ensureDeviceRootReadOnly();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return rollback.exitCode === 0
    ? undefined
    : `device rollback failed (${rollback.exitCode})${rollback.stderr.trim() ? `: ${rollback.stderr.trim()}` : ""}`;
}

function recoverPendingDeviceTransaction(): void {
  const pending = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "transaction-state",
  ]);
  if (pending.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: device transaction marker is malformed or unreadable",
    );
  }
  const text = pending.stdout.toString();
  if (text === "state=none\n") return;
  const match = text.match(
    /^state=pending\nphase=([LPMIR])\nhad_previous=([01])\nid=([0-9a-f]{32})\n$/,
  );
  if (!match)
    throw new Error("PocketJS iPhone 2G: malformed pending transaction state");
  const rollback = rollbackDeviceInstall(match[3]);
  if (rollback) throw new Error(`PocketJS iPhone 2G: ${rollback}`);
  const cleared = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "transaction-state",
  ]);
  if (cleared.exitCode !== 0 || cleared.stdout.toString() !== "state=none\n") {
    throw new Error(
      "PocketJS iPhone 2G: pending transaction did not clear after rollback",
    );
  }
}

function deploymentPackage(bundle: string, identifier: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(identifier)) {
    throw new Error(
      "PocketJS iPhone 2G: invalid deployment transaction identifier",
    );
  }
  const parts: Buffer[] = [
    Buffer.from("PJS2G002", "ascii"),
    Buffer.from(identifier, "ascii"),
  ];
  for (const name of DEVICE_BUNDLE_FILES) {
    const bytes = readFileSync(join(bundle, name));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function deployDemo(): void {
  buildDemo();
  buildRuntime();
  const bundle = join(repository, "dist/iphone2g/PocketJSDemo.app");
  const receipt = verifiedBootstrapReceipt();
  const buildReceipt = JSON.parse(
    readFileSync(join(bundle, "build-receipt.json"), "utf8"),
  ) as { buildId?: string };
  if (!buildReceipt.buildId || !/^[0-9a-f]{32}$/.test(buildReceipt.buildId)) {
    throw new Error(
      "PocketJS iPhone 2G: build receipt has no valid transaction identifier",
    );
  }
  const identifier = buildReceipt.buildId;
  const remoteVersion = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "version",
  ]);
  const remoteHelper = deviceCommand(["/usr/libexec/pocketjs-device", "self"]);
  if (
    remoteHelper.exitCode !== 0 ||
    sha256Bytes(remoteHelper.stdout) !==
      receipt.files["root/usr/libexec/pocketjs-device"].sha256 ||
    remoteVersion.exitCode !== 0 ||
    remoteVersion.stdout.toString() !== "pocketjs-iphone2g-device 3\n"
  ) {
    throw new Error(
      "PocketJS iPhone 2G: installed device helper does not match the verified bootstrap",
    );
  }
  const stopPrevious = deviceCommand([
    "/bin/launchctl",
    "stop",
    "com.apple.SpringBoard",
  ]);
  if (stopPrevious.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: could not stop the previous app before deployment",
    );
  }
  recoverPendingDeviceTransaction();
  const clearStatus = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "clear-status",
  ]);
  if (clearStatus.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: could not clear the previous runtime acceptance record",
    );
  }
  const install = deviceCommand(
    ["/usr/libexec/pocketjs-device", "install"],
    deploymentPackage(bundle, identifier),
  );
  if (install.exitCode !== 0) {
    const rollback = rollbackDeviceInstall(identifier);
    throw new Error(
      `PocketJS iPhone 2G: device install failed (${install.exitCode})${install.stderr.trim() ? `:\n${install.stderr.trim()}` : ""}${rollback ? `\n${rollback}` : ""}`,
    );
  }

  try {
    for (const name of DEVICE_BUNDLE_FILES) {
      const local = readFileSync(join(bundle, name));
      const remote = deviceCommand([
        "/usr/libexec/pocketjs-device",
        "read",
        name,
      ]);
      if (
        remote.exitCode !== 0 ||
        sha256Bytes(remote.stdout) !== sha256Bytes(local)
      ) {
        throw new Error(
          `PocketJS iPhone 2G: read-back verification failed for ${name}`,
        );
      }
    }
    ensureDeviceRootReadOnly();
    const commit = deviceCommand([
      "/usr/libexec/pocketjs-device",
      "commit",
      identifier,
    ]);
    if (commit.exitCode !== 0) {
      throw new Error(
        `PocketJS iPhone 2G: device transaction commit failed (${commit.exitCode})`,
      );
    }
    ensureDeviceRootReadOnly();
  } catch (error) {
    const rollback = rollbackDeviceInstall(identifier);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${rollback ? `\n${rollback}` : ""}`);
  }
  const restart = deviceCommand([
    "/bin/launchctl",
    "stop",
    "com.apple.SpringBoard",
  ]);
  if (restart.exitCode !== 0) {
    throw new Error(
      `PocketJS iPhone 2G: app verified, but SpringBoard restart failed (${restart.exitCode})`,
    );
  }
  console.log(
    "PocketJS iPhone 2G: app installed, read back byte-exactly, and root returned read-only",
  );
  console.log(
    "PocketJS iPhone 2G: SpringBoard restarted; launch PocketJS Demo for live acceptance",
  );
}

function printDeviceStatus(): void {
  const status = deviceCommand(["/usr/libexec/pocketjs-device", "status"]);
  if (status.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: no runtime acceptance record is available; launch the app first",
    );
  }
  const text = status.stdout.toString();
  const lines = text.trim().split(/\r?\n/);
  const pairs = lines.map((line) => {
    const separator = line.indexOf("=");
    return separator >= 0
      ? [line.slice(0, separator), line.slice(separator + 1)]
      : [line, ""];
  });
  const fieldNames = pairs.map(([name]) => name);
  const expectedFields = [
    "schema",
    "build_id",
    "state",
    "guest_frames",
    "touch_sequences",
    "touch_down",
    "last_touch_x",
    "last_touch_y",
    "last_touch_hit",
    "error",
  ];
  const fields = Object.fromEntries(pairs);
  const receiptPath = join(
    repository,
    "dist/iphone2g/PocketJSDemo.app/build-receipt.json",
  );
  const receipt = existsSync(receiptPath)
    ? (JSON.parse(readFileSync(receiptPath, "utf8")) as { buildId?: string })
    : undefined;
  const countersAreValid = [
    "guest_frames",
    "touch_sequences",
    "last_touch_x",
    "last_touch_y",
    "last_touch_hit",
  ].every((name) => /^(0|[1-9][0-9]*)$/.test(fields[name] ?? ""));
  if (
    JSON.stringify(fieldNames) !== JSON.stringify(expectedFields) ||
    fields.schema !== "1" ||
    !/^[0-9a-f]{32}$/.test(fields.build_id ?? "") ||
    !receipt?.buildId ||
    fields.build_id !== receipt.buildId ||
    !countersAreValid ||
    !["0", "1"].includes(fields.touch_down) ||
    !["starting", "running", "failed", "terminated"].includes(fields.state) ||
    (fields.state !== "failed" && fields.error !== "")
  ) {
    throw new Error("PocketJS iPhone 2G: malformed runtime acceptance record");
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function usage(): never {
  console.error(
    "usage: bun tools/iphone2g.ts <doctor|setup-sources|setup-csu|prepare-bootstrap|build-demo|build-runtime|build-probe|build|deploy|device-status>",
  );
  process.exit(64);
}

try {
  if (command === "doctor") doctor();
  else if (command === "setup-csu") {
    ensureCsu();
    console.log(
      `PocketJS iPhone 2G: verified Apple Csu -> ${iphone2gCsuPath()}`,
    );
  } else if (command === "setup-sources") {
    ensureSources();
    console.log(
      `PocketJS iPhone 2G: verified Apple Csu -> ${iphone2gCsuPath()}`,
    );
    console.log(
      `PocketJS iPhone 2G: verified QuickJS -> ${iphone2gQuickJsPath()}`,
    );
    console.log(
      `PocketJS iPhone 2G: verified Legacy-iOS-Kit -> ${iphone2gLegacyKitPath()}`,
    );
  } else if (command === "build-demo") buildDemo();
  else if (command === "prepare-bootstrap") prepareBootstrap();
  else if (command === "build-runtime" || command === "build-probe") {
    buildDemo();
    buildRuntime();
  } else if (command === "build") {
    buildDemo();
    buildRuntime();
  } else if (command === "deploy") deployDemo();
  else if (command === "device-status") printDeviceStatus();
  else usage();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
