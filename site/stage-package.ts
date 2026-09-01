import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export interface StageProfile {
  attribution: string;
  lods: Record<string, string>;
  [key: string]: unknown;
}

function resolveInside(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`stage package path escapes its root: ${relative}`);
  }
  return target;
}

/** Emit a self-consistent web package containing one selected low-power LOD. */
export function emitSingleLodStagePackage(
  sourceDir: string,
  outputDir: string,
  profileOutputName: string,
  preferredLod: string,
): StageProfile {
  const source = JSON.parse(
    readFileSync(resolveInside(sourceDir, "profile.json"), "utf8"),
  ) as StageProfile;
  const selected = source.lods?.[preferredLod];
  if (!selected) throw new Error(`stage profile has no ${preferredLod} LOD`);
  if (!source.attribution) throw new Error("stage profile has no attribution file");

  const profile: StageProfile = {
    ...source,
    lods: Object.fromEntries(Object.keys(source.lods).map((name) => [name, selected])),
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolveInside(outputDir, profileOutputName),
    JSON.stringify(profile),
  );

  for (const file of new Set([...Object.values(profile.lods), profile.attribution])) {
    const destination = resolveInside(outputDir, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolveInside(sourceDir, file), destination);
  }
  return profile;
}
