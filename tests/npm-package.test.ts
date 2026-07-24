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
      "hosts/native/ffi.rs",
      "hosts/native/pak.rs",
      "hosts/switch/Makefile",
      "hosts/switch/Cargo.toml",
      "hosts/switch/Cargo.lock",
      "hosts/switch/source/main.c",
      "hosts/switch/src/lib.rs",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src/lib.rs",
    ]));
    expect(files).not.toContain("engine/pocket3d/Cargo.toml");

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
    ]);
  });
});
