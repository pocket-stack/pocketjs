import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../framework/src/styles.generated.ts", import.meta.url));
if (!existsSync(path)) {
  await Bun.write(path, [
    "export const STYLE_IDS: Record<string, number> = {};",
    "export const STYLE_COUNT = 0;",
    "export const FONT_SLOTS: Record<number, { px: number; bold: boolean }> = {};",
    "export const DEFAULT_FONT_SLOT = 2;",
    "",
  ].join("\n"));
}
