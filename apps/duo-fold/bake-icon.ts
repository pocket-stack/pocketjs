import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rasterizeIconSvg } from "../../tools/icon-raster.ts";

// Keep the canonical mark and fill its shell; leave everything outside transparent.
const source = readFileSync(join(import.meta.dir, "../../site/assets/favicon.svg"), "utf8")
  .replace("<svg ", '<svg width="32" height="32" ')
  .replace('  <rect width="32" height="32" rx="7" fill="#171226"/>\n', "")
  .replace('fill="none" stroke="#ffd23f"', 'fill="#171226" stroke="#ffd23f"');
for (const density of [1, 2]) {
  const canvas = await rasterizeIconSvg(source, 32 * density, 32 * density, false);
  writeFileSync(join(import.meta.dir, density === 1 ? "pocketjs-icon.png" : "pocketjs-icon@2x.png"), canvas.toBuffer("image/png"));
}
