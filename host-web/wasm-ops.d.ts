// Type surface of wasm-ops.js for the TS harness (test/golden.ts). The .js
// stays plain ESM so the browser loads it without a build step.

import type { HostOps } from "../src/host.ts";

export declare const FB_W: number;
export declare const FB_H: number;

export interface WasmUi {
  ops: HostOps;
  exports: WebAssembly.Exports & { memory: WebAssembly.Memory };
  /** Reset the core to a fresh Ui (fresh tree/styles/atlases/textures). */
  init(): void;
  /** Advance exactly one fixed-dt (1/60 s) frame. */
  tick(): void;
  /** Rasterize and return the RGBA8 480x272 framebuffer as a fresh view. */
  render(): Uint8Array;
  /** Blit active HTML5 <video> frames into the wasm surfaces; call before render(). */
  pumpVideos(): void;
}

export declare function createWasmUi(
  wasm: ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<WasmUi>;

export declare function uploadPackImages(
  ops: HostOps,
  listEntries: (prefix: string) => string[],
  getEntry: (key: string) => Uint8Array,
): Map<string, number>;
