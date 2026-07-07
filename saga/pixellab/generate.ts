// saga/pixellab/generate.ts — generate every game asset through PixelLab and
// cache it under game/art/ (committed, so builds never re-bill).
//   bun pixellab/generate.ts [--force] [--only name[,name]]
//
// Then `bun pixellab/walkers.ts` turns the *_s/_n/_e stills into walker sheets
// (hero gets real 4-frame walk cycles via /animate-with-text).
//
// Prompts are deliberately franchise-neutral: machines are "vintage
// computers", no logos, no trade dress. This is an original fan tribute.

import { pixflux, balance, type PixfluxOpts } from "./client.ts";

const OUT = new URL("../game/art/", import.meta.url).pathname;

interface Spec extends Omit<PixfluxOpts, "width" | "height"> {
  name: string;
  w: number;
  h: number;
}

const PIXEL_STYLE = "clean 16-bit pixel art, limited palette, crisp pixels";
const MAP_STYLE =
  "seen directly from above like a Game Boy RPG town map, clean 16x16 tile alignment, top-down 2D RPG interior map";
const SPRITE_STYLE = "tiny pixel art RPG overworld sprite, full body head to toe, Game Boy Advance RPG overworld style";

const HERO = "young man in his early twenties, shoulder-length dark brown hair, short beard, white collared shirt, blue jeans, brown sandals";
const KID = "twelve year old boy, short dark hair, orange striped t-shirt, blue shorts, sneakers";
const DAD = "man in his fifties, short crew cut hair, plaid work shirt, gray trousers";
const WOZ = "stocky young man, dark shaggy hair, full beard, square glasses, dark green shirt, jeans";
const RESEARCHER = "man in his thirties, brown mustache, light blue button-up shirt, dark slacks";
const TEAMMATE = "young woman, dark bobbed 80s hair, red sweater, dark skirt";

