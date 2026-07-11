// demos/nightbloom/data.ts — NIGHTBLOOM's content tables: every plant form,
// foe, wave, spell card and sprite prompt in one pure-data module. engine.ts
// folds these tables over the virtual clock; gen-assets.ts reads the same
// tables to drive the PixelLab pipeline, so a creature's stats, its art
// prompt and its committed sprite can never drift apart.
//
// The game is a vertical danmaku shooter in the Imperishable Night grammar:
// the player PILOTS one plant at the bottom of a portrait playfield, the
// horde descends from the treeline above, and CIRCLE / L / R switch the
// piloted form mid-fight. On the 480x272 landscape screen the playfield is
// the classic arcade adaptation: a portrait column in the center, HUD
// panels on both sides.
//
// No imports from the framework or solid here: this module is shared by the
// game bundle AND the bun-side asset pipeline, so it stays platform-pure.
//
// All player-facing copy is ASCII (the Inter atlas has no CJK). GLYPHS below
// pins every codepoint dynamic text can produce (numbers, marks) so the font
// baker always slots them.

export const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 .,:;!?+-x%/<>()[]'\"*=";

// ---------------------------------------------------------------------------
// Playfield geometry (480x272 screen, portrait field + side panels)
// ---------------------------------------------------------------------------

export const FIELD = {
  x0: 138,
  y0: 8,
  w: 204,
  h: 256,
} as const;

/** Side panel boxes (left: the night; right: the roster). */
export const PANEL_L = { x0: 0, w: 134 } as const;
export const PANEL_R = { x0: 346, w: 134 } as const;

/** Player spawn point and movement clamp inset. */
export const PLAYER_SPAWN = { x: FIELD.x0 + FIELD.w / 2, y: FIELD.y0 + FIELD.h - 28 };
export const PLAYER_INSET = 10;

/** Motes auto-collect when the player climbs above this line (the PoC). */
export const POC_Y = FIELD.y0 + 84;

// ---------------------------------------------------------------------------
// Ticks — the sim advances on the core's fixed 1/60 s grid, host hz agnostic
// ---------------------------------------------------------------------------

export const TPS = 60; // ticks per virtual second (spec FIXED_DT)

// ---------------------------------------------------------------------------
// Art manifest types (consumed by gen-assets.ts)
// ---------------------------------------------------------------------------

export interface ArtEntry {
  name: string;
  prompt: string;
  w: number;
  h: number;
  seed: number;
  transparent?: boolean;
  /** pixflux facing hint. Plants face east (they shoot right), foes west. */
  direction?: "north" | "south" | "east" | "west";
  /** Derive from a previous entry — evolution keeps a creature's identity. */
  initFrom?: string;
  /** init_image influence 1..999 (PixelLab default 300). */
  initStrength?: number;
  shading?: string;
  detail?: string;
}

const UNIT = 32; // unit sprites (pow2)
const SHOT = 32; // projectile sprites (pixflux minimum canvas; drawn at 16px)
const SCENE_W = 256; // scenes are 256x128 (pow2), drawn at 480x240
const SCENE_H = 128;

const PLANT_STYLE =
  "adorable kawaii chibi plant creature for a pixel art garden defense game, huge sparkling eyes, " +
  "tiny blushing cheeks, soft rounded shapes, pastel colors with a gentle night glow, " +
  "clean thick outline, single centered character, full body";
const FOE_STYLE =
  "adorable kawaii chibi yokai spirit for a pixel art night defense game, plump rounded body, " +
  "big shiny puppy eyes, tiny stubby limbs, blushing cheeks, more cute than scary, " +
  "glowing pastel accents, clean silhouette, single centered character, full body, walking";
const SHOT_STYLE = "tiny cute pixel art game projectile icon, rounded kawaii shape, soft glow, clean silhouette, centered";

// ---------------------------------------------------------------------------
// The roster — the five pilotable plant forms
// ---------------------------------------------------------------------------

export type PlantId = "primrose" | "catnip" | "sakura";

