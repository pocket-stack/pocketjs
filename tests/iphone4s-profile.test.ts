import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  IPHONE_CLASSIC_ICON_FILE,
  IPHONE_CLASSIC_ICON_SOURCE,
  IPHONE_CLASSIC_RETINA_ICON_FILE,
} from "../tools/iphone-classic-icon.ts";
import {
  buildReceiptsMatch,
  deploymentAcquireLockCommand,
  deploymentInstallCommand,
  deploymentRenewLockCommand,
  iphone4sDeploymentPaths,
} from "../tools/iphone4s.ts";

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
    expect(tool).toContain('label: "native/runtime.build-id-input.o"');
    expect(tool).toContain('label: "native/pocket_runtime.o"');
    expect(tool).toContain("...quickJsObjects.map");
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
    expect(guest).toContain("#define POCKET_RASTER_DENSITY 1");
    expect(guest).toContain("ui_init(POCKET_RASTER_DENSITY)");
    expect(readFileSync(join(repository, "tools/iphone4s.ts"), "utf8").match(
      /`-DPOCKET_RASTER_DENSITY=\$\{inputs\.viewport\.rasterDensity\}`/g,
    )).toHaveLength(2);

    const first = iphone4sDeploymentPaths("a".repeat(24));
    const second = iphone4sDeploymentPaths("b".repeat(24));
    expect(first.stage).not.toBe(second.stage);
    expect(first.backup).not.toBe(second.backup);
    expect(first.lock).toBe(second.lock);
    const install = deploymentInstallCommand("a".repeat(24), first);
    expect(install).toContain("trap rollback EXIT HUP INT TERM");
    expect(install).toContain("prepared > \"$lock/phase\"");
    expect(install).toContain("previous > \"$lock/origin\"");
    expect(install).toContain("committed > \"$lock/phase\"");
    expect(install.lastIndexOf("uicache")).toBeLessThan(install.lastIndexOf("trap - EXIT HUP INT TERM"));
    expect(install.lastIndexOf("trap - EXIT HUP INT TERM")).toBeLessThan(install.lastIndexOf('rm -rf "$backup"'));

    const acquire = deploymentAcquireLockCommand("a".repeat(24), first, 1_000, 1_600);
    expect(acquire).toContain('lease=$(cat "$lock/expires"');
    expect(acquire).toContain('[ "$lease" -gt "$now" ]');
    expect(acquire).toContain('reclaim=$lock/reclaim');
    expect(acquire).toContain('reclaim_lease=$(cat "$reclaim/expires"');
    expect(acquire).toContain('mkdir "$reclaim"');
    expect(acquire).toContain('case "$owner" in *[!0-9a-f]*)');
    expect(acquire).toContain('[ "$phase" = committed ]');
    expect(acquire).toContain('mv "$backup" "$dest"');
    expect(acquire).toContain('[ "$origin" = empty ]');
    expect(() => deploymentAcquireLockCommand("a".repeat(24), first, 1_000, 1_000)).toThrow();
    const renew = deploymentRenewLockCommand("a".repeat(24), first, 2_000);
    expect(renew).toContain('test "$(cat "$lock/owner")" = "$tx"');
    expect(renew).toContain('> "$lock/expires"');
  });

  test("compares the complete installed receipt rather than only its build ID", () => {
    const receipt = {
      schema: 1 as const,
      buildId: "a".repeat(32),
      bundleId: "dev.pocket-stack.iphone4s-demo",
      target: "iphone4s-dev",
      hostAbi: 5,
      deploymentTarget: "6.0",
      files: { "PocketJSiPhone4S": "1".repeat(64), "Info.plist": "2".repeat(64) },
    };
    expect(buildReceiptsMatch(receipt, {
      ...receipt,
      files: { "Info.plist": "2".repeat(64), "PocketJSiPhone4S": "1".repeat(64) },
    })).toBe(true);
    expect(buildReceiptsMatch(receipt, {
      ...receipt,
      files: { ...receipt.files, "PocketJSiPhone4S": "3".repeat(64) },
    })).toBe(false);
  });

  test("leases the deployment lock and reclaims incomplete or expired owners", () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-iphone4s-lock-"));
    const lock = join(output, "deploy.lock");
    const paths = { ...iphone4sDeploymentPaths("a".repeat(24)), lock };
    const runShell = (command: string) => Bun.spawnSync({
      cmd: ["/bin/sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const first = runShell(deploymentAcquireLockCommand("a".repeat(24), paths, 1_000, 1_600));
      expect(first.exitCode).toBe(0);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("a".repeat(24));
      expect(readFileSync(join(lock, "expires"), "utf8").trim()).toBe("1600");

      const active = runShell(deploymentAcquireLockCommand("b".repeat(24), paths, 1_100, 1_700));
      expect(active.exitCode).toBe(73);
      expect(active.stderr.toString()).toContain("deployment busy");

      writeFileSync(join(lock, "owner"), "legacy-incomplete\n");
      writeFileSync(join(lock, "expires"), "0\n");
      const recovered = runShell(deploymentAcquireLockCommand("b".repeat(24), paths, 2_000, 2_600));
      expect(recovered.exitCode).toBe(0);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("b".repeat(24));

      writeFileSync(join(lock, "expires"), "0\n");
      const reclaim = join(lock, "reclaim");
      mkdirSync(reclaim);
      writeFileSync(join(reclaim, "owner"), "interrupted-recovery\n");
      writeFileSync(join(reclaim, "expires"), "0\n");
      const reclaimRecovered = runShell(
        deploymentAcquireLockCommand("c".repeat(24), paths, 3_000, 3_600),
      );
      expect(reclaimRecovered.exitCode).toBe(0);
      expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("c".repeat(24));
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("keeps the iPhone 2G icon byte-exact and independently rasterizes its Retina reconstruction", async () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-iphone4s-artwork-"));
    try {
      await bakeClassicIPhoneArtwork(output);
      expect(readFileSync(join(output, IPHONE_CLASSIC_ICON_FILE))).toEqual(readFileSync(IPHONE_CLASSIC_ICON_SOURCE));

      const one = await loadImage(join(output, IPHONE_CLASSIC_ICON_FILE));
      const two = await loadImage(join(output, IPHONE_CLASSIC_RETINA_ICON_FILE));
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
      expect(twoPixels).not.toEqual(expected);
      let antialiasedAlphaPixels = 0;
      for (let index = 3; index < twoPixels.length; index += 4) {
        if (twoPixels[index] > 0 && twoPixels[index] < 255) antialiasedAlphaPixels += 1;
      }
      expect(antialiasedAlphaPixels).toBeGreaterThan(100);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
