// aot/dsl/types.ts — authoring-time types: branded ids and shared enums.
// Types are erased; the compiler re-validates against the Game IR (design §9).

export type Brand<T, K extends string> = T & { readonly __brand: K };
export type MapId = Brand<string, "MapId">;
export type SpriteId = Brand<string, "SpriteId">;
export type FlagId = Brand<string, "FlagId">;
export type VarId = Brand<string, "VarId">;
export type ItemId = Brand<string, "ItemId">;
export type BattleId = Brand<string, "BattleId">;
export type ScriptId = Brand<number, "ScriptId">;

export type Direction = "down" | "up" | "left" | "right";
export type MovementKind = "static" | "wander" | "patrolH" | "patrolV";
export type TileCoord = readonly [x: number, y: number];

// A compiled reference to a script's generator body. `script()` returns this;
// JSX props like `onTalk={RivalTalk}` carry it into the map IR.
export interface ScriptRef {
  readonly __pjgbScript: number;
}
