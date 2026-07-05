// aot/dsl/jsx-runtime.ts — the BUILD-TIME JSX factory (automatic runtime).
//
// The demo's TSX is transpiled with jsxImportSource = this module, then executed
// in-process by the compiler's static evaluator (design §11.3). JSX does NOT
// build a UI tree — it builds a static "scene element" tree that the IR builder
// walks. Pure user components (e.g. TownSign) are just called and expanded here;
// they never ship to the GBA.

import type { Direction, MovementKind, ScriptRef, SpriteId, TileCoord } from "./types.ts";

export interface PjgbNode {
  host: string; // host element name, or "#fragment"
  props: Record<string, unknown>;
  children: PjgbNode[];
}

export type PjgbChild = PjgbNode | readonly PjgbChild[] | boolean | null | undefined;

/** Marker for a host element (Map, Layer, Npc, ...). */
export interface HostMarker<Props extends object = Record<string, unknown>> {
  readonly __pjgbHost: true;
  readonly hostName: string;
  (props: Props & { children?: PjgbChild }): PjgbNode;
}

export interface LayerProps {
  rows: readonly string[];
  legend: Record<string, string>;
}

export interface PlayerSpawnProps {
  id?: string;
  at: TileCoord;
  facing: Direction;
}

export interface EntranceProps {
  id: string;
  at: TileCoord;
  facing: Direction;
}

export interface NpcProps {
  id: string;
  sprite: SpriteId | string;
  at: TileCoord;
  facing: Direction;
  movement?: MovementKind;
  onTalk?: ScriptRef;
}

export interface SignProps {
  text: string;
  at: TileCoord;
}

export interface WarpProps {
  to: `${string}:${string}` | string;
  at: TileCoord;
}

export const Fragment = hostElement("#fragment");

export function hostElement<Props extends object = Record<string, unknown>>(
  name: string,
): HostMarker<Props> {
  const marker = ((props: Props & { children?: PjgbChild }) => {
    const { children, ...rest } = props ?? {};
    const kids = normalizeChildren(children);
    if (name === "#fragment") return { host: "#fragment", props: {}, children: kids };
    return { host: name, props: rest, children: kids };
  }) as HostMarker<Props>;
  Object.defineProperties(marker, {
    __pjgbHost: { value: true },
    hostName: { value: name },
  });
  return marker;
}

function isHost(t: unknown): t is HostMarker {
  return (typeof t === "object" || typeof t === "function") && t !== null && (t as HostMarker).__pjgbHost === true;
}

/** Flatten fragments/arrays/falsy into a flat list of real element nodes. */
function normalizeChildren(raw: unknown): PjgbNode[] {
  const out: PjgbNode[] = [];
  const push = (c: unknown): void => {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) {
      for (const x of c) push(x);
      return;
    }
    const node = c as PjgbNode;
    if (node && typeof node === "object" && node.host === "#fragment") {
      for (const x of node.children) push(x);
      return;
    }
    if (node && typeof node === "object" && typeof node.host === "string") {
      out.push(node);
      return;
    }
    // Strings/numbers are not valid scene children in v1.
    throw new Error(`pjgb jsx: unexpected child ${JSON.stringify(c)}`);
  };
  push(raw);
  return out;
}

export function normalizeSceneChildren(raw: unknown): PjgbNode[] {
  return normalizeChildren(raw);
}

export function jsx(type: unknown, props: Record<string, unknown>): PjgbNode {
  const { children, ...rest } = props ?? {};
  const kids = normalizeChildren(children);

  if (isHost(type)) {
    if (type.hostName === "#fragment") return { host: "#fragment", props: {}, children: kids };
    return { host: type.hostName, props: rest, children: kids };
  }
  if (typeof type === "function") {
    // Pure build-time component: execute and expand.
    const result = (type as (p: Record<string, unknown>) => unknown)({ ...rest, children: kids });
    const normalized = normalizeChildren(result);
    return normalized.length === 1
      ? normalized[0]
      : { host: "#fragment", props: {}, children: normalized };
  }
  throw new Error(`pjgb jsx: unsupported element type ${String(type)}`);
}

export const jsxs = jsx;
export const jsxDEV = jsx;

export namespace JSX {
  export type Element = PjgbNode;
  export interface ElementChildrenAttribute {
    children: {};
  }
}