export interface SpellDef {
  name: string;
  hint: string;
  /** Cooldown in virtual seconds. */
  cooldown: number;
}

export interface PlantDef {
  id: PlantId;
  name: string;
  /** Display name of each evolution stage (index 0 = stage I). */
  stageNames: [string, string, string];
  hp: [number, number, number];
  /** Flat damage shaved off every hit taken (the defense stat). */
  armor: [number, number, number];
  /** Unfocused movement speed in px/s (focus halves it). */
  speed: number;
  /** Which way the committed ART faces at rest: 1 = right, -1 = left. The
   *  renderer mirrors with facing * artFacing so every form looks where it
   *  flies regardless of how its portrait came out of the generator. */
  artFacing: 1 | -1;
  /** Shot damage per bullet and seconds between volleys, per stage. */
  dmg: [number, number, number];
  period: [number, number, number];
  /** Streams per volley, per stage (homing orbs / bolts / petal fan width). */
  streams: [number, number, number];
  /** Sprite file per stage — full literals so the pak build collects them. */
  sprites: [string, string, string];
  /** Glow thresholds to reach stage II and stage III. */
  evolveAt: [number, number];
  /** How this form earns glow — the evolution law, shown in the codex. */
  law: string;
  spell: SpellDef;
}

export const PLANT_ORDER: PlantId[] = ["catnip", "sakura", "primrose"];

export const PLANTS: Record<PlantId, PlantDef> = {
  catnip: {
    id: "catnip",
    name: "CATNIP KIT",
    stageNames: ["CATNIP KIT", "NEKOMATA", "NINELIVES"],
    hp: [110, 140, 170],
    armor: [0, 0, 0],
    speed: 120,
    artFacing: 1,
    dmg: [7, 8, 10],
    period: [0.34, 0.3, 0.26],
    streams: [1, 2, 2],
    sprites: ["p-catnip-1.png", "p-catnip-2.png", "p-catnip-3.png"],
    evolveAt: [420, 1400],
    law: "HOMING ORBS, AND IT DANCES WITH DEATH: WIDER GRAZE, DOUBLE GLOW",
    spell: { name: "NINE LIVES", hint: "9 HOMING ORBS + CLEAR NEAR", cooldown: 18 },
  },
  sakura: {
    id: "sakura",
    name: "SAKURA SENTINEL",
    stageNames: ["SAPLING", "GUARDIAN", "PETALSTORM"],
    hp: [110, 140, 170],
    armor: [0, 1, 2],
    speed: 105,
    artFacing: -1,
    dmg: [3, 4, 5],
    period: [0.34, 0.3, 0.26],
    streams: [3, 5, 7],
    sprites: ["p-sakura-1.png", "p-sakura-2.png", "p-sakura-3.png"],
    evolveAt: [420, 1400],
    law: "SOFT PETALS, TRUE DAMAGE -- AND EVERY HIT HEALS THE MOST WOUNDED",
    spell: { name: "PETALFALL", hint: "CLEAR EVERY SHOT, SLOW ALL", cooldown: 15 },
  },
  primrose: {
    id: "primrose",
    name: "MOON PRIMROSE",
    stageNames: ["SPROUT", "FULL BLOOM", "MOONRISEN"],
    hp: [100, 125, 150],
    armor: [0, 0, 0],
    speed: 110,
    artFacing: -1,
    dmg: [14, 18, 22],
    period: [0.42, 0.38, 0.34],
    streams: [1, 1, 1],
    sprites: ["p-primrose-1.png", "p-primrose-2.png", "p-primrose-3.png"],
    evolveAt: [360, 1200],
    law: "BANANA BOOMERANGS: THREE ALOFT, CATCH THEM COMING BACK. MOTES x2",
    spell: { name: "MOONRISE", hint: "+100 GLOW TO THE WHOLE ROSTER", cooldown: 15 },
  },
};

