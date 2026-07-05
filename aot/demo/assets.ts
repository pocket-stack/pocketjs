// aot/demo/assets.ts — imagegen-backed tileset + hero sprite declarations.
// The source PNG lives under demo/imagegen and is converted to GBA 4bpp DSL
// rows by demo/imagegen/build-assets.ts.

import { defineSprite, defineTileset } from "@pocketjs/aot";
import { HERO_FACINGS, HERO_PALETTE, TOWN_PALETTE, TOWN_TILES } from "./assets.generated.ts";

export const town = defineTileset("town", {
  palette: TOWN_PALETTE,
  tiles: TOWN_TILES,
});

export const hero = defineSprite("hero", {
  size: [16, 16],
  palette: HERO_PALETTE,
  facings: HERO_FACINGS,
});
