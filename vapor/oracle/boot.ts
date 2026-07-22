// vapor/oracle/boot.ts — build the oracle bundle and drive it.
//
// The bundle is produced with the repo's own vue-vapor jsx pipeline
// (framework/compiler/jsx-plugin.ts), so the todo component goes through the exact
// vue-jsx-vapor transform any PocketJS vapor app does — the oracle is not a
// reimplementation of Vue, it IS Vue 3.6 vapor.

import { join } from "node:path";
import { jsxPlugin } from "../../framework/compiler/jsx-plugin.ts";
import type { StyleTable } from "../compiler/styles.ts";
import { createRootElement, installOracleDom, type VaporElement } from "./dom.ts";
import { paintGrid, type CellGrid } from "./paint.ts";

const ENTRY = join(import.meta.dir, "entry.ts");

let bundleText: string | null = null;

async function buildOracleBundle(): Promise<string> {
  if (bundleText) return bundleText;
  const result = await Bun.build({
    entrypoints: [ENTRY],
    format: "iife",
    target: "browser",
    conditions: ["browser"],
    define: {
      document: "globalThis.__vaporDocument",
      "process.env.NODE_ENV": '"production"',
      __DEV__: "false",
    },
    plugins: [jsxPlugin("vue-vapor")],
  });
  if (!result.success) {
    throw new Error(`oracle bundle failed:\n${result.logs.join("\n")}`);
  }
  bundleText = await result.outputs[0].text();
  return bundleText;
}

export interface Oracle {
  root: VaporElement;
  /** Deliver one button edge and settle vapor's scheduler. */
  press(button: number): Promise<void>;
  /** Current rendered grid. */
  grid(): CellGrid;
  unmount(): void;
}

export interface OracleOptions {
  width?: number;
  height?: number;
  /** compile-produced style table: class -> pair id/align for the painter */
  styles?: StyleTable;
}

export async function bootOracle(opts: OracleOptions = {}): Promise<Oracle> {
  const bundle = await buildOracleBundle();
  installOracleDom();
  const g = globalThis as Record<string, unknown>;
  g.__vaporScreenW = opts.width ?? 30;
  g.__vaporScreenH = opts.height ?? 20;
  (0, eval)(bundle);

  const hooks = globalThis as Record<string, unknown>;
  const boot = hooks.__vaporBoot as (container: unknown) => { unmount(): void };
  const pressHook = hooks.__vaporPress as (button: number) => void;
  const tick = hooks.__vaporTick as () => Promise<void>;

  const root = createRootElement();
  const app = boot(root);
  await tick();

  return {
    root,
    async press(button: number) {
      pressHook(button);
      await tick();
    },
    grid: () => paintGrid(root, opts.width ?? 30, opts.height ?? 20, opts.styles),
    unmount: () => app.unmount(),
  };
}
