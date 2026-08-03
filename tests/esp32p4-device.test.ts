import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Esp32P4BundleArtifacts } from "../tools/esp32p4.ts";
import {
  assertSafeEsp32P4GeneratedProject,
  createEsp32P4RustEnvironment,
  ESP32P4_RUST_CFLAGS,
  ESP32P4_RUSTFLAGS,
  parseEsp32P4DeviceArgs,
  parseNulEnvironment,
  resolveEsp32P4DevicePaths,
  stageEsp32P4DeviceProject,
  validateEsp32P4FlasherArgs,
} from "../tools/esp32p4-device.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "pocketjs-esp32p4-device-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("ESP32-P4 device arguments", () => {
  test("parses build and optionally port-bound flash commands", () => {
    expect(parseEsp32P4DeviceArgs(["build", "chrome"])).toEqual({
      command: "build",
      app: "chrome",
    });
    expect(
      parseEsp32P4DeviceArgs([
        "flash",
        "apps/chrome/pocket.json",
        "--port",
        "/dev/cu.usbmodem101",
      ]),
    ).toEqual({
      command: "flash",
      app: "apps/chrome/pocket.json",
      port: "/dev/cu.usbmodem101",
    });
    expect(parseEsp32P4DeviceArgs(["flash", "chrome", "--port=/dev/cu.test"]))
      .toEqual({ command: "flash", app: "chrome", port: "/dev/cu.test" });
  });

  test("rejects incomplete, repeated, unknown, and build-only port arguments", () => {
    expect(() => parseEsp32P4DeviceArgs([])).toThrow("expected command build or flash");
    expect(() => parseEsp32P4DeviceArgs(["build"])).toThrow("requires an app");
    expect(() => parseEsp32P4DeviceArgs(["flash", "chrome", "--port"])).toThrow(
      "requires a serial device path",
    );
    expect(() =>
      parseEsp32P4DeviceArgs([
        "flash",
        "chrome",
        "--port=/dev/a",
        "--port=/dev/b",
      ])
    ).toThrow("may only be given once");
    expect(() => parseEsp32P4DeviceArgs(["flash", "chrome", "--erase"])).toThrow(
      "unknown argument",
    );
    expect(() =>
      parseEsp32P4DeviceArgs(["build", "chrome", "--port=/dev/cu.test"])
    ).toThrow("only valid with flash");
  });
});

describe("ESP32-P4 generated project", () => {
  test("uses checkout-bound deterministic output paths and guards cleanup", () => {
    const root = temporaryDirectory();
    const paths = resolveEsp32P4DevicePaths(root);
    expect(paths.projectDirectory).toBe(join(root, "dist/esp32p4/gen-waveshare-7b"));
    expect(paths.rustLibraryPath).toBe(
      join(
        root,
        "dist/esp32p4/rust-target/riscv32imafc-esp-espidf/release/" +
          "libpocketjs_esp32p4_runtime.a",
      ),
    );
    expect(() =>
      assertSafeEsp32P4GeneratedProject(paths.projectDirectory, root)
    ).not.toThrow();
    expect(() => assertSafeEsp32P4GeneratedProject(join(root, "dist"), root)).toThrow(
      "refusing to replace",
    );
  });

  test("stages the explicit template allowlist and preserves its lock bytes", () => {
    const root = temporaryDirectory();
    const paths = resolveEsp32P4DevicePaths(root);
    const templateMain = join(paths.templateDirectory, "main");
    mkdirSync(templateMain, { recursive: true });
    const rootFiles = [
      "CMakeLists.txt",
      "dependencies.lock",
      "sdkconfig.defaults",
      "partitions.csv",
    ];
    const mainFiles = [
      "CMakeLists.txt",
      "idf_component.yml",
      "pocketjs_esp32p4.c",
      "pocketjs_runtime.h",
    ];
    for (const file of rootFiles) {
      writeFileSync(join(paths.templateDirectory, file), `root:${file}\0`);
    }
    for (const file of mainFiles) writeFileSync(join(templateMain, file), `main:${file}`);
    mkdirSync(join(paths.templateDirectory, "managed_components"));
    mkdirSync(join(paths.templateDirectory, "build"));
    writeFileSync(join(paths.templateDirectory, "sdkconfig"), "ignored");

    const bundleDirectory = join(root, "dist/esp32p4");
    mkdirSync(bundleDirectory, { recursive: true });
    const javascriptPath = join(bundleDirectory, "test.js");
    const pakPath = join(bundleDirectory, "test.pak");
    writeFileSync(javascriptPath, "globalThis.test = true;");
    writeFileSync(pakPath, new Uint8Array([0, 1, 2, 255]));
    const bundle = {
      frameworkRoot: root,
      javascriptPath,
      pakPath,
    } as Esp32P4BundleArtifacts;

    stageEsp32P4DeviceProject(bundle, paths);

    expect(readdirSync(paths.projectDirectory).sort()).toEqual([
      "CMakeLists.txt",
      "dependencies.lock",
      "main",
      "partitions.csv",
      "sdkconfig.defaults",
    ]);
    expect(readdirSync(paths.mainDirectory).sort()).toEqual([
      "CMakeLists.txt",
      "app.js",
      "app.pak",
      "idf_component.yml",
      "pocketjs_esp32p4.c",
      "pocketjs_runtime.h",
    ]);
    expect(existsSync(join(paths.projectDirectory, "managed_components"))).toBe(false);
    expect(existsSync(join(paths.projectDirectory, "build"))).toBe(false);
    expect(existsSync(join(paths.projectDirectory, "sdkconfig"))).toBe(false);
    expect(readFileSync(join(paths.projectDirectory, "dependencies.lock"))).toEqual(
      readFileSync(join(paths.templateDirectory, "dependencies.lock")),
    );
  });
});

