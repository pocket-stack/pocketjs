import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  IPHONE4S_DEV_CONTRACTS,
  IPHONE4S_DEV_HOST_ABI,
  IPHONE4S_DEV_TARGET_ID,
  IPHONE4S_LOGICAL_VIEWPORT,
  IPHONE4S_PHYSICAL_VIEWPORT,
  IPHONE4S_RASTER_DENSITY,
  resolveIPhone4SBuildPlan,
} from "../tools/iphone4s-profile.ts";
import { IPHONE4S_TOOLCHAIN } from "../tools/iphone4s-toolchain.ts";
import {
  bakeClassicIPhoneArtwork,
  IPHONE_CLASSIC_ICON_SOURCE,
} from "../tools/iphone-classic-icon.ts";
import { deploymentInstallCommand, iphone4sDeploymentPaths } from "../tools/iphone4s.ts";

const repository = join(import.meta.dir, "..");

describe("private iPhone 4S profile", () => {
  test("pins the exact Retina iOS 6 takeover surface", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(IPHONE4S_DEV_TARGET_ID);
    expect(IPHONE4S_DEV_CONTRACTS.targets[IPHONE4S_DEV_TARGET_ID]).toEqual({
      hostAbi: IPHONE4S_DEV_HOST_ABI,
      platform: "iphoneos",
      form: "takeover",
      display: {
        physicalViewport: IPHONE4S_PHYSICAL_VIEWPORT,
        logicalViewports: [IPHONE4S_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPHONE4S_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

  test("resolves the iPhone 4S Hero build plan", () => {
    const manifest = JSON.parse(readFileSync(join(repository, "apps/iphone4s-demo/pocket.json"), "utf8"));
    const plan = resolveIPhone4SBuildPlan(manifest);
    expect(plan.target).toEqual({ id: IPHONE4S_DEV_TARGET_ID, hostAbi: IPHONE4S_DEV_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: IPHONE4S_LOGICAL_VIEWPORT,
      physical: IPHONE4S_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: IPHONE4S_RASTER_DENSITY,
    });
    expect(plan.app.entry).toBe("apps/iphone4s-demo/main.tsx");
    expect(plan.app.output).toBe("iphone4s-demo-main");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("pins firmware, sysroot, toolchain, and key-only transport", () => {
    expect(IPHONE4S_TOOLCHAIN.device).toEqual({
      productType: "iPhone4,1",
      hardwareModel: "N94AP",
      productVersion: "6.1.3",
      buildVersion: "10B329",
    });
    expect(IPHONE4S_TOOLCHAIN.firmware.sha1).toHaveLength(40);
    expect(IPHONE4S_TOOLCHAIN.firmware.sharedCacheSha256).toHaveLength(64);
    expect(Object.values(IPHONE4S_TOOLCHAIN.compiler.sysrootFiles)).toHaveLength(7);
    const tool = readFileSync(join(repository, "tools/iphone4s.ts"), "utf8");
    expect(tool).toContain("verifyDeviceIdentity()");
    expect(tool).toContain('deviceValue(udid, "HardwareModel")');
    expect(tool).toContain("passwordauthentication no");
    expect(tool).toContain("dyld_shared_cache_extract_dylibs_progress");
    expect(tool).toContain("writeTextStub");
    expect(tool).toContain("POCKETJS_IPHONE4S_IPSW");
    expect(tool).toContain("byte-exact readback");
    expect(tool).toContain('"build-receipt.json": sha256(receiptPath())');
    expect(tool).toContain("/bin/su mobile -c 'touch ${CAPTURE_REQUEST_PATH}'");
  });

  test("shares the current touch-hit host and keeps transactional rollback", () => {
    const wrapper = readFileSync(join(repository, "hosts/iphone4s/runtime.c"), "utf8");
    const runtime = readFileSync(join(repository, "hosts/iphone2g/runtime.c"), "utf8");
    const guest = readFileSync(join(repository, "hosts/iphone2g/pocket_runtime.c"), "utf8");
    expect(wrapper).toContain('#include "../iphone2g/runtime.c"');
    expect(wrapper).toContain("#define POCKET_GL_DEFAULT 1");
    expect(wrapper).toContain("#define POCKET_REQUIRE_GL 1");
    expect(runtime).toContain("pocket_runtime_hit_test_bounds");
    expect(guest).toContain("hit_array");
    expect(runtime).toContain('send_void_float(g_view, "setContentScaleFactor:"');
    expect(runtime).toContain("g_gl_width != POCKET_LOGICAL_WIDTH * POCKET_RASTER_DENSITY");
    expect(runtime).not.toContain("fsync(");

    const first = iphone4sDeploymentPaths("a".repeat(24));
    const second = iphone4sDeploymentPaths("b".repeat(24));
    expect(first.stage).not.toBe(second.stage);
    expect(first.backup).not.toBe(second.backup);
    expect(first.lock).toBe(second.lock);
    const install = deploymentInstallCommand("a".repeat(24), first);
    expect(install).toContain("trap rollback EXIT HUP INT TERM");
    expect(install.lastIndexOf("uicache")).toBeLessThan(install.lastIndexOf("trap - EXIT HUP INT TERM"));
    expect(install.lastIndexOf("trap - EXIT HUP INT TERM")).toBeLessThan(install.lastIndexOf('rm -rf "$backup"'));
  });

  test("bakes the iPhone 2G icon byte-exactly and integer-scales its Retina variant", async () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-iphone4s-artwork-"));
    try {
      await bakeClassicIPhoneArtwork(output);
      expect(readFileSync(join(output, "Icon.png"))).toEqual(readFileSync(IPHONE_CLASSIC_ICON_SOURCE));

      const one = await loadImage(join(output, "Icon.png"));
      const two = await loadImage(join(output, "Icon@2x.png"));
      expect([one.width, one.height]).toEqual([59, 60]);
      expect([two.width, two.height]).toEqual([118, 120]);
      const oneCanvas = createCanvas(one.width, one.height);
      const twoCanvas = createCanvas(two.width, two.height);
      oneCanvas.getContext("2d").drawImage(one, 0, 0);
      twoCanvas.getContext("2d").drawImage(two, 0, 0);
      const onePixels = oneCanvas.getContext("2d").getImageData(0, 0, one.width, one.height).data;
      const twoPixels = twoCanvas.getContext("2d").getImageData(0, 0, two.width, two.height).data;
      const expected = new Uint8ClampedArray(twoPixels.length);
      for (let y = 0; y < two.height; y += 1) {
        for (let x = 0; x < two.width; x += 1) {
          const source = (Math.floor(y / 2) * one.width + Math.floor(x / 2)) * 4;
          const target = (y * two.width + x) * 4;
          expected.set(onePixels.subarray(source, source + 4), target);
        }
      }
      expect(twoPixels).toEqual(expected);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