/** Glow a collected mote grants the piloted plant (primrose doubles it). */
export const MOTE_GLOW = 8;
/** Glow per graze (a bullet brushing the hitbox without touching). */
export const GRAZE_GLOW = 2;
/** Graze radius around the hitbox, px. */
export const GRAZE_R = 11;
/** The catnip dances with death: wider graze ring, double its glow. */
export const CATNIP_GRAZE_R = 16;
export const CATNIP_GRAZE_MULT = 2;
/** Sakura's kindness: every damaging petal heals the most wounded waking
 *  form this much. */
export const SAKURA_HEAL = 1;
/** The gorilla's boomerangs: at most `max` aloft; thrown up at `throwVy`
 *  px/s (per stage), decelerating `decel` px/s^2 until they turn, then
 *  homing back at `back` px/s. Caught within `catchR` px. A banana never
 *  despawns on a hit — it cuts through and hits again on the way home,
 *  one touch per `hitCd` ticks. */
export const BANANA = {
  max: 3,
  throwVy: [240, 265, 290],
  decel: 260,
  back: 240,
  catchR: 14,
  hitCd: 18,
} as const;
/** Player hitbox radius, px (danmaku-small; SQUARE focus reveals it). */
export const HIT_R = 3;
/** Seconds of mercy invulnerability after taking a hit. */
export const HURT_INVULN = 1.8;
/** When the piloted form dies, you have this long to switch — or the night
 *  ends. The last breath is a choice. */
export const WILT_WINDOW = 1.5;
/** Seconds between form switches. */
export const SWITCH_COOLDOWN = 0.5;
/** Focus movement multiplier while SQUARE is held. */
export const FOCUS_RATE = 0.5;

// ---------------------------------------------------------------------------
// Foes
// ---------------------------------------------------------------------------

export type FoeId = "wisp" | "kasa" | "usagi" | "uta";

export interface FoeDef {
  id: FoeId;
  name: string;
  stageNames: [string, string, string];
  hp: [number, number, number];
  /** Flat reduction per non-true hit (armor). */
  armor: [number, number, number];
  /** Motes dropped on death. */
  bounty: [number, number, number];
  /** Descent/weave speed in px/s. */
  speed: [number, number, number];
  /** Seconds between volleys. */
  firePeriod: [number, number, number];
  /** Enemy bullet speed in px/s. */
  shotSpeed: [number, number, number];
  sprites: [string, string, string];
  law: string;
}

export const FOE_ORDER: FoeId[] = ["wisp", "kasa", "usagi", "uta"];

export const FOES: Record<FoeId, FoeDef> = {
  wisp: {
    id: "wisp",
    name: "LANTERN WISP",
    stageNames: ["WISP", "TWINFLAME", "PYRE WISP"],
    hp: [45, 70, 105],
    armor: [0, 0, 0],
    bounty: [2, 3, 4],
    speed: [26, 30, 34],
    firePeriod: [1.9, 1.6, 1.4],
    shotSpeed: [76, 86, 96],
    sprites: ["f-wisp-1.png", "f-wisp-2.png", "f-wisp-3.png"],
    law: "DRIFTS DOWN AND AIMS AT YOU",
  },
  kasa: {
    id: "kasa",
    name: "KASA RONIN",
    stageNames: ["KASA", "IRON KASA", "WARLORD"],
    hp: [150, 220, 300],
    armor: [4, 6, 8],
    bounty: [4, 5, 6],
    speed: [11, 12, 13],
    firePeriod: [2.2, 2.0, 1.8],
    shotSpeed: [66, 74, 82],
    sprites: ["f-kasa-1.png", "f-kasa-2.png", "f-kasa-3.png"],
    law: "ARMORED SPREADS. PETALS PIERCE",
  },
  usagi: {
    id: "usagi",
    name: "MOON RABBIT",
    stageNames: ["RABBIT", "POUNDER", "VANGUARD"],
    hp: [36, 55, 80],
    armor: [0, 0, 0],
    bounty: [2, 3, 4],
    speed: [55, 62, 70],
    firePeriod: [1.4, 1.2, 1.0],
    shotSpeed: [110, 122, 134],
    sprites: ["f-usagi-1.png", "f-usagi-2.png", "f-usagi-3.png"],
    law: "WEAVES AND SNIPES, FAST, FRAIL",
  },
  uta: {
    id: "uta",
    name: "NIGHT SPARROW",
    stageNames: ["SPARROW", "CHANTER", "DIVA"],
    hp: [80, 120, 170],
    armor: [0, 1, 2],
    bounty: [5, 6, 8],
    speed: [22, 24, 26],
    firePeriod: [2.6, 2.3, 2.0],
    shotSpeed: [58, 64, 70],
    sprites: ["f-uta-1.png", "f-uta-2.png", "f-uta-3.png"],
    law: "RINGS; HER SONG HASTENS THE REST",
  },
};

