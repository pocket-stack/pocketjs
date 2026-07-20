import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

export interface AppCheckOptions {
  entry: string;
  /** Optional app tsconfig whose compiler options/path mappings are inherited. */
  tsconfigPath?: string;
  /** Framework/app ambient declarations required by the reachable source graph. */
  declarationFiles?: readonly string[];
  /** Keep the generated directory for debugging failed checks. */
  keepTemporaryFiles?: boolean;
}

export interface AppCheckDiagnostic {
  code: number;
  category: "warning" | "error" | "suggestion" | "message";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface AppCheckArtifacts {
  tsconfig: string;
  /** Present only when keepTemporaryFiles is true. */
  directory?: string;
}

export interface AppCheckResult {
  ok: boolean;
  diagnostics: AppCheckDiagnostic[];
  /** Non-declaration files reached from entry. Unrelated project files stay out. */
  checkedFiles: string[];
  artifacts: AppCheckArtifacts;
}

function configJson(
  entry: string,
  tsconfigPath: string | undefined,
  declarationFiles: readonly string[],
): string {
  const config: Record<string, unknown> = {
    ...(tsconfigPath ? { extends: tsconfigPath } : {}),
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      jsx: "preserve",
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      incremental: false,
      composite: false,
      ...(tsconfigPath ? {} : { types: [] }),
    },
    files: [entry, ...declarationFiles],
    // Never inherit a broad include/exclude set: files plus normal module
    // resolution is the exact entry/import graph contract.
    include: [],
    exclude: [],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function diagnosticCategory(category: ts.DiagnosticCategory): AppCheckDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "error";
  }
}

function toDiagnostic(diagnostic: ts.Diagnostic): AppCheckDiagnostic {
  const result: AppCheckDiagnostic = {
    code: diagnostic.code,
    category: diagnosticCategory(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
  if (diagnostic.file && diagnostic.start !== undefined) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    result.file = diagnostic.file.fileName;
    result.line = position.line + 1;
    result.column = position.character + 1;
  }
  return result;
}

/** Typecheck exactly one app entry and its reachable imports. */
export function checkAppTypes(options: AppCheckOptions): AppCheckResult {
  const entry = resolve(options.entry);
  if (!existsSync(entry)) throw new Error(`PocketJS app check: entry not found: ${entry}`);
  const inheritedConfig = options.tsconfigPath ? resolve(options.tsconfigPath) : undefined;
  if (inheritedConfig && !existsSync(inheritedConfig)) {
    throw new Error(`PocketJS app check: tsconfig not found: ${inheritedConfig}`);
  }

  // Keep the ephemeral config beneath the app/config tree rather than the OS
  // temp directory. TypeScript resolves named `types` and config-relative
  // package paths from the generated config's ancestry.
  const temporaryParent = inheritedConfig ? dirname(inheritedConfig) : dirname(entry);
  const directory = mkdtempSync(resolve(temporaryParent, ".pocketjs-app-check-"));
  const generatedConfigPath = resolve(directory, "tsconfig.json");
  const declarationFiles = (options.declarationFiles ?? []).map((file) => resolve(file));
  for (const file of declarationFiles) {
    if (!existsSync(file)) throw new Error(`PocketJS app check: declaration file not found: ${file}`);
  }
  const tsconfig = configJson(entry, inheritedConfig, declarationFiles);
  writeFileSync(generatedConfigPath, tsconfig);

  try {
    const loaded = ts.readConfigFile(generatedConfigPath, (path) => readFileSync(path, "utf8"));
    const configDiagnostics = loaded.error ? [loaded.error] : [];
    const parsed = loaded.error
      ? undefined
      : ts.parseJsonConfigFileContent(
          loaded.config,
          ts.sys,
          dirname(generatedConfigPath),
          undefined,
          generatedConfigPath,
        );
    if (parsed) configDiagnostics.push(...parsed.errors);

    const program = parsed
      ? ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
      : undefined;
    const diagnostics = [
      ...configDiagnostics,
      ...(program ? ts.getPreEmitDiagnostics(program) : []),
    ].map(toDiagnostic);
    const checkedFiles = program
      ? program
          .getSourceFiles()
          .filter((file) => !file.isDeclarationFile)
          .map((file) => resolve(file.fileName))
          .sort()
      : [];

    return {
      ok: diagnostics.every((diagnostic) => diagnostic.category !== "error"),
      diagnostics,
      checkedFiles,
      artifacts: {
        tsconfig,
        ...(options.keepTemporaryFiles ? { directory } : {}),
      },
    };
  } finally {
    if (!options.keepTemporaryFiles) rmSync(directory, { recursive: true, force: true });
  }
}
