import { describe, expect, test } from "bun:test";

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

describe("published npm artifacts", () => {
  // The files map is a governed surface, not a mirror of the repo tree: an
  // entry ships ONLY when the framework runtime, the compiler, the shipped
  // tools, or a `pocket` CLI target consumes it from the tarball. Rust
  // sources ride along solely as build inputs for CLI-buildable targets
  // (psp, vita, the web/sim wasm) plus the deliberately standalone Pocket3D
  // Vita crate pair for out-of-tree Vita 3D apps. Platform source
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
      "hosts/web",
      "assets/brand",
      "assets/fonts",
      "engine/core/src",
      "engine/core/Cargo.toml",
      "engine/wasm/src",
      "engine/wasm/Cargo.toml",
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
      "docs/SYMBIAN_E7.md",
      "engine/pocket3d/crates/pocket3d-vita/src",
      "engine/pocket3d/crates/pocket3d-vita/examples",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src",
      "pocket.config.ts",
      "pocket.json",
      "tsconfig.json",
    ]);
  });

  test("framework tarball contains every locked native and standalone Pocket3D Vita input", async () => {
    const files = packedFiles(root);
    expect(files).toEqual(expect.arrayContaining([
      "assets/brand/pocketjs-avatar-white-minimal.png",
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
      "docs/SYMBIAN_E7.md",
      "tools/cli/symbian-toolchain.json",
      "tools/symbian/coda-usb-probe.c",
      "tools/symbian/Dockerfile.dockerignore",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src/lib.rs",
    ]));
    expect(files).not.toContain("engine/pocket3d/Cargo.toml");
    // Git-only platform integrations must not leak into the tarball.
    expect(files).not.toContain("engine/backends/esp32p4-ppa/src/lib.rs");
    expect(files.some((file) => file.startsWith("engine/backends/"))).toBe(false);
    expect(files.some((file) => file.startsWith("hosts/esp32p4/"))).toBe(false);
    // The CLI toolchain pin still ships via the wholesale "tools" entry.
    expect(files).toContain("tools/cli/psp-toolchain.json");

    const bspManifest = await Bun.file(
      `${root}engine/pocket3d/crates/pocket3d-bsp/Cargo.toml`,
    ).text();
    expect(bspManifest).not.toContain(".workspace = true");
    expect(bspManifest).not.toContain("workspace = true");
  });

  test("CLI tarball stays self-contained and minimal", () => {
    expect(packedFiles(`${root}tools/cli`)).toEqual([
      "README.md",
      "bin.mjs",
      "package.json",
      "psp-toolchain.json",
      "symbian-toolchain.json",
    ]);
  });
});
