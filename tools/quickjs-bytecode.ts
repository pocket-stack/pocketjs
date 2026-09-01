import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const POCKETROCK_QUICKJS_REVISION =
  "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b";

export function pocketRockQjsc(repository: string): string {
  const configured = process.env.POCKETJS_QJSC;
  if (configured && existsSync(configured)) return configured;
  return join(
    repository,
    "dist/rockbox/quickjs-rs/libquickjs-sys/embed/quickjs/qjsc",
  );
}

/** Compile an IIFE script with the exact QuickJS revision embedded by
 * PocketRock and extract qjsc's generated uint8_t array. */
export function compilePocketRockBytecode(
  repository: string,
  javascriptPath: string,
  temporaryCPath: string,
): Uint8Array {
  const qjsc = pocketRockQjsc(repository);
  if (!existsSync(qjsc)) {
    throw new Error(
      "PocketRock qjsc is missing; run `bun tools/rockbox.ts bootstrap` then build qjsc",
    );
  }
  const result = Bun.spawnSync({
    cmd: [qjsc, "-c", "-s", "-N", "pocket_bytecode", "-o", temporaryCPath, javascriptPath],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`PocketRock qjsc failed (${result.exitCode})`);
  const source = readFileSync(temporaryCPath, "utf8");
  rmSync(temporaryCPath, { force: true });
  const sizeMatch = source.match(/pocket_bytecode_size\s*=\s*(\d+)\s*;/);
  const arrayMatch = source.match(/pocket_bytecode\s*\[[^\]]+\]\s*=\s*\{([\s\S]*?)\};/);
  if (!sizeMatch || !arrayMatch) throw new Error("PocketRock qjsc emitted an unknown C layout");
  const values = [...arrayMatch[1].matchAll(/0x([0-9a-fA-F]{2})/g)].map((m) =>
    Number.parseInt(m[1], 16)
  );
  const declared = Number.parseInt(sizeMatch[1], 10);
  if (values.length !== declared) {
    throw new Error(`PocketRock qjsc bytecode length mismatch (${values.length} != ${declared})`);
  }
  return Uint8Array.from(values);
}