describe("ESP32-P4 cross-build environment", () => {
  test("parses sourced environments without losing equals signs", () => {
    expect(parseNulEnvironment(Buffer.from("PATH=/idf/bin:/bin\0TOKEN=a=b=c\0\0")))
      .toEqual({ PATH: "/idf/bin:/bin", TOKEN: "a=b=c" });
  });

  test("pins the target compiler ABI and static Rust relocation model", () => {
    const environment = createEsp32P4RustEnvironment(
      { PATH: "/idf/bin:/bin", KEEP: "yes" },
      {
        gccPath: "/idf/bin/riscv32-esp-elf-gcc",
        arPath: "/idf/bin/riscv32-esp-elf-ar",
        sysroot: "/idf/sysroot",
        gccInclude: "/idf/gcc/include",
        gccFixedInclude: "/idf/gcc/include-fixed",
        bindgenArguments:
          "'--target=riscv32-unknown-elf' '--sysroot=/idf/sysroot' " +
          "'-isystem' '/idf/gcc/include'",
      },
      "/tmp/rust-target",
    );
    expect(environment.KEEP).toBe("yes");
    expect(environment.CC_riscv32imafc_esp_espidf).toEndWith("riscv32-esp-elf-gcc");
    expect(environment.AR_riscv32imafc_esp_espidf).toEndWith("riscv32-esp-elf-ar");
    expect(environment.CFLAGS_riscv32imafc_esp_espidf).toBe(ESP32P4_RUST_CFLAGS);
    expect(ESP32P4_RUST_CFLAGS).toContain("-mabi=ilp32f");
    expect(ESP32P4_RUST_CFLAGS).toContain("-march=rv32imafc_zicsr_zifencei_xesppie");
    expect(ESP32P4_RUST_CFLAGS).toContain("-Wno-error=incompatible-pointer-types");
    expect(ESP32P4_RUST_CFLAGS).toContain("-fno-pic");
    expect(ESP32P4_RUST_CFLAGS).toContain("-fno-pie");
    expect(environment.CARGO_TARGET_RISCV32IMAFC_ESP_ESPIDF_RUSTFLAGS).toBe(
      ESP32P4_RUSTFLAGS,
    );
    expect(environment.BINDGEN_EXTRA_CLANG_ARGS).toContain(
      "--target=riscv32-unknown-elf",
    );
  });
});

describe("ESP32-P4 segmented flash manifest", () => {
  function validFlashFixture(): { buildDirectory: string; manifest: unknown } {
    const buildDirectory = temporaryDirectory();
    mkdirSync(join(buildDirectory, "bootloader"));
    mkdirSync(join(buildDirectory, "partition_table"));
    writeFileSync(join(buildDirectory, "bootloader/bootloader.bin"), "boot");
    writeFileSync(join(buildDirectory, "partition_table/partition-table.bin"), "parts");
    writeFileSync(join(buildDirectory, "pocketjs_esp32p4_waveshare_7b.bin"), "app");
    return {
      buildDirectory,
      manifest: {
        flash_files: {
          "0x2000": "bootloader/bootloader.bin",
          "0x8000": "partition_table/partition-table.bin",
          "0x10000": "pocketjs_esp32p4_waveshare_7b.bin",
        },
        app: {
          offset: "0x10000",
          file: "pocketjs_esp32p4_waveshare_7b.bin",
        },
      },
    };
  }

  test("accepts the generated bootloader, partition, and app segments", () => {
    const fixture = validFlashFixture();
    expect(validateEsp32P4FlasherArgs(fixture.manifest, fixture.buildDirectory))
      .toMatchObject({ appOffset: 0x10000 });
  });

  test("fails closed on raw offset zero or missing required segments", () => {
    const fixture = validFlashFixture();
    const rawZero = structuredClone(fixture.manifest) as {
      flash_files: Record<string, string>;
    };
    rawZero.flash_files["0x0"] = "pocketjs_esp32p4_waveshare_7b.bin";
    expect(() => validateEsp32P4FlasherArgs(rawZero, fixture.buildDirectory)).toThrow(
      "unsafe ESP32-P4 flash offset",
    );

    const missingBootloader = structuredClone(fixture.manifest) as {
      flash_files: Record<string, string>;
    };
    delete missingBootloader.flash_files["0x2000"];
    expect(() =>
      validateEsp32P4FlasherArgs(missingBootloader, fixture.buildDirectory)
    ).toThrow("omit required segment 0x2000");
  });
});
