import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depfile } from "../framework/compiler/build-inputs.ts";

const root = new URL("..", import.meta.url).pathname;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

describe("ESP-IDF incremental package build", () => {
  test("escapes depfile paths", () => {
    const output = depfile("/tmp/a b.pocket", ["/tmp/new #$.ts"]);
    expect(output).toContain("a\\ b.pocket:");
    expect(output).toContain("new\\ \\#$$.ts");
  });

  test("Ninja learns new imports, assets, and compiler receipts without reconfigure", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pocketjs incremental "));
    try {
      const app = join(temporary, "app"), build = join(temporary, "build"), bin = join(temporary, "bin");
      mkdirSync(app); mkdirSync(bin);
      mkdirSync(join(app, "node_modules/@pocketjs"), { recursive: true });
      symlinkSync(root, join(app, "node_modules/@pocketjs/framework"), "dir");
      for (const file of ["pocket.json", "pocket.host.json", "main.tsx"])
        cpSync(join(root, "hosts/esp-idf/examples/smoke", file), join(app, file));
      const source = (imported: boolean) =>
        'import {Text, View, Image} from "@pocketjs/framework/solid/components";\n' +
        (imported ? 'import {message} from "./new-module";\n' : 'const message="initial";\n') +
        'export default function App(){return <View class="w-full h-full"><Text class="text-base">{message}</Text><Image src="asset.svg" /></View>}';
      writeFileSync(join(app, "app.tsx"), source(false));
      const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`;
      writeFileSync(join(app, "asset.svg"), svg("#ff0000"));
      writeFileSync(join(app, "compiler-receipt.json"), '{"revision":1}\n');
      const cli = join(bin, "pocket");
      writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "tools/pocket.ts"))} "$@"\n`);
      chmodSync(cli, 0o755);
      writeFileSync(join(app, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.20)
project(incremental NONE)
include("${join(root, "hosts/esp-idf/components/pocketjs_package/project_include.cmake")}")
# Exercise the real compile helper; embedding/firmware linking is tested separately.
function(_pocketjs_package_attach target name package profile)
  add_custom_target(package ALL DEPENDS "\${package}")
endfunction()
pocketjs_compile_app(TARGET app NAME app MANIFEST "${join(app, "pocket.json")}"
  HOST_PROFILE "${join(app, "pocket.host.json")}" PROJECT_ROOT "${app}"
  COMPILER_RECEIPT "${join(app, "compiler-receipt.json")}")
`);
      const run = (args: string[]) => {
        const result = Bun.spawnSync(args, { cwd: app, env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
        return result.stdout.toString();
      };
      run(["cmake", "-S", app, "-B", build, "-G", "Ninja"]);
      const rebuild = () => expect(run(["cmake", "--build", build])).toContain("ESP-IDF package");
      rebuild();
      const output = join(build, "pocketjs/app/app.pocket");
      expect(run(["cmake", "--build", build])).not.toContain("ESP-IDF package");
      writeFileSync(join(app, "new-module.ts"), 'export const message="first new module";\n');
      writeFileSync(join(app, "app.tsx"), source(true));
      rebuild();
      const first = readFileSync(output);
      writeFileSync(join(app, "new-module.ts"), 'export const message="second new module";\n');
      rebuild();
      expect(readFileSync(output).equals(first)).toBe(false);
      const second = readFileSync(output);
      writeFileSync(join(app, "asset.svg"), svg("#0000ff"));
      rebuild();
      expect(readFileSync(output).equals(second)).toBe(false);
      writeFileSync(join(app, "compiler-receipt.json"), '{"revision":2}\n');
      rebuild();
      expect(run(["cmake", "--build", build])).not.toContain("ESP-IDF package");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 120_000);
});
