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
      "native/Cargo.toml",
      "native/Cargo.lock",
      "native-vita/Cargo.toml",
      "native-vita/Cargo.lock",
      "native-vita/assets/sce_sys/icon0.png",
      "native-vita/assets/sce_sys/livearea/contents/bg.png",
      "native-vita/assets/sce_sys/livearea/contents/startup.png",
      "native-vita/assets/sce_sys/livearea/contents/template.xml",
      "pocket3d/crates/pocket3d-vita/Cargo.toml",
      "pocket3d/crates/pocket3d-vita/Cargo.lock",
      "pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "pocket3d/crates/pocket3d-bsp/src/lib.rs",
    ]));
    expect(files).not.toContain("pocket3d/Cargo.toml");

    const bspManifest = await Bun.file(
      `${root}pocket3d/crates/pocket3d-bsp/Cargo.toml`,
    ).text();
    expect(bspManifest).not.toContain(".workspace = true");
    expect(bspManifest).not.toContain("workspace = true");
  });

  test("CLI tarball stays self-contained and minimal", () => {
    expect(packedFiles(`${root}cli`)).toEqual([
      "README.md",
      "bin.mjs",
      "package.json",
      "psp-toolchain.json",
    ]);
  });
});
