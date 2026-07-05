// aot/compiler/context.ts — shared compile state (interned banks + id maps)
// threaded through bake -> model -> script -> ir.

class NameInterner {
  private m = new globalThis.Map<string, number>();
  private _list: string[] = [];
  intern(name: string): number {
    let id = this.m.get(name);
    if (id === undefined) {
      id = this._list.length;
      this.m.set(name, id);
      this._list.push(name);
    }
    return id;
  }
  get(name: string): number | undefined {
    return this.m.get(name);
  }
  list(): readonly string[] {
    return this._list;
  }
  get size(): number {
    return this._list.length;
  }
}

export interface SpriteProto {
  name: string;
  id: number;
  w: number;
  h: number;
  palbank: number;
  frames: number;
  tileBase: number; // OBJ tile index of first tile
}

export interface ScriptOut {
  id: number;
  name: string;
  bytecode: number[];
}

export class Ctx {
  texts = new NameInterner();
  flags = new NameInterner();
  vars = new NameInterner();
  items = new NameInterner();
  battles = new NameInterner();

  // filled by bake
  bgPalette = new Uint16Array(256);
  objPalette = new Uint16Array(256);
  bgTiles: Uint8Array[] = [];
  objTiles: Uint8Array[] = [];
  tileNameToId = new globalThis.Map<string, number>();
  spriteProtos: SpriteProto[] = [];
  spriteIds = new globalThis.Map<string, number>();
  fontBase = 0;
  boxTile = 0;

  // filled by model
  mapIndex = new globalThis.Map<string, number>();

  // filled by script (+ synthetic sign scripts)
  scripts: ScriptOut[] = [];

  internText(s: string): number {
    return this.texts.intern(s);
  }
  flagId(name: string): number {
    return this.flags.intern(name);
  }
  varIdOf(name: string): number {
    return this.vars.intern(name);
  }
  spriteId(name: string): number {
    const id = this.spriteIds.get(name);
    if (id === undefined) throw new Error(`unknown sprite "${name}"`);
    return id;
  }
  /** Allocate the next script id (dense, appended after AST scripts). */
  addScript(name: string, bytecode: number[]): number {
    const id = this.scripts.length;
    this.scripts.push({ id, name, bytecode });
    return id;
  }
}
