// aot/compiler/targets/index.ts — target backend dispatch.

import type { CompileOutput } from "../index.ts";

export interface TargetBuildResult {
  rom: string;
  size: number;
}

export async function buildTarget(out: CompileOutput, outPath: string): Promise<TargetBuildResult> {
  switch (out.target) {
    case "gba": {
      const { buildGba } = await import("./gba.ts");
      const r = await buildGba(out, outPath);
      return { rom: r.gba, size: r.size };
    }
    case "gb": {
      const { buildGb } = await import("./gb.ts");
      return buildGb(out, outPath);
    }
    case "nes": {
      const { buildNes } = await import("./nes.ts");
      return buildNes(out, outPath);
    }
    case "3ds": {
      const { build3ds } = await import("./3ds.ts");
      return build3ds(out, outPath);
    }
    case "nds": {
      const { buildNds } = await import("./nds.ts");
      return buildNds(out, outPath);
    }
  }
}
