import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function packedFiles(cwd: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  // npm <= 11 reports an array of packs; npm >= 12 keys packs by package name.
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { files: Array<{ path: string }> } | undefined;
  expect(report?.files, result.stdout.toString().slice(0, 200)).toBeDefined();
  return report!.files.map((file) => file.path);
}

function packArchive(cwd: string, destination: string): string {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--pack-destination", destination],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { filename: string } | undefined;
  expect(report?.filename).toBeDefined();
  return join(destination, report!.filename);
}

describe("published npm artifacts", () => {
  // The files map is a governed surface, not a mirror of the repo tree: an
  // entry ships ONLY when the framework runtime, the compiler, the shipped
  // tools, or a `pocket` CLI target consumes it from the tarball. Rust
  // sources ride along solely as build inputs for CLI-buildable targets
  // (psp, vita, symbian, the web/sim wasm) plus the deliberately standalone
  // Pocket3D Vita/GLES2 crates for out-of-tree native 3D apps. Platform source
  // integrations without a CLI target (e.g. the ESP32-P4 PPA backend, whose
  // ESP-IDF C component cannot ship in npm anyway) stay git-only. Adding an
  // entry here means updating this list in the same PR — deliberately.
  test("the files map stays exactly the governed surface", async () => {
    const manifest = await Bun.file(`${root}package.json`).json();
    expect(manifest.files).toEqual([
      "framework/src",
      "framework/compiler",
      "contracts/schema",
      "contracts/spec",
      "tools",
      "apps/hero/app.tsx",
      "apps/iphone2g-demo",
      "apps/iphone4s-demo",
      "apps/ipodtouch-demo",
      "apps/meizu-m8-demo",
      "apps/nsengine",
      "hosts/apple",
      "hosts/iphone2g",
      "hosts/iphone4s",
      "hosts/ipodtouch",
      "hosts/meizu-m8",
      "hosts/web",
      "docs/APPLE.md",
      "docs/IPHONE2G.md",
      "docs/IPHONE4S.md",
      "docs/IPODTOUCH.md",
      "docs/MEIZU_M8.md",
      "assets/brand",
      "assets/fonts",
      "assets/images/logo.png",
      "assets/images/spinner-00.svg",
      "assets/images/spinner-01.svg",
      "assets/images/spinner-02.svg",
      "assets/images/spinner-03.svg",
      "assets/images/spinner-04.svg",
      "assets/images/spinner-05.svg",
      "assets/images/spinner-06.svg",
      "assets/images/spinner-07.svg",
      "engine/Cargo.toml",
      "engine/Cargo.lock",
      "engine/apple/apple",
      "engine/apple/include",
      "engine/apple/src",
      "engine/apple/Cargo.toml",
      "engine/crates/pocket-db/src",
      "engine/crates/pocket-db/Cargo.toml",
      "engine/crates/pocket-fs/src",
      "engine/crates/pocket-fs/Cargo.toml",
      "engine/crates/pocket-mod/src",
      "engine/crates/pocket-mod/Cargo.toml",
      "engine/crates/pocket-net/src",
      "engine/crates/pocket-net/Cargo.toml",
      "engine/crates/pocket-ui-surface/src",
      "engine/crates/pocket-ui-surface/Cargo.toml",
      "engine/crates/pocket-ui-wgpu/src",
      "engine/crates/pocket-ui-wgpu/Cargo.toml",
      "engine/crates/pocket-vrm/src",
      "engine/crates/pocket-vrm/Cargo.toml",
      "engine/crates/pocket-widget/src",
      "engine/crates/pocket-widget/Cargo.toml",
      "engine/core/src",
      "engine/core/Cargo.toml",
      "engine/wasm/src",
      "engine/wasm/Cargo.toml",
      "engine/symbian/src",
      "engine/symbian/targets",
      "engine/symbian/Cargo.toml",
      "engine/symbian/Cargo.lock",
      "engine/symbian/rust-toolchain.toml",
      "hosts/psp/src",
      "hosts/psp/targets",
      "hosts/psp/build.rs",
      "hosts/psp/Cargo.toml",
      "hosts/psp/Cargo.lock",
      "hosts/vita/.cargo",
      "hosts/vita/assets",
      "hosts/vita/src",
      "hosts/vita/build.rs",
      "hosts/vita/Cargo.toml",
      "hosts/vita/Cargo.lock",
      "hosts/vita/README.md",
      "hosts/vita/rust-toolchain.toml",
      "hosts/symbian/probe",
      "hosts/symbian/runtime",
      "engine/pocket3d/crates/pocket3d-vita/src",
      "engine/pocket3d/crates/pocket3d-vita/examples",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-gles2/src",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.lock",
      "engine/pocket3d/crates/pocket3d/src",
      "engine/pocket3d/crates/pocket3d/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-cook/src",
      "engine/pocket3d/crates/pocket3d-cook/Cargo.toml",
      "engine/pocket3d/examples/handheld/src",
      "engine/pocket3d/examples/handheld/Cargo.toml",
      "engine/pocket3d/examples/note-widget/src",
      "engine/pocket3d/examples/note-widget/Cargo.toml",
      "engine/pocket3d/examples/uihost/src",
      "engine/pocket3d/examples/uihost/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src",
      "engine/pocket3d/crates/pocket3d-world/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-world/README.md",
      "engine/pocket3d/crates/pocket3d-world/src",
      "pocket.config.ts",
      "pocket.json",
      "tsconfig.json",
    ]);
  });

  test("framework tarball contains every locked native and standalone Pocket3D input", async () => {
    const files = packedFiles(root);
    expect(files).toEqual(expect.arrayContaining([
      "assets/brand/pocketjs-avatar-white-minimal.png",
      "apps/hero/app.tsx",
      "apps/iphone2g-demo/pocket.json",
      "apps/iphone4s-demo/pocket.json",
      "hosts/iphone2g/device_tool.c",
      "hosts/iphone2g/armv6-apple-ios.json",
      "hosts/iphone4s/armv7-apple-ios.json",
      "docs/IPHONE2G.md",
      "docs/IPHONE4S.md",
      "assets/images/logo.png",
      "assets/images/spinner-00.svg",
      "assets/images/spinner-01.svg",
      "assets/images/spinner-02.svg",
      "assets/images/spinner-03.svg",
      "assets/images/spinner-04.svg",
      "assets/images/spinner-05.svg",
      "assets/images/spinner-06.svg",
      "assets/images/spinner-07.svg",
      "hosts/psp/Cargo.toml",
      "hosts/psp/Cargo.lock",
      "hosts/vita/Cargo.toml",
      "hosts/vita/Cargo.lock",
      "hosts/vita/assets/sce_sys/icon0.png",
      "hosts/vita/assets/sce_sys/livearea/contents/bg.png",
      "hosts/vita/assets/sce_sys/livearea/contents/startup.png",
      "hosts/vita/assets/sce_sys/livearea/contents/template.xml",
      "hosts/symbian/probe/main.cpp",
      "hosts/symbian/probe/pocketjs-e7-probe.pro",
      "hosts/symbian/runtime/main.cpp",
      "hosts/symbian/runtime/pocketjs-e7-runtime.pro",
      "hosts/symbian/runtime/pocketjs_symbian_keys.h",
      "engine/symbian/Cargo.toml",
      "engine/symbian/rust-toolchain.toml",
      "engine/symbian/src/lib.rs",
      "engine/Cargo.toml",
      "engine/Cargo.lock",
      "engine/apple/Cargo.toml",
      "engine/apple/apple/PocketSurfaceView.m",
      "engine/apple/include/pocket_apple.h",
      "engine/apple/src/lib.rs",
      "engine/crates/pocket-mod/Cargo.toml",
      "engine/crates/pocket-mod/src/lib.rs",
      "engine/crates/pocket-ui-surface/Cargo.toml",
      "engine/crates/pocket-ui-surface/src/lib.rs",
      "tools/cli/symbian-toolchain.json",
      "tools/symbian/coda-usb-probe.c",
      "tools/symbian/Dockerfile.dockerignore",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-gles2/src/lib.rs",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src/lib.rs",
      "engine/pocket3d/crates/pocket3d-world/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-world/README.md",
      "engine/pocket3d/crates/pocket3d-world/src/lib.rs",
    ]));
    expect(files).not.toContain("engine/pocket3d/Cargo.toml");
    // Cargo build output must never pack: directory-wholesale crate entries
    // swallow target/ once a cargo test has run there, and cargo's hard
    // links make the registry reject the tarball outright (E415, the
    // v0.8.0 publish failure).
    expect(
      files.some((file) => /(^|\/)target\//.test(file) || file.includes(".fingerprint")),
    ).toBe(false);
    // Git-only platform integrations must not leak into the tarball.
    expect(files).not.toContain("engine/backends/esp32p4-ppa/src/lib.rs");
    expect(files.some((file) => file.startsWith("engine/backends/"))).toBe(false);
    expect(files.some((file) => file.startsWith("hosts/esp32p4/"))).toBe(false);
    expect(files).not.toContain("docs/SYMBIAN_E7.md");
    // The CLI toolchain pin still ships via the wholesale "tools" entry.
    expect(files).toContain("tools/cli/psp-toolchain.json");

    const bspManifest = await Bun.file(
      `${root}engine/pocket3d/crates/pocket3d-bsp/Cargo.toml`,
    ).text();
    expect(bspManifest).not.toContain(".workspace = true");
    expect(bspManifest).not.toContain("workspace = true");
  }, 30_000);

  test("CLI tarball stays self-contained and minimal", () => {
    expect(packedFiles(`${root}tools/cli`)).toEqual([
      "README.md",
      "bin.mjs",
      "package.json",
      "psp-toolchain.json",
      "symbian-toolchain.json",
    ]);
  });

  test("framework tarball resolves the Apple native workspace", () => {
    const scratch = mkdtempSync(join(tmpdir(), "pocketjs-npm-apple-"));
    try {
      const archive = packArchive(root, scratch);
      const extract = Bun.spawnSync({
        cmd: ["tar", "-xf", archive, "-C", scratch],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(extract.exitCode, extract.stderr.toString()).toBe(0);
      const metadata = Bun.spawnSync({
        cmd: [
          "cargo",
          "metadata",
          "--format-version=1",
          "--no-deps",
          "--manifest-path",
          join(scratch, "package/engine/Cargo.toml"),
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(metadata.exitCode, metadata.stderr.toString()).toBe(0);
      const packages = (JSON.parse(metadata.stdout.toString()) as {
        packages: Array<{ name: string }>;
      }).packages.map((entry) => entry.name);
      expect(packages).toContain("pocket-apple");
      expect(packages).toContain("pocket-mod");
      expect(packages).toContain("pocket-ui-surface");
      expect(packages).toContain("pocket3d-world");
      expect(existsSync(join(scratch, "package/engine/core/Cargo.toml"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
