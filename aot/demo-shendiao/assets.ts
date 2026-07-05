// aot/demo-shendiao/assets.ts — tileset + sprite declarations for the 神雕
// fan demo, from the imagegen-derived (or placeholder) data.
import { defineSprite, defineTileset, type Direction } from "@pocketjs/aot";
import { SPRITES, WUXIA_PALETTE, WUXIA_TILES } from "./assets.generated.ts";

export const wuxia = defineTileset("wuxia", {
  palette: WUXIA_PALETTE,
  tiles: WUXIA_TILES,
});

function spriteOf(key: keyof typeof SPRITES, name: string) {
  const s = SPRITES[key];
  return defineSprite(name, {
    size: [16, 16],
    palette: s.palette,
    facings: s.facings as Record<Direction, string[][]>,
  });
}

// Player MUST be declared first (the runtimes render sprite id 0 as the player).
export const yangGuo = spriteOf("hero", "yang_guo");
export const xiaoLongNv = spriteOf("lady", "xiao_long_nv");
export const condor = spriteOf("condor", "condor");
export const guoJing = spriteOf("general", "guo_jing");
export const jinlun = spriteOf("monk", "jinlun");
