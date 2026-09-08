import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("3DS pairing adopts an existing console key and rotates only explicitly", () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "pocket-pairing-"));
  const host = `pair-test-${crypto.randomUUID()}.invalid`;
  const local = `${root}/.pocket/3ds/devices/${host}-8131.key`;
  const remote = `${scratch}/remote.key`;
  try {
    const curl = `${scratch}/curl`;
    writeFileSync(curl, `#!/usr/bin/env python3
import os,pathlib,sys
remote=pathlib.Path(os.environ['PAIR_TEST_REMOTE'])
if os.environ.get('PAIR_TEST_FAILURE'):sys.exit(7)
if '-T' in sys.argv:
 remote.write_bytes(pathlib.Path(sys.argv[sys.argv.index('-T')+1]).read_bytes())
 with open(str(remote)+'.writes','a') as f:f.write('write\\n')
elif remote.exists():sys.stdout.buffer.write(remote.read_bytes())
else:sys.exit(78)
`); chmodSync(curl, 0o700);
    const invoke = (args: string[] = [], fail = false) => Bun.spawnSync([process.execPath, `${root}/tools/3ds-dev.ts`, "pair", "--host", host, ...args], {
      env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, PAIR_TEST_REMOTE: remote, ...(fail ? { PAIR_TEST_FAILURE: "1" } : {}) }, timeout: 10000,
    });
    writeFileSync(remote, "11".repeat(32) + "\n");
    expect(invoke().exitCode).toBe(0);
    expect(readFileSync(local).equals(readFileSync(remote))).toBe(true);
    expect(existsSync(`${remote}.writes`)).toBe(false);
    expect(invoke(["--rotate"]).exitCode).toBe(0);
    expect(readFileSync(local).equals(readFileSync(remote))).toBe(true);
    expect(readFileSync(remote, "utf8")).not.toBe("11".repeat(32) + "\n");
    const preserved = readFileSync(local);
    expect(invoke([], true).exitCode).toBe(1);
    expect(readFileSync(local).equals(preserved)).toBe(true);
    rmSync(remote); expect(invoke().exitCode).toBe(0);
    expect(readFileSync(remote).equals(preserved)).toBe(true);
  } finally { rmSync(local, { force: true }); rmSync(scratch, { recursive: true, force: true }); }
});
