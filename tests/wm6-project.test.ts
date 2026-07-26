import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../hosts/wm6/vs2005/", import.meta.url);

describe("Windows Mobile 6 VS2005 probe", () => {
  test("uses the Professional SDK ARMV4I smart-device platform", async () => {
    const [solution, project] = await Promise.all([
      readFile(new URL("PocketJS.WM6.sln", root), "utf8"),
      readFile(new URL("PocketJS.WM6.Probe.vcproj", root), "utf8"),
    ]);

    expect(solution).toContain("Microsoft Visual Studio Solution File, Format Version 9.00");
    expect(solution).toContain("Windows Mobile 6 Professional SDK (ARMV4I)");
    expect(project).toContain('Version="8.00"');
    expect(project).toContain('Name="Windows Mobile 6 Professional SDK (ARMV4I)"');
    expect(project).toContain("/subsystem:windowsce,5.02");
    expect(project).toContain("aygshell.lib coredll.lib");
    expect(project.match(/DisableSpecificWarnings="4201"/g)).toHaveLength(2);
    expect(project).not.toContain("Windows Mobile 6 Standard SDK");
  });

  test("keeps the probe compatible with the VC8 compiler", async () => {
    const source = await readFile(new URL("src/main.cpp", root), "utf8");

    expect(source).toContain("int WINAPI WinMain");
    expect(source).toContain("SHFullScreen");
    expect(source).toContain("WM_LBUTTONDOWN");
    expect(source).toContain("WM_KEYDOWN");
    expect(source).toContain("CreateCompatibleBitmap");
    expect(source).toContain("CreateFontIndirect");
    expect(source).not.toMatch(/\bCreateFont\s*\(/);
    expect(source).not.toMatch(/\b(auto|nullptr|constexpr|override)\b/);
  });
});
