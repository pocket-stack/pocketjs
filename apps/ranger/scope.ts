// apps/ranger/scope.ts — M0 evidence-based scene scope for the OO Ranger port.
//
// Hand-written: humans own the meaning. Values derive from the M0 static
// scan (tools/ranger-cook/scan.ts over the operator-supplied SWF; compact
// facts in apps/ranger/m0-inventory.json). Source references below are
// `swf:<tag>#<id> frame <n>` IDs only — no decompiler output is copied here.
//
// Reading guide (evidence -> decision):
// - Root shell is 19 frames with NO frame labels (scan: rootLabels []).
//   f2-f3 boot/init, f7/f9/f19 hit-slot screens, f11 key-config screen
//   (k00-k31/kasoru* slots), f13, f15 story-event dispatch
//   (event101-104/se_101 "bgm" refs), f17.
// - Fighters share one 9-label pose skeleton (tati/aruki/age/sage/zuza/
//   ga-do/yarare/combo/sp at parent frames 1/6/11/16/21/26/31/36/46;
//   scan: spriteLabels, 16 sprites x 9). This matches the port's POSE map.
// - Combat dispatch observed: 86 PlaceObject2 ClipActions blocks —
//   Load/init (41), EnterFrame per-frame loop incl. Key.isDown/hitTest
//   polling (50), MouseDown incl. key-config UI (26), KeyDown remap
//   polling (18), Release button-up candidate (2). Zero union mismatches,
//   32-bit ClipEventFlags validated (SWF v6). No DoAction-assigned
//   onEnterFrame/onLoad/... strings (handlers {}).
// - Keyboard: 54 resolved Key.isDown sites + 1 Key.getCode site, decoded by
//   basic-block abstract interpretation (push order [args,count,object,
//   method]; this toolchain pushes call args right-to-left). Every arg is
//   a remappable _root.key* property variable
//   (keyL/keyR/keyU/keyD/key1/key2/key3 — all 7 slots, zero literals).
//   No Key.LEFT-style constants, no static key codes at call sites.
//   Physical defaults are M1 work; no default button mapping is invented.
// - External: no GetURL/GetURL2/loadMovie/XML/SharedObject/fscommand refs.
// - Sounds: 36 MP3/11025/mono/16-bit DefineSounds with 43 StartSound
//   triggers inside 42 dedicated se_* host sprites. Only se_101 has any
//   spawn evidence — attachMovie("se_101","bgm",129) at root f15
//   story-event dispatch (out of the fight slice) — and no host sprite is
//   statically placed. The other 41 emitters are trigger-covered but
//   instantiation-free: UNCERTAIN, never claimed as firing. The M1
//   conversion allowlist (IN_SCOPE_SOUNDS) is therefore empty until spawn
//   evidence is produced; no se_* sits in LINKAGE.
// - attachMovie linkage is recovered POSITIONALLY (call order = reverse of
//   push order: push [depth,name,linkage] = call (linkage,name,depth)),
//   not by string co-occurrence. 135 static sites + 21 dynamic-linkage
//   sites (linkage computed across block boundaries — the "ef_hit"+i /
//   "se_"+i hiding place, listed exhaustively, never silently classified).
//   Co-occurrence-only claims are banned: ef_hit1 was previously called a
//   literal spawn ref, but positionally it is only ever placed (14x) and
//   used as an instance name — reclassified (P).

export const STAGE_W = 600;
export const STAGE_H = 330;
export const STAGE_FPS = 24;
export const ROOT_FRAMES = 19;
/** SWF stage background #003399 as PocketJS ABGR. */
export const STAGE_BG_ABGR = 0xff993300;

/** Ported game phases (battle slice loop; see battle.tsx title/fight/clear/over). */
export const IN_SCOPE = ["title", "fight", "clear", "over"] as const;
export type InScopeScene = (typeof IN_SCOPE)[number];