/** uta's song: other foes fire this much faster while any uta lives. */
export const UTA_HASTE = 0.75; // fire-period multiplier

// ---------------------------------------------------------------------------
// The night — phases, waves, bosses
// ---------------------------------------------------------------------------

export type PhaseId = "dusk" | "midnight" | "witching";

export interface PhaseDef {
  id: PhaseId;
  name: string;
  /** Virtual second the phase begins. */
  at: number;
  /** Foes spawned during this phase arrive at this evolution stage. */
  foeStage: 1 | 2 | 3;
  omen: string;
}

export const PHASES: PhaseDef[] = [
  { id: "dusk", name: "DUSK", at: 0, foeStage: 1, omen: "LANTERNS DRIFT DOWN FROM THE BAMBOO" },
  { id: "midnight", name: "MIDNIGHT", at: 56, foeStage: 2, omen: "THE HORDE DEEPENS WITH THE NIGHT" },
  { id: "witching", name: "WITCHING HOUR", at: 104, foeStage: 3, omen: "THE DIVA TAKES THE STAGE" },
];

export interface WaveDef {
  /** Virtual second the wave crosses the treeline. */
  at: number;
  /** Foe kinds; entry x-slots are drawn from the seeded night RNG. */
  spawn: FoeId[];
}

export const WAVES: WaveDef[] = [
  { at: 4, spawn: ["wisp", "wisp", "wisp"] },
  { at: 14, spawn: ["wisp", "wisp", "usagi"] },
  { at: 24, spawn: ["kasa", "wisp", "wisp"] },
  { at: 34, spawn: ["usagi", "usagi", "wisp", "wisp"] },
  { at: 44, spawn: ["uta", "wisp", "wisp", "wisp"] },
  { at: 56, spawn: ["wisp", "wisp", "wisp", "usagi", "usagi"] },
  { at: 66, spawn: ["kasa", "kasa", "uta"] },
  { at: 96, spawn: ["usagi", "usagi", "usagi", "wisp", "wisp"] },
  { at: 104, spawn: ["uta", "uta", "kasa"] },
];

/** The midboss crosses at this second (an IRON KASA grown monstrous). */
export const MIDBOSS_AT = 78;
/** The final boss takes the stage at this second (the NIGHT SPARROW DIVA). */
export const BOSS_AT = 116;

export interface BossPhaseDef {
  /** Spell card name, announced on the banner. */
  card: string;
  hp: number;
  /** Seconds before the card times out and the phase advances anyway. */
  timeout: number;
  /** This phase's transformation art (64x64) and its draw size in px —
   *  every card change is a visible metamorphosis. */
  sprite: string;
  size: number;
}

export interface BossDef {
  name: string;
  /** The boss's own cry — played on entry and on every transformation. */
  voice: SfxKind;
  phases: BossPhaseDef[];
}

export const MIDBOSS: BossDef = {
  name: "IRON KASA, GROWN WRONG",
  voice: "boss-umbrella",
  phases: [{ card: "UMBRELLA SIGN -- RIBS OF THE STORM", hp: 620, timeout: 30, sprite: "boss-kasa.png", size: 56 }],
};

