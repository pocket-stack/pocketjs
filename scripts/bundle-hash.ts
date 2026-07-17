// scripts/bundle-hash.ts — the build-identity hash, host side.
//
// FNV-1a 64 over the app JS bundle bytes followed by the pak bytes. The
// SAME algorithm runs in native/build.rs over the bytes it embeds into the
// PRX (spec OP.debugStats reports it back), so "which code is the device
// actually running" becomes a comparison instead of an act of faith — a
// stale embed once shipped two rounds of "verified" fixes that never ran.
//
// Keep both implementations in lockstep; the published FNV-1a test vectors
// below are asserted in test/devtools.test.ts.

import { readFileSync } from "node:fs";

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a 64 over the concatenation of `chunks`, as 16 hex digits. */
export function fnv1a64(...chunks: Uint8Array[]): string {
  let h = OFFSET;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      h ^= BigInt(chunk[i]);
      h = (h * PRIME) & MASK;
    }
  }
  return h.toString(16).padStart(16, "0");
}

/** Hash of the exact bytes native/build.rs embeds: js file, then pak file.
 *  A missing pak hashes as empty — build.rs embeds an empty pak then too. */
export function bundleHash(jsPath: string, pakPath: string): string {
  const js = readFileSync(jsPath);
  let pak: Uint8Array;
  try {
    pak = readFileSync(pakPath);
  } catch {
    pak = new Uint8Array(0);
  }
  return fnv1a64(js, pak);
}
