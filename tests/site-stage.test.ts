import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSingleLodStagePackage } from "../site/stage-package.ts";
import { BTN, PocketHost } from "../site/playground/host.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGE = ROOT + "engine/pocket3d/examples/handheld/assets/dibad-psp/";

function glbJson(path: string): any {
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
  let offset = 12;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)).trim());
    }
    offset += 8 + length;
  }
  throw new Error("GLB has no JSON chunk");
}

test("homepage Stage package has one semantic screen and its declared suppression", () => {
  const profile = JSON.parse(readFileSync(PACKAGE + "profile.json", "utf8"));
  const gltf = glbJson(PACKAGE + profile.lods.orbit);
  type Material = { name?: string; extras?: Record<string, unknown> };
  const materials = gltf.materials as Material[];
  const primitiveMaterials: Material[] = gltf.meshes.flatMap((mesh: any) =>
    mesh.primitives.map((primitive: any) => materials[primitive.material]),
  );

  const screens = primitiveMaterials.filter((material) =>
    material.extras?.pocket3d_role === profile.screen.material_role ||
    material.name?.startsWith(profile.screen.material_name_prefix),
  );
  expect(screens).toHaveLength(profile.screen.expected_primitives);

  for (const entry of profile.suppressed_materials) {
    const matches = primitiveMaterials.filter((material) =>
      material.extras?.pocket3d_role === entry.material_role ||
      material.name?.startsWith(entry.material_name_prefix),
    );
    expect(matches).toHaveLength(entry.expected_primitives);
  }
});

test("homepage declares the live settings stage and visible model attribution", () => {
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  expect(home).toContain("data-pocket-stage");
  expect(home).toContain("The live Pocket Launcher");
  expect(home).toContain("Dibad");
  expect(home).toContain("creativecommons.org/licenses/by/4.0");
  expect(home).not.toContain("Drag to orbit");
  expect(home).not.toContain("lp-stage__hint");

  const homeCss = readFileSync(ROOT + "site/assets/home.css", "utf8");
  const viewportCss = homeCss.match(/\.lp-stage__viewport \{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(viewportCss).toContain("background: transparent");
  expect(viewportCss).not.toContain("border:");
  expect(viewportCss).not.toContain("box-shadow:");
  expect(viewportCss).not.toContain("backdrop-filter:");
  expect(homeCss).not.toContain(".lp-stage__viewport::before");

  // The stage ships the Pocket Launcher family as .pocket packages
  // (docs/LAUNCHER.md / docs/PLATFORM.md) — the deploy chain must build and copy them.
  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).toContain("dist/launcher-registry.json");
  expect(build).toContain('copy(source, `stage/apps/${output}.pocket`)');
  expect(build).toContain("emitSingleLodStagePackage");

  const adapter = readFileSync(ROOT + "site/assets/pocket-stage-web.js", "utf8");
  expect(adapter).toContain("profile.lods.orbit");
  expect(adapter).toContain("decodePocketPackage");

  const siteBuild = readFileSync(ROOT + "tools/site-build.ts", "utf8");
  expect(siteBuild).toContain('run("tools/launcher.ts", "pack")');
  expect(siteBuild).toContain('run("tools/build.ts", "hero")');

  for (const workflow of ["deploy.yml", "release.yml"]) {
    const source = readFileSync(ROOT + ".github/workflows/" + workflow, "utf8");
    expect(source).toContain("bun run site:build");
  }
});

test("single-LOD web package rewrites every profile reference to a copied asset", () => {
  const output = mkdtempSync(join(tmpdir(), "pocketjs-stage-"));
  try {
    const profile = emitSingleLodStagePackage(PACKAGE, output, "psp-profile.json", "orbit");
    const lods = new Set(Object.values(profile.lods));
    expect(lods).toEqual(new Set(["psp_lod3_eco.glb"]));
    for (const file of lods) expect(existsSync(join(output, file))).toBe(true);
    expect(existsSync(join(output, profile.attribution))).toBe(true);
    expect(readdirSync(output).filter((file) => file.endsWith(".glb"))).toHaveLength(1);

    const emitted = JSON.parse(readFileSync(join(output, "psp-profile.json"), "utf8"));
    expect(emitted.lods).toEqual(profile.lods);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a fast button tap is released only after one guest turn observes it", () => {
  const host = new PocketHost();
  const seen: number[] = [];
  host.wasm = { tick() {}, drawHash: () => 0n };
  host.frameCb = (buttons: number) => seen.push(buttons);
  // Keep wake() from scheduling a real browser RAF in this deterministic test.
  host.rafId = 1;

  host.press(BTN.CIRCLE, true);
  const downTick = host.tickCount;
  host.afterNextTick(() => host.press(BTN.CIRCLE, false));
  expect(host.tickCount).toBe(downTick);
  expect(host.held & BTN.CIRCLE).toBe(BTN.CIRCLE);

  host._safeFrame();
  expect(seen).toEqual([BTN.CIRCLE]);
  expect(host.held & BTN.CIRCLE).toBe(0);

  host._safeFrame();
  expect(seen).toEqual([BTN.CIRCLE, 0]);
  host.rafId = 0;
});