export const BOSS: BossDef = {
  name: "THE NIGHT SPARROW DIVA",
  voice: "boss-bird",
  phases: [
    { card: "NIGHT SONG -- WANDERING CHORUS", hp: 720, timeout: 36, sprite: "boss-uta-1.png", size: 52 },
    { card: "MOCHI SIGN -- MOONFALL CANTATA", hp: 830, timeout: 36, sprite: "boss-uta-2.png", size: 58 },
    { card: "FINALE -- THE ETERNAL NIGHT", hp: 950, timeout: 44, sprite: "boss-uta-3.png", size: 66 },
  ],
};

/** Motes the bosses shed per phase broken. */
export const BOSS_PHASE_BOUNTY = 14;

export const START_GLOW = 0;

/** The night RNG seed — one night, one seed, one tape. */
export const NIGHT_SEED = 0x9e3779b9;

// ---------------------------------------------------------------------------
// Sound events — the engine EMITS these; a host-side sink (sfx.ts) renders
// them when the host has an audio device. Pure output: no sink, no sound,
// same simulation either way.
// ---------------------------------------------------------------------------

export type SfxKind =
  | "shoot"
  | "unlock"
  | "heal"
  | "stamp"
  | "boss-bird"
  | "boss-umbrella"
  | "hit"
  | "kill"
  | "hurt"
  | "wilt"
  | "graze"
  | "mote"
  | "switch"
  | "spell"
  | "evolve"
  | "bossbreak"
  | "dawn"
  | "eternal";

// ---------------------------------------------------------------------------
// Projectiles + scenes
// ---------------------------------------------------------------------------

/** Player shot art (enemy danmaku is drawn as native dots). */
export const SHOTS = {
  orb: { sprite: "shot-orb.png" },
  mochi: { sprite: "shot-mochi.png" },
  banana: { sprite: "shot-banana.png" },
} as const;

/** The piloted avatar grows with its stage, pokemon-style (px). The HITBOX
 *  does not — danmaku manners: what you dodge with is always HIT_R. */
export const AVATAR_SIZE = [22, 27, 32] as const;

export const SCENES = {
  title: "bg-title.png",
  dawn: "bg-dawn.png",
  eternal: "bg-eternal.png",
} as const;

export const MOTE_SPRITE = "mote.png";

// ---------------------------------------------------------------------------
// PixelLab manifest — every committed asset, seeded. Order matters: initFrom
// chains (stage II from I, III from II) require the base to exist first.
// ---------------------------------------------------------------------------

function plantArt(def: PlantDef, stagePrompts: [string, string, string], baseSeed: number): ArtEntry[] {
  return stagePrompts.map((p, i) => ({
    name: def.sprites[i],
    prompt: `${p}, ${PLANT_STYLE}`,
    w: UNIT,
    h: UNIT,
    seed: baseSeed + i,
    transparent: true,
    direction: "east" as const,
    ...(i > 0 ? { initFrom: def.sprites[i - 1], initStrength: 320 } : {}),
  }));
}

function foeArt(def: FoeDef, stagePrompts: [string, string, string], baseSeed: number): ArtEntry[] {
  return stagePrompts.map((p, i) => ({
    name: def.sprites[i],
    prompt: `${p}, ${FOE_STYLE}`,
    w: UNIT,
    h: UNIT,
    seed: baseSeed + i,
    transparent: true,
    direction: "west" as const,
    ...(i > 0 ? { initFrom: def.sprites[i - 1], initStrength: 320 } : {}),
  }));
}

