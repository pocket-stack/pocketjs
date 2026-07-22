// Type surface of wasm-ops.js for the TS harness (test/golden.ts). The .js
// stays plain ESM so the browser loads it without a build step.

import type { HostOps } from "../src/host.ts";

export declare const FB_W: number;
export declare const FB_H: number;

export interface WasmUi {
  ops: HostOps;
  exports: WebAssembly.Exports & { memory: WebAssembly.Memory };
  /** Reset the core and set raster samples per logical pixel (default 1). */
  init(rasterDensity?: number): void;
  /** Advance exactly one fixed-dt (1/60 s) frame. */
  tick(): void;
  /** Hash the current DrawList without rasterizing it; null for an older wasm. */
  drawHash: (() => bigint) | null;
  /** Rasterize the byte-exact RGBA8 480x272 framebuffer as a fresh view. */
  render(): Uint8Array;
  /** Rasterize directly at an integer physical scale from 1 through 4. */
  renderScaled(scale: number): Uint8Array;
}

export declare function createWasmUi(
  wasm: ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<WasmUi>;

export declare function uploadPackImages(
  ops: HostOps,
  listEntries: (prefix: string) => string[],
  getEntry: (key: string) => Uint8Array,
): Map<string, number>;
