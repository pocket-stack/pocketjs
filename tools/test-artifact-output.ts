import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface GeneratedTestArtifactOutput {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export function testArtifactOutputDirectory(args: readonly string[]): string {
  if (args.length !== 1 || !args[0]?.startsWith("--output-dir=")) {
    throw new Error("usage: bun generate.ts --output-dir=<directory>");
  }
  const value = args[0].slice("--output-dir=".length);
  if (value.length === 0) {
    throw new Error("artifact output directory cannot be empty");
  }
  return resolve(value);
}

export async function writeTestArtifactOutputs(
  outputDirectory: string,
  outputs: readonly GeneratedTestArtifactOutput[],
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const output of outputs) {
    if (
      output.name.length === 0 ||
      output.name === "." ||
      output.name === ".." ||
      output.name.includes("/") ||
      output.name.includes("\\")
    ) {
      throw new Error(`invalid generated artifact name: ${output.name}`);
    }
    await Bun.write(resolve(outputDirectory, output.name), output.bytes);
  }
}