export const ART: ArtEntry[] = [
  // --- plants (32x32, transparent, face east) -----------------------------
  // The moon primrose is a gap-moe gorilla: a mountain of muscle with the
  // sweetest little face. Custom style — the soft plant suffix would melt
  // the abs.
  {
    name: "p-primrose-1.png",
    prompt:
      "small young gorilla plant guardian cub, a muscular little body with baby six-pack abs, " +
      "tiny ultra-cute kawaii face with big sparkling eyes and blushing cheeks, " +
      "a small silver moonflower sprout on its head, pixel art game sprite, " +
      "clean thick outline, single centered character, full body",
    w: UNIT, h: UNIT, seed: 1010, transparent: true, direction: "east",
  },
  {
    name: "p-primrose-2.png",
    prompt:
      "the same gorilla grown bigger and mightier, broad shoulders, prominent carved six-pack abs " +
      "on its bare belly, flexing both arms, silver moonflower in full bloom on its head, the same tiny " +
      "adorable sparkling-eyed blushing face, pixel art game sprite, clean thick outline, full body",
    w: UNIT, h: UNIT, seed: 1011, transparent: true, direction: "east",
    initFrom: "p-primrose-1.png", initStrength: 320,
  },
  {
    name: "p-primrose-3.png",
    prompt:
      "the same gorilla fully grown huge, a bodybuilder mountain of muscle with a prominent " +
      "six-pack on its bare belly, a glowing white crescent halo behind its shoulders, radiant " +
      "moonflower crown, the same tiny sweet blushing face, pixel art game sprite, clean thick outline, full body",
    w: UNIT, h: UNIT, seed: 1012, transparent: true, direction: "east",
    initFrom: "p-primrose-2.png", initStrength: 320,
  },
  ...plantArt(PLANTS.catnip, [
    "tiny baby kitten sprout, small and round, sleek black fur with golden paws chest and ear tips, a white crescent moon mark on its forehead, leaf ears, huge adorable eyes, curled leaf tail",
    "the same black and gold cat grown into a young sleek two-tailed cat blossom, taller now, white crescent moon mark glowing on its forehead, golden bell collar, playful grin, two swishing leaf tails",
    "the same black and gold cat fully grown, a large regal spirit cat, many glowing petal tails fanned wide, a bright white full moon mark shining on its forehead, tiny golden crown, sparkling whiskers",
  ], 1030),
  ...plantArt(PLANTS.sakura, [
    "tiny baby cherry blossom sapling, small and round with a shy blushing face and big soft eyes, a few pink petals drifting",
    "the same cherry tree grown taller into a young blossom guardian, swirl of pink petals, calm smile",
    "the same tree fully grown, a great wide sakura spirit in storm bloom, petal vortex, ancient serene face",
  ], 1050),
  // --- foes (32x32, transparent, walk west) --------------------------------
  ...foeArt(FOES.wisp, [
    "floating paper lantern ghost with a tiny warm flame heart, chubby cheeks and a happy grin, soft ragged paper skirt",
    "the same lantern ghost with twin cozy flames and a bigger happy grin, gently scorched paper edges",
    "the same lantern ghost with marshmallow-soft blue-white pyre flames, wide sparkly eyes",
  ], 2010),
  ...foeArt(FOES.kasa, [
    "chubby one-eyed umbrella yokai with a happy waggling tongue, tiny straw sandals, little toy wooden blade",
    "the same umbrella yokai grown round in cute iron-ribbed armor with a little war fan, one big glowing eye",
    "the same umbrella yokai as a tiny round warlord in shiny lacquered armor, big sparkly crimson eye, two toy blades",
  ], 2020),
  ...foeArt(FOES.usagi, [
    "extra fluffy little white moon rabbit spirit hopping with a tiny mochi mallet, big round pink eyes, chubby cheeks",
    "the same fluffy moon rabbit as a little drummer-warrior, red headband, bigger mochi hammer, determined puffy face",
    "the same fluffy moon rabbit as a royal vanguard, tiny crescent banner on the back, great mallet, softly glowing fur",
  ], 2030),
  ...foeArt(FOES.uta, [
    "round little night sparrow songstress spirit holding a tiny lantern staff, beak open in a happy song, fluffy feathers",
    "the same fluffy night sparrow with a cozy feathered cloak, bright music notes swirling around",
    "the same fluffy night sparrow as a radiant little diva, soft plume crown, spiral of glowing song light, sweet face",
  ], 2040),
  // --- projectiles + mote (32x32, transparent, drawn at 16px) ---------------
  { name: "shot-orb.png", prompt: `round pink energy orb with a tiny paw print, ${SHOT_STYLE}`, w: SHOT, h: SHOT, seed: 3002, transparent: true },
  { name: "shot-mochi.png", prompt: `small round white mochi rice cake, ${SHOT_STYLE}`, w: SHOT, h: SHOT, seed: 3003, transparent: true },
  { name: "mote.png", prompt: `small silver-blue moonlight droplet, sparkling, ${SHOT_STYLE}`, w: SHOT, h: SHOT, seed: 3004, transparent: true },
  { name: "shot-banana.png", prompt: `curved ripe yellow banana, ${SHOT_STYLE}`, w: SHOT, h: SHOT, seed: 3005, transparent: true },
  {
    name: "medal.png",
    prompt:
      "ornate round golden medal with a laurel wreath rim and two red ribbon tails, " +
      "smooth empty center plaque, shiny polished gold, cute pixel art game award, " +
      "clean thick outline, single centered object",
    w: 128, h: 128, seed: 5001, transparent: true,
  },
  // --- boss transformation portraits (64x64, chained from the mob art) ------
  {
    name: "boss-kasa.png",
    prompt:
      "huge one-eyed umbrella yokai warlord grown monstrous, towering shiny lacquered armor, " +
      "storm ribs spread wide like a broken umbrella crown, one enormous glowing crimson eye, " +
      "two toy blades, adorable chubby menace, deep purple lacquer and crimson trim, " + FOE_STYLE,
    w: 64, h: 64, seed: 2050, transparent: true, direction: "south",
  },
  {
    name: "boss-uta-1.png",
    prompt:
      "the night sparrow diva on her stage: a fluffy round songstress bird in a sparkling dress, " +
      "soft plume crown, lantern staff raised, music notes swirling, warm brown feathers " +
      "with rose-pink chest, " + FOE_STYLE,
    w: 64, h: 64, seed: 2051, transparent: true, direction: "south",
  },
  {
    name: "boss-uta-2.png",
    prompt:
      "the same diva transformed mid-song: wings spread wide, radiant feather cloak flaring, " +
      "twin glowing song spirals around her, brighter plume crown, " + FOE_STYLE,
    w: 64, h: 64, seed: 2052, transparent: true, direction: "south",
    initFrom: "boss-uta-1.png", initStrength: 300,
  },
  {
    name: "boss-uta-3.png",
    prompt:
      "the same diva's final form: an ascended phoenix-like night sparrow, blazing moonlit plumage, " +
      "a glowing crescent halo crown, the eternal night swirling around her wings, " + FOE_STYLE,
    w: 64, h: 64, seed: 2053, transparent: true, direction: "south",
    initFrom: "boss-uta-2.png", initStrength: 300,
  },
  // --- scenes (256x128 opaque, drawn at 480x240) ----------------------------
  {
    name: "bg-title.png",
    prompt:
      "stone shrine in a night garden under an enormous full moon, sakura tree and bamboo grove, " +
      "fireflies, deep indigo sky, cozy dreamy soft pastel night, gentle glow, detailed pixel art",
    w: SCENE_W, h: SCENE_H, seed: 4001, shading: "detailed shading", detail: "highly detailed",
  },
  {
    name: "bg-dawn.png",
    prompt:
      "the same stone shrine garden at the first golden dawn, sun rising over the bamboo grove, " +
      "soft warm pastel light washing the grass, gentle and hopeful, detailed pixel art",
    w: SCENE_W, h: SCENE_H, seed: 4003, shading: "detailed shading", detail: "highly detailed",
    initFrom: "bg-title.png", initStrength: 300,
  },
  {
    name: "bg-eternal.png",
    prompt:
      "the same stone shrine garden under a huge ominous crimson moon, black bamboo silhouettes, " +
      "soft rose mist over the grass, storybook-spooky plum and rose palette, detailed pixel art",
    w: SCENE_W, h: SCENE_H, seed: 4004, shading: "detailed shading", detail: "highly detailed",
    initFrom: "bg-title.png", initStrength: 300,
  },
];

