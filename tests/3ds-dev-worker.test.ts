import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("3DS development IO cannot stall the UI or overwrite the accepted generation", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pocket-dev-worker-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const fixture = `${root}/tests/fixtures/3ds-dev-worker`;
    const flags = ["-std=c11", "-O1", "-pthread", "-fsanitize=address,undefined", "-D_POSIX_C_SOURCE=200809L",
      '-DPOCKETJS_TARGET_ID="3ds-dev"', '-DPOCKETJS_RUNTIME_SLOT="0123456789abcdef"', "-DPOCKETJS_HOST_ABI=8",
      `-I${fixture}`, `-I${root}/hosts/3ds/src`, `-I${root}/hosts/3ds/include`];
    const storage = Bun.spawnSync(["cc", ...flags, "-Dfsync=test_fsync", "-include", `${fixture}/io.h`, "-c",
      `${root}/hosts/3ds/src/runtime.c`, "-o", `${scratch}/runtime.o`]);
    expect(storage.exitCode, storage.stderr.toString()).toBe(0);
    const compile = Bun.spawnSync(["cc", ...flags, `${fixture}/harness.c`, `${root}/hosts/3ds/src/devserver.c`,
      `${scratch}/runtime.o`, "-o", `${scratch}/worker`]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([`${scratch}/worker`, scratch], { timeout: 15000 });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain("worker admission, commit, rejection, recovery, bounded queues and epochs verified");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 20000);


test("3DS development transport bounds its stack and retains install/screenshot ownership", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pocket-dev-transport-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const fixture = `${root}/tests/fixtures/3ds-dev-worker`;
    const compile = Bun.spawnSync(["cc", "-std=c11", "-O1", "-pthread", "-fsanitize=address,undefined",
      "-D_DEFAULT_SOURCE", "-Wframe-larger-than=8192", "-Werror",
      '-DPOCKETJS_TARGET_ID="3ds-dev"', '-DPOCKETJS_RUNTIME_SLOT="0123456789abcdef"', "-DPOCKETJS_HOST_ABI=8",
      `-I${fixture}`, `-I${root}/hosts/3ds/src`, `-I${root}/hosts/3ds/include`,
      `${fixture}/transport.c`, `${root}/hosts/3ds/src/dev_protocol.c`, "-o", `${scratch}/transport`]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([`${scratch}/transport`, scratch], { timeout: 5000 });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain("retained receipts and borrowed screenshots verified");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