export const SPECS: Spec[] = [
  // --- world maps (320x240 = 20x15 cells) --------------------------------------
  {
    name: "map_garage68",
    w: 320,
    h: 240,
    description:
      `top-down 2D RPG interior map of a 1960s American suburban garage, ${MAP_STYLE}, brown wooden plank walls forming the room border, smooth gray concrete floor, a long wooden workbench with hand tools and a vise along the top wall, a pegboard, an old sedan car parked on the right half, cardboard boxes and an oil can in a corner, a wall telephone near the top left door`,
    negative: "people, person, human, text, side view, perspective, isometric",
    view: "high top-down",
    detail: "highly detailed",
    shading: "basic shading",
    seed: 62010,
  },
  {
    name: "map_garage76",
    w: 320,
    h: 240,
    description:
      `top-down 2D RPG interior map of a 1970s American garage turned into a tiny electronics workshop, ${MAP_STYLE}, brown wooden plank walls forming the room border, gray concrete floor, two long assembly tables covered with bare green circuit boards and soldering irons, a burn-in rack of boards along one wall, stacked cardboard shipping boxes, a wall telephone near the top left door, warm work lamps`,
    negative: "people, person, human, car, text, side view, perspective, isometric",
    view: "high top-down",
    detail: "highly detailed",
    shading: "basic shading",
    seed: 62011,
  },
  {
    name: "map_parc",
    w: 320,
    h: 240,
    description:
      `top-down 2D RPG interior map of a 1970s corporate research laboratory, ${MAP_STYLE}, clean beige walls, light gray carpet floor, several white desks in an open plan, on one central desk a tall white computer with a vertical portrait monitor and a small box mouse on a pad, bookshelves along the top wall, a beanbag corner, potted plants`,
    negative: "people, person, human, text, side view, perspective, isometric",
    view: "high top-down",
    detail: "highly detailed",
    shading: "basic shading",
    seed: 62012,
  },
  {
    name: "map_bandley",
    w: 320,
    h: 240,
    description:
      `top-down 2D RPG interior map of an early 1980s open-plan software office, ${MAP_STYLE}, white walls, blue-gray carpet, desks with small beige computers and keyboards, a whiteboard on the top wall, a couch and coffee table corner with a rubber plant, pizza boxes on one desk, a tall flag pole in one corner`,
    negative: "people, person, human, text, side view, perspective, isometric",
    view: "high top-down",
    detail: "highly detailed",
    shading: "basic shading",
    seed: 62013,
  },

  // --- cinematic backgrounds (240x160, side view) --------------------------------
  {
    name: "bg_title",
    w: 240,
    h: 160,
    description:
      `quiet California suburban street at dusk, side view: a modest ranch house with its garage door half open and glowing warm from inside, silhouetted fruit trees, purple-orange sky, first stars, ${PIXEL_STYLE}`,
    negative: "people, text, letters, logo",
    view: "side",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62020,
  },
  {
    name: "bg_dorm",
    w: 240,
    h: 160,
    description:
      `1971 college dorm room at night, side view: a narrow bed, a wooden desk crowded with electronic parts, a soldering iron, loose wires and a small blue metal box, one desk lamp, a rotary phone on the wall, posters, ${PIXEL_STYLE}`,
    negative: "people, text, letters",
    view: "side",
    shading: "medium shading",
    detail: "highly detailed",
    seed: 62021,
  },
  {
    name: "bg_reed",
    w: 240,
    h: 160,
    description:
      `sunlit college calligraphy classroom, side view: tall windows with dust motes, wooden drafting desks with ink pots and wide paper sheets showing flowing black pen strokes, a blackboard with elegant swash strokes drawn in chalk, warm morning light, ${PIXEL_STYLE}`,
    negative: "people, readable words, letters, text",
    view: "side",
    shading: "medium shading",
    detail: "highly detailed",
    seed: 62022,
  },
  {
    name: "bg_atari",
    w: 240,
    h: 160,
    description:
      `1970s video game company workshop at night, side view: a row of dark arcade cabinets along the back wall, a workbench with an oscilloscope and circuit boards, one bright desk lamp pool of light, dark blue shadows, ${PIXEL_STYLE}`,
    negative: "people, text, letters, screens with images",
    view: "side",
    shading: "medium shading",
    detail: "highly detailed",
    seed: 62023,
  },
  {
    name: "bg_faire",
    w: 240,
    h: 160,
    description:
      `1977 computer trade show hall, side view: a convention booth with a clean beige home computer with integrated keyboard on a draped table, colorful pennant banners overhead, crowd barriers, bright show lighting, ${PIXEL_STYLE}`,
    negative: "people, text, letters, logo",
    view: "side",
    shading: "medium shading",
    detail: "highly detailed",
    seed: 62024,
  },
  {
    name: "bg_penthouse",
    w: 240,
    h: 160,
    description:
      `Manhattan penthouse balcony at dusk, side view: stone balustrade in the foreground, vast city skyline with lit windows below, hazy orange-to-blue gradient sky, two empty chairs and a small table with glasses, ${PIXEL_STYLE}`,
    negative: "people, text, letters",
    view: "side",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62025,
  },
  {
    name: "bg_stage84",
    w: 240,
    h: 160,
    description:
      `dark auditorium stage, side view: one strong spotlight cone on a small table at center stage with a canvas bag on it, huge dark projection screen behind, front rows of audience as black silhouettes, deep blue darkness, ${PIXEL_STYLE}`,
    negative: "text, letters, faces",
    view: "side",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62026,
  },
  {
    name: "bg_orchard",
    w: 240,
    h: 160,
    description:
      `rolling green orchard hills at sunrise, side view: rows of small fruit trees on soft hills, morning mist in the valley, pale gold sky with a rising sun, one dirt path, ${PIXEL_STYLE}`,
    negative: "people, text, letters",
    view: "side",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62027,
  },

  // --- walker stills (32x32; sheets assembled by pixellab/walkers.ts) -----------
  ...(
    [
      ["hero", HERO, 62030],
      ["kid", KID, 62233],
      ["dad", DAD, 62036],
      ["woz", WOZ, 62039],
      ["res", RESEARCHER, 62042],
      ["team", TEAMMATE, 62045],
    ] as const
  ).flatMap(([who, look, seed]): Spec[] => [
    {
      name: `walk_${who}_s`,
      w: 32,
      h: 32,
      description: `${SPRITE_STYLE} of a ${look}, standing still, arms at sides, facing the viewer`,
      negative: "portrait, bust, cropped, text",
      view: "low top-down",
      direction: "south",
      noBackground: true,
      outline: "single color black outline",
      shading: "flat shading",
      seed,
    },
    {
      name: `walk_${who}_n`,
      w: 32,
      h: 32,
      description: `${SPRITE_STYLE} of a ${look}, standing still, seen from behind`,
      negative: "portrait, bust, cropped, text, face",
      view: "low top-down",
      direction: "north",
      noBackground: true,
      outline: "single color black outline",
      shading: "flat shading",
      seed: seed + 1,
    },
    {
      name: `walk_${who}_e`,
      w: 32,
      h: 32,
      description: `${SPRITE_STYLE} of a ${look}, standing still, side profile facing right`,
      negative: "portrait, bust, cropped, text",
      view: "low top-down",
      direction: "east",
      noBackground: true,
      outline: "single color black outline",
      shading: "flat shading",
      seed: seed + 2,
    },
  ]),

  // --- encounter portraits (64x64) ------------------------------------------------
  {
    name: "port_sculley",
    w: 64,
    h: 64,
    description:
      `pixel art bust portrait of a confident American executive in his mid forties, neat side-parted light brown hair, navy suit, striped tie, slight guarded smile, plain dark background, ${PIXEL_STYLE}`,
    negative: "text, letters, full body",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62050,
  },
  {
    name: "port_supplier",
    w: 64,
    h: 64,
    description:
      `pixel art bust portrait of a skeptical older parts salesman, balding with gray temples, thick glasses, short-sleeve white shirt with a pen in the pocket, plain dark background, ${PIXEL_STYLE}`,
    negative: "text, letters, full body",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62051,
  },
  {
    name: "port_hero",
    w: 64,
    h: 64,
    description:
      `pixel art bust portrait of a ${HERO}, intense dark eyes, faint smile, plain dark background, ${PIXEL_STYLE}`,
    negative: "text, letters, full body",
    shading: "detailed shading",
    detail: "highly detailed",
    seed: 62052,
  },

  // --- props (OBJ sprites) --------------------------------------------------------
  {
    name: "spr_bluebox",
    w: 32,
    h: 32,
    description: `one small handheld blue metal electronic box with a white keypad of round buttons, top-down slight angle, transparent background, ${PIXEL_STYLE}`,
    negative: "text, letters",
    noBackground: true,
    outline: "single color black outline",
    shading: "basic shading",
    seed: 62060,
  },
  {
    name: "spr_board",
    w: 32,
    h: 32,
    description: `one bare green computer circuit board with rows of black chips and golden traces, slight angle, transparent background, ${PIXEL_STYLE}`,
    negative: "text, letters",
    noBackground: true,
    outline: "single color black outline",
    shading: "basic shading",
    seed: 62061,
  },
  {
    name: "spr_alto",
    w: 32,
    h: 32,
    description: `one 1970s white research computer with a tall vertical portrait monitor and a small keyboard, front view, transparent background, ${PIXEL_STYLE}`,
    negative: "text, letters",
    noBackground: true,
    outline: "single color black outline",
    shading: "basic shading",
    seed: 62062,
  },
  {
    name: "spr_mac",
    w: 32,
    h: 32,
    description: `one small friendly beige all-in-one computer, compact vertical case with a small built-in screen glowing soft white and a detached keyboard in front, front view, transparent background, ${PIXEL_STYLE}`,
    negative: "text, letters, logo",
    noBackground: true,
    outline: "single color black outline",
    shading: "basic shading",
    seed: 62063,
  },
  {
    name: "spr_flag",
    w: 32,
    h: 32,
    description: `one black pirate flag with a white skull, waving on a short pole, transparent background, ${PIXEL_STYLE}`,
    negative: "text, letters, arrow, sign",
    noBackground: true,
    outline: "single color black outline",
    shading: "basic shading",
    seed: 62064,
  },
  {
    name: "spr_phone",
    w: 32,
    h: 32,
    description: `one 1960s black rotary desk telephone with a coiled cord, slight angle, transparent background, ${PIXEL_STYLE}`,
    negative: "text, letters",
    noBackground: true,
    outline: "single color black outline",
    shading: "basic shading",
    seed: 62065,
  },
];

if (import.meta.main) {
  const force = process.argv.includes("--force");
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;

  console.log("pixellab balance:", await balance());
  const manifest: Record<string, { prompt: string; seed?: number; w: number; h: number }> = {};
  const manifestPath = OUT + "manifest.json";
  try {
    Object.assign(manifest, JSON.parse(await Bun.file(manifestPath).text()));
  } catch {}

  for (const spec of SPECS) {
    const { name, w, h, ...opts } = spec;
    if (only && !only.has(name)) continue;
    const out = OUT + name + ".png";
    if (!force && (await Bun.file(out).exists())) {
      console.log(`  skip ${name} (cached)`);
      continue;
    }
    process.stdout.write(`  gen ${name} ${w}x${h}... `);
    const png = await pixflux({ ...opts, width: w, height: h });
    await Bun.write(out, png);
    manifest[name] = { prompt: spec.description, seed: spec.seed, w, h };
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`ok (${png.length}B)`);
  }
  console.log("done. balance:", await balance());
}