/**
 * Explicit skip list: reachable in the SWF but NOT ported in this slice.
 * Group keys (each maps to observed export/timeline groups):
 * - keyconfig: root f11 remappable-key screen (k-slots/kasoru slots, mouse UI)
 * - story-event: event/event1/event101-104/eventname + eventboss* scripts
 * - stage-toujou: toujouS/toujouH/toujouJ1 stage containers (their inner
 *   battle code is semantic source, but the containers are never spawned)
 * - stage-tettai / stage-nige / stage-maku: retreat/escape/curtain scenes
 * - mission-brief: per-boss briefing texts outside the slice
 * - fighter-ally: player2..player6 (non-slice rangers)
 * - fighter-boss: enemy2..enemy4 + enemy11..enemy17 (non-slice bosses)
 * - projectile-extra: tobi variants other than the slice shot (tobi1)
 * - clip-ito: ito thread clip of the non-slice enemy subsystem
 * - sound-emitters: all 42 se_* clips (only se_101/"bgm" is ever spawned,
 *   from out-of-slice root f15 story dispatch; the rest are uncertain)
 */
export const OUT_OF_SCOPE = [
  "keyconfig",
  "story-event",
  "stage-toujou",
  "stage-tettai",
  "stage-nige",
  "stage-maku",
  "mission-brief",
  "fighter-ally",
  "fighter-boss",
  "projectile-extra",
  "clip-ito",
  "sound-emitters",
] as const;
export type OutOfScopeScene = (typeof OUT_OF_SCOPE)[number];

/**
 * Draft spawn table: linkageId -> stable character id (`v<characterId>`).
 * Keys are ExportAssets names (observed, not guessed). Values follow the
 * §4.2 `v<id>` rule; full VariantId mapping is M1 cook work.
 *
 * Spawn-evidence classes (positional recovery in m0-inventory.json
 * attachMovieStatic + placementSummary graphHash inputs):
 * (S) static positional spawn — linkage recovered as last-pushed arg of a
 *     CallMethod/CallFunction attachMovie site with count=3;
 * (P) static placement only — never attachMovie'd, but PlaceObject2 puts
 *     the character on root/stage timelines (instantiation evidence);
 * (F) family/need-assumed, ZERO static evidence — kept because the 21
 *     dynamic-linkage sites prove computed linkage exists somewhere, or
 *     because the slice needs the duel pair/HUD/ground. M1 must
 *     confirm-or-drop every (F) entry; none is claimed as observed.
 */
export const LINKAGE: Record<string, string> = {
  // Duel pair: spawned positionally from stage containers (S) AND placed
  // at root (player1: swf:DoAction@sprite428:f13 attachMovie("player1","a",76)).
  player1: "v546",
  enemy1: "v1158",
  // Hit sparks, spawned positionally (S).
  hits: "v3",
  hits2: "v2",
  hits3: "v1",
  // Hit FX family. ef_hit7/ef_hit11/ef_hit12: (S) positional spawn +
  // root placement. ef_hit1: (P) placed 14x (root + stage timelines),
  // never spawned — the old "(L) literal" label was a co-occurrence
  // artifact and is retracted here. ef_hit2-6: (F) exports exist, zero
  // static evidence (ef_hit2 appears only as an instance NAME arg).
  ef_hit1: "v370",
  ef_hit2: "v1172",
  ef_hit3: "v1175",
  ef_hit4: "v1177",
  ef_hit5: "v1178",
  ef_hit6: "v1182",
  ef_hit7: "v1183",
  ef_hit11: "v1185",
  ef_hit12: "v1171",
  // Slice shot (F): tobi1 has NO static placement and NO static spawn —
  // retained as a dynamic-site candidate for the slice projectile.
  // M1 confirm-or-drop.
  tobi1: "v185",
  // Damage-reaction clip (P): placed 5x (root + event timelines).
  yararekie1: "v426",
  // HUD + ground, spawned positionally (S).
  p_hpb: "v1190",
  e_hpb: "v1193",
  jimen: "v446",
  haikei_front1: "v1170",
};

/** Evidence class per LINKAGE entry (auditable by tests). */
export const LINKAGE_EVIDENCE: Record<string, "S" | "P" | "F"> = {
  player1: "S",
  enemy1: "P",
  hits: "S",
  hits2: "S",
  hits3: "S",
  ef_hit1: "P",
  ef_hit2: "F",
  ef_hit3: "F",
  ef_hit4: "F",
  ef_hit5: "F",
  ef_hit6: "F",
  ef_hit7: "S",
  ef_hit11: "S",
  ef_hit12: "S",
  tobi1: "F",
  yararekie1: "P",
  p_hpb: "S",
  e_hpb: "S",
  jimen: "S",
  haikei_front1: "S",
};