// ---------------------------------------------------------------------------
// Content contract — engine.validateContent() asserts this in the sim test
// ---------------------------------------------------------------------------

export function validateContent(): string[] {
  const problems: string[] = [];
  const artNames = new Set<string>();
  const pow2 = (n: number) => n >= 16 && n <= 512 && (n & (n - 1)) === 0;

  for (const a of ART) {
    if (artNames.has(a.name)) problems.push(`duplicate art entry "${a.name}"`);
    artNames.add(a.name);
    if (!pow2(a.w) || !pow2(a.h)) problems.push(`art "${a.name}" is ${a.w}x${a.h}, not pow2 16..512`);
    if (a.initFrom && !artNames.has(a.initFrom)) {
      problems.push(`art "${a.name}" initFrom "${a.initFrom}" is not defined earlier in the manifest`);
    }
  }

  for (const id of PLANT_ORDER) {
    const p = PLANTS[id];
    if (p.id !== id) problems.push(`plant "${id}" has mismatched id "${p.id}"`);
    if (!(p.evolveAt[0] < p.evolveAt[1])) problems.push(`plant "${id}" evolve thresholds not ascending`);
    if (p.speed <= 0) problems.push(`plant "${id}" has non-positive speed`);
    for (const s of p.sprites) if (!artNames.has(s)) problems.push(`plant "${id}" sprite "${s}" missing from ART`);
    for (let i = 0; i < 3; i++) {
      if (p.hp[i] <= 0 || p.dmg[i] <= 0 || p.period[i] <= 0 || p.streams[i] <= 0) {
        problems.push(`plant "${id}" stage ${i + 1} has a non-positive stat`);
      }
    }
  }

  for (const id of FOE_ORDER) {
    const f = FOES[id];
    if (f.id !== id) problems.push(`foe "${id}" has mismatched id "${f.id}"`);
    for (const s of f.sprites) if (!artNames.has(s)) problems.push(`foe "${id}" sprite "${s}" missing from ART`);
    for (let i = 0; i < 3; i++) {
      if (f.hp[i] <= 0 || f.speed[i] <= 0 || f.firePeriod[i] <= 0 || f.shotSpeed[i] <= 0) {
        problems.push(`foe "${id}" stage ${i + 1} has a non-positive stat`);
      }
    }
  }

  let prev = -1;
  for (const w of WAVES) {
    if (w.at <= prev) problems.push(`wave at ${w.at}s is not strictly after ${prev}s`);
    prev = w.at;
    if (w.at >= BOSS_AT) problems.push(`wave at ${w.at}s spawns after the boss (${BOSS_AT}s)`);
    for (const foe of w.spawn) if (!FOES[foe]) problems.push(`wave at ${w.at}s spawns unknown foe "${foe}"`);
  }

  for (let i = 1; i < PHASES.length; i++) {
    if (PHASES[i].at <= PHASES[i - 1].at) problems.push(`phase "${PHASES[i].id}" does not start after "${PHASES[i - 1].id}"`);
  }
  if (!(MIDBOSS_AT < BOSS_AT)) problems.push("midboss must arrive before the boss");
  for (const b of [MIDBOSS, BOSS]) {
    if (b.phases.length === 0) problems.push(`boss "${b.name}" has no spell cards`);
    for (const ph of b.phases) {
      if (!artNames.has(ph.sprite)) problems.push(`boss card "${ph.card}" sprite "${ph.sprite}" missing from ART`);
      if (ph.hp <= 0 || ph.timeout <= 0 || ph.size <= 0) problems.push(`boss card "${ph.card}" has a non-positive stat`);
    }
  }

  for (const key of Object.keys(SCENES) as (keyof typeof SCENES)[]) {
    if (!artNames.has(SCENES[key])) problems.push(`scene "${key}" sprite "${SCENES[key]}" missing from ART`);
  }
  if (!artNames.has(MOTE_SPRITE)) problems.push(`mote sprite missing from ART`);

  return problems;
}