/**
 * Representative out-of-scope linkage IDs (all real ExportAssets names).
 * The runtime gate (resolveLinkage) rejects every one of these (no spawn +
 * counter); the cook gate (assertCookLinkage/validateCookScope) THROWS.
 */
export const OUT_OF_SCOPE_IDS = [
  "eventboss101",
  "eventboss1",
  "toujouS10",
  "toujouS11",
  "toujouJ1",
  "toujouH11",
  "tettai01",
  "nige1",
  "maku",
  "event",
  "event1",
  "event101",
  "event102",
  "event103",
  "event104",
  "eventname",
  "player2",
  "player3",
  "player4",
  "player5",
  "player6",
  "enemy2",
  "enemy3",
  "enemy4",
  "enemy11",
  "enemy12",
  "tobi2",
  "tobi51",
  "tobi52",
  "ito",
  // Sound emitters: the only spawn evidence in the family is
  // attachMovie("se_101","bgm",129) at root f15 story dispatch —
  // out of the slice — so every se_* is out of scope for the cook.
  "se_1",
  "se_101",
  "se_11",
  "se_2",
  "se_21",
  "se_22",
  "se_23",
  "se_24",
  "se_25",
  "se_3",
  "se_31",
  "se_32",
  "se_36",
  "se_37",
  "se_38",
  "se_39",
  "se_41",
  "se_42",
  "se_43",
  "se_44",
  "se_45",
  "se_51",
  "se_52",
  "se_53",
  "se_6",
  "se_61",
  "se_62",
  "se_63",
  "se_64",
  "se_65",
  "se_66",
  "se_67",
  "se_70",
  "se_81",
  "se_82",
  "se_83",
  "se_84",
  "se_85",
  "se_86",
  "se_87",
  "se_88",
  "se_89",
] as const;

/**
 * Draft dynamic-key whitelist: every PlaceObject2 instance name observed
 * in the SWF (slot-path segments for _root/_parent resolution). Sorted,
 * unique. Var-key expansion (s0/muki/hp/...) is M1 work.
 */
export const ALLOWED_KEYS: readonly string[] = [
  "aaa", "act", "ak", "asi", "back000",
  "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
  "ef", "faces", "haikei",
  "hit0", "hit1", "hit10", "hit11", "hit2", "hit3", "hit4",
  "hit5", "hit6", "hit7", "hit8", "hit9",
  "hpb", "hpb1", "hpb2",
  "k", "k00", "k01", "k02", "k10", "k11", "k20", "k21", "k22", "k30", "k31",
  "kage", "kasoru", "kasoru0", "kasoru1", "kasoru2", "kasoru3",
  "laser", "mino", "mino2", "nerai", "s0", "s1", "sen", "shot", "spb", "timeb",
];

/** §5.5 spawn gate: unknown linkage is never spawned, only counted. */
export const unknownLinkageHits: Record<string, number> = Object.create(null);
export function resolveLinkage(linkageId: string): string | undefined {
  const v = LINKAGE[linkageId];
  if (v === undefined) {
    unknownLinkageHits[linkageId] = (unknownLinkageHits[linkageId] ?? 0) + 1;
  }
  return v;
}

/**
 * Cook-time scope gate (M0 acceptance §10): out-of-scope or unknown
 * linkage IDs make the COOK FAIL. Throws CookScopeError naming the
 * offending ID and its scope class. The runtime fail-soft gate above
 * (resolveLinkage → undefined + counter) is a separate path for the
 * shipped game and stays fail-soft; the cook path must be fail-hard.
 */
export class CookScopeError extends Error {
  readonly linkageId: string;
  readonly scopeClass: "out-of-scope" | "unknown";
  constructor(linkageId: string, scopeClass: "out-of-scope" | "unknown") {
    super(
      `ranger cook scope failure: linkage "${linkageId}" is ${scopeClass} ` +
      `(not in LINKAGE; see OUT_OF_SCOPE_IDS / m0-inventory.json attachMovieStatic)`,
    );
    this.name = "CookScopeError";
    this.linkageId = linkageId;
    this.scopeClass = scopeClass;
  }
}

const OUT_OF_SCOPE_SET: ReadonlySet<string> = new Set<string>([
  ...(OUT_OF_SCOPE_IDS as readonly string[]),
]);

/** Single-ID cook gate: returns the variant, or throws CookScopeError. */
export function assertCookLinkage(linkageId: string): string {
  const v = LINKAGE[linkageId];
  if (v !== undefined) return v;
  if (OUT_OF_SCOPE_SET.has(linkageId)) throw new CookScopeError(linkageId, "out-of-scope");
  throw new CookScopeError(linkageId, "unknown");
}

/** Batch cook gate: throws on the FIRST out-of-scope/unknown ID. */
export function validateCookScope(linkageIds: readonly string[]): void {
  for (const id of linkageIds) assertCookLinkage(id);
}

/**
 * M0 sound scope decision (usable by M1): the conversion allowlist is
 * EMPTY. 43 StartSound triggers cover all 36 sounds inside dedicated se_*
 * hosts, but the only static spawn edge (se_101/"bgm" at root f15 story
 * dispatch) is out of the fight slice and no host is statically placed;
 * dynamic linkage construction cannot be excluded, so the remaining 35
 * emitters are uncertain rather than reachable. M1 may promote an emitter
 * only on new static or dynamic-name spawn evidence — never by
 * trigger-coverage assumption. Mirrors inventory soundScope.
 */
export const IN_SCOPE_SOUNDS: readonly number[] = [];
export const SOUND_SCOPE_RATIONALE =
  "43 StartSound triggers cover all 36 sounds inside dedicated se_* host " +
  "sprites, but only se_101 has a literal attachMovie spawn edge (from root " +
  "f15 story-event dispatch, out of the fight slice) and no host sprite is " +
  "statically placed; dynamic linkage construction cannot be excluded, so " +
  "the remaining 35 emitters are uncertain rather than reachable, and the " +
  "M1 conversion allowlist is empty until spawn evidence is produced.";

/**
 * M0 c/d/e execution-order decision (§3.3/§5.6, concrete after M0
 * inventory — M1 replaces the §3.3 placeholders with this order).
 *
 * Per SWF frame (when schedulerStep advances 1):
 *   b. display update (Place/Remove apply),
 *   d. clip EnterFrame handlers (input/collision POLLING),
 *   c. frame scripts (DoAction dispatch/REACTION),
 *   e. game-state finalize (move/collide/score).
 *
 * Evidence: Key.isDown polling (54 sites) and hitTest polling concentrate
 * in EnterFrame-class ClipActions (ev 0x2 carries the per-frame loop
 * signals), while reaction verbs concentrate in DoAction frame scripts
 * (gotoAndStop x701 numeric frames, attachMovie x156 positional spawns,
 * damage/e_damage/s_effect calls). Polling must precede reaction in the
 * same SWF step, else reactions consume a stale frame.
 *
 * Recorded deviation (§5.6-4): the exact original interleave of clip
 * handlers vs frame scripts is not statically provable (no AVM1
 * execution, no timestamps), so a 1-SWF-frame staleness deviation vs the
 * original remains possible and must be covered by M3 sim differential
 * testing. No order is left as "assumed placeholder" after M0.
 */
export const EXECUTION_ORDER = {
  order: ["b-display", "d-clip-enterframe", "c-frame-scripts", "e-finalize"] as const,
  pollingSignalsInEnterFrame: ["Key.isDown", "hitTest", "Key.getCode"] as const,
  reactionVerbsInFrameScripts: ["gotoAndStop", "gotoAndPlay", "attachMovie", "damage", "s_effect"] as const,
  deviation:
    "Exact original clip-handler/frame-script interleave is not statically " +
    "provable; a 1-SWF-frame input-staleness deviation vs the original is " +
    "possible and must be covered by M3 sim differential testing.",
} as const;

/** §5.4 dynamic-key gate: outside the whitelist is no-op + counter. */
export const allowedKeyMisses: Record<string, number> = Object.create(null);
export function isAllowedKey(key: string): boolean {
  const ok = (ALLOWED_KEYS as readonly string[]).includes(key);
  if (!ok) allowedKeyMisses[key] = (allowedKeyMisses[key] ?? 0) + 1;
  return ok;
}
