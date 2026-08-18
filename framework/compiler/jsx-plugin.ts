// Framework-aware pass-1 Babel transform + AST collection.

import { transformAsync, type PluginObj } from "@babel/core";
import type { ParserOptions } from "@babel/parser";
import solidPreset from "babel-preset-solid";
import tsPreset from "@babel/preset-typescript"; // untyped - see framework/compiler/ambient.d.ts
import { transformVueJsxVapor } from "vue-jsx-vapor/api";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileVueSfc } from "./vue-sfc-compile.ts";
import {
  propsHelperCode,
  propsHelperId,
  ssrHelperCode,
  ssrHelperId,
  vaporHelperCode,
  vaporHelperId,
  vdomHelperCode,
  vdomHelperId,
} from "@vue-jsx-vapor/runtime/raw";
import type { BunPlugin } from "bun";
import { compile as octaneCompile } from "octane/compiler";
import solidPresetPkg from "babel-preset-solid/package.json";
import compilerSfcPkg from "@vue/compiler-sfc/package.json";
import vuePkg from "vue/package.json";
import vueJsxVaporPkg from "vue-jsx-vapor/package.json";
import octanePkg from "octane/package.json";
import babelCorePkg from "@babel/core/package.json";
import tsPresetPkg from "@babel/preset-typescript/package.json";
import type { PocketFramework } from "../src/config.ts";
import { POCKET_FRAMEWORKS, SUBPATHS } from "./subpaths.ts";
import {
  NETWORK_BINDING_RESERVED_IDENTIFIER,
  NETWORK_PRIVATE_PREFIX,
  NETWORK_PRIVATE_SPECIFIER,
  type NetworkPrivateBuildContext,
} from "./network-private.ts";

export type { PocketFramework };

export const RENDERER_PATH = new URL("../src/renderer.ts", import.meta.url).pathname;
export const RENDERER_SOLID_PATH = new URL("../src/renderer-solid.ts", import.meta.url).pathname;
export const RENDERER_VUE_VAPOR_PATH = new URL("../src/renderer-vue-vapor.ts", import.meta.url).pathname;
export const RENDERER_OCTANE_PATH = new URL("../src/renderer-octane.ts", import.meta.url).pathname;

/**
 * subpath -> absolute module file, per framework — derived once from the
 * SUBPATHS registry (framework/compiler/subpaths.ts, THE declaration).
 * A missing entry means "this framework does not resolve the subpath":
 * pass 1 skips it and pass 2 falls through to Bun's package.json
 * resolution.
 */
const RESOLVED: Record<PocketFramework, Record<string, string>> = (() => {
  const root = new URL("../../", import.meta.url);
  const out: Record<PocketFramework, Record<string, string>> = {
    solid: {},
    "vue-vapor": {},
    octane: {},
  };
  for (const [name, decl] of Object.entries(SUBPATHS)) {
    for (const fw of POCKET_FRAMEWORKS) {
      const rel = typeof decl.file === "string" ? decl.file : decl.file[fw];
      if (rel) out[fw][name] = new URL(rel, root).pathname;
    }
  }
  return out;
})();
const OCTANE_PROFILING_STUB_PATH = new URL(
  "../src/octane-profiling-stub.ts",
  import.meta.url,
).pathname;
const GENERATED_STYLES_PATH = new URL(
  "../src/styles.generated.ts",
  import.meta.url,
).pathname;
const VUE_VAPOR_RUNTIME_PATH = new URL(
  "../../node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.prod.js",
  import.meta.url,
).pathname;
const SOLID_RUNTIME_PATH = new URL(
  "../../node_modules/solid-js/dist/solid.js",
  import.meta.url,
).pathname;
const SOLID_UNIVERSAL_RUNTIME_PATH = new URL(
  "../../node_modules/solid-js/universal/dist/universal.js",
  import.meta.url,
).pathname;

const PACKAGE_NAME = "@pocketjs/framework";
const CACHE_DIR = new URL("../../.cache/transforms/", import.meta.url).pathname;
const CACHE_VERSION = "2"; // manual backstop; compiler sources are hashed in below
const COMPILER_DIR = new URL("./", import.meta.url).pathname;
const NETWORK_HTTP_BINDING_FRAMEWORK_SOURCE = realpathSync(new URL(
  "../src/net/http-binding.ts",
  import.meta.url,
).pathname);
const NETWORK_V1_BINDING_FRAMEWORK_SOURCE = realpathSync(new URL(
  "../src/net/network-v1-binding.ts",
  import.meta.url,
).pathname);
const NETWORK_LIMITS_FRAMEWORK_SOURCE = realpathSync(new URL(
  "../src/net/network-limits.ts",
  import.meta.url,
).pathname);
const NETWORK_HTTP_FRAMEWORK_SOURCE = realpathSync(new URL(
  "../src/net/http.ts",
  import.meta.url,
).pathname);
const NETWORK_INDEX_FRAMEWORK_SOURCE = realpathSync(new URL(
  "../src/net/index.ts",
  import.meta.url,
).pathname);
const NETWORK_PRIVATE_FRAMEWORK_SOURCES = new Set([
  NETWORK_HTTP_BINDING_FRAMEWORK_SOURCE,
  NETWORK_V1_BINDING_FRAMEWORK_SOURCE,
  NETWORK_LIMITS_FRAMEWORK_SOURCE,
]);
const NETWORK_PUBLIC_FRAMEWORK_SPECIFIER_BY_SOURCE = new Map<string, string>([
  [realpathSync(new URL("../src/net/http.ts", import.meta.url).pathname), `${PACKAGE_NAME}/net/http`],
  [realpathSync(new URL("../src/net/websocket.ts", import.meta.url).pathname), `${PACKAGE_NAME}/net/websocket`],
  [realpathSync(new URL("../src/net/mqtt.ts", import.meta.url).pathname), `${PACKAGE_NAME}/net/mqtt`],
  [realpathSync(new URL("../src/net/tcp.ts", import.meta.url).pathname), `${PACKAGE_NAME}/net/tcp`],
  [realpathSync(new URL("../src/net/udp.ts", import.meta.url).pathname), `${PACKAGE_NAME}/net/udp`],
]);
const FRAMEWORK_SOURCE_ROOT = realpathSync(new URL("../src/", import.meta.url).pathname);
const NETWORK_PRIVATE_NAMESPACE = "pocketjs-network-private-v1";

/**
 * Hash of this package's own compiler sources: transform behavior lives here,
 * and neither dependency versions nor input hashes cover it, so a warm cache
 * would otherwise serve output from the previous implementation.
 *
 * The set is walked from this file's own imports rather than hand-listed - a
 * literal list rots the moment a compiler module is added or split, which is
 * exactly the failure this key exists to prevent. Only `framework/compiler` is
 * in scope: everything under `framework/src` is a transform *input*, hashed as
 * it is transformed.
 */
async function hashCompilerSources(): Promise<string> {
  const scanner = new Bun.Transpiler({ loader: "ts" });
  const sources = new Map<string, string>();
  const pending = [new URL("./jsx-plugin.ts", import.meta.url)];
  while (pending.length > 0) {
    const url = pending.pop()!;
    if (!url.pathname.startsWith(COMPILER_DIR)) continue;
    const name = url.pathname.slice(COMPILER_DIR.length);
    if (sources.has(name)) continue;
    const source = await Bun.file(url).text();
    sources.set(name, source);
    for (const { path } of scanner.scanImports(source)) {
      if (path.startsWith(".")) pending.push(new URL(path, url));
    }
  }
  const h = new Bun.CryptoHasher("sha256");
  for (const name of [...sources.keys()].sort()) h.update(name + "\0" + sources.get(name)! + "\0");
  return h.digest("hex");
}

let implementationHash: Promise<string> | undefined;

function compilerImplementationHash(): Promise<string> {
  return (implementationHash ??= hashCompilerSources());
}

const JSX_PARSER_OPTS: ParserOptions = { plugins: ["jsx"] };

const BANNED_SOLID_IMPORTS = new Set(["createResource", "useTransition", "startTransition"]);

// Per-framework identity. Module resolution is NOT here — it is derived
// from the SUBPATHS registry (framework/compiler/subpaths.ts) into RESOLVED
// above; rootPath/rendererPath are views into the same derivation.
export const FRAMEWORKS: Record<
  PocketFramework,
  {
    label: string;
    outputSuffix: string;
    rendererPath: string;
    rootPath: string;
  }
> = {
  solid: {
    label: "Solid",
    outputSuffix: "",
    rendererPath: RESOLVED.solid.renderer,
    rootPath: RESOLVED.solid[""],
  },
  "vue-vapor": {
    label: "Vue Vapor",
    outputSuffix: ".vue-vapor",
    rendererPath: RESOLVED["vue-vapor"].renderer,
    rootPath: RESOLVED["vue-vapor"][""],
  },
  octane: {
    label: "Octane",
    outputSuffix: ".octane",
    rendererPath: RESOLVED.octane.renderer,
    rootPath: RESOLVED.octane[""],
  },
};

/**
 * The universal-renderer descriptor handed to the Octane compiler: JSX lowers
 * to static host plans + dynamic slots and every runtime import retargets to
 * the pocket renderer module (framework/src/renderer-octane.ts).
 */
export const OCTANE_RENDERER_DESCRIPTOR = {
  id: "pocket",
  module: `${"@pocketjs/framework"}/octane/renderer`,
  target: "universal",
  server: "unsupported",
  text: "host",
  capabilities: ["portal"],
} as const;

function patchVaporHelperCode(code: string): string {
  return code.replace(
    `if (i && i.appContext.vapor && p === "__vapor") {
          return true;
        }
        return Reflect.get`,
    `if (i && i.appContext.vapor && p === "__vapor") {
          return true;
        }
        if (i && i.appContext.vapor && p === "inheritAttrs") {
          return false;
        }
        return Reflect.get`,
  );
}

const VAPOR_HELPERS = new Map([
  [propsHelperId, propsHelperCode],
  [vdomHelperId, vdomHelperCode],
  [vaporHelperId, patchVaporHelperCode(vaporHelperCode)],
  [ssrHelperId, ssrHelperCode],
]);

export function parseFramework(value: string | undefined, source: string): PocketFramework {
  if (value === undefined || value === "") return "solid";
  if (value === "solid" || value === "vue-vapor" || value === "octane") return value;
  throw new Error(`PocketJS ${source}: framework must be "solid", "vue-vapor" or "octane"`);
}

export interface TransformResult {
  /** ESM JS: JSX compiled for the selected framework. */
  code: string;
  /** Candidate class strings (deduped, in AST order). */
  classStrings: string[];
  /** Every codepoint appearing in any collected literal. */
  textCodepoints: Set<number>;
}

interface Collected {
  classStrings: string[];
  textCodepoints: Set<number>;
}

export type BuildFeatures = Readonly<Record<string, boolean>>;

const NETWORK_SURFACE_DEMANDS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  [`${PACKAGE_NAME}/net/http`]: {
    fetch: ["network.http.client"],
    serve: ["network.http.server"],
  },
  [`${PACKAGE_NAME}/net/websocket`]: {
    connect: ["network.websocket.client"],
    serve: ["network.websocket.server"],
    upgrade: [
      "network.http.server",
      "network.websocket.server",
      "network.websocket.server.upgrade",
    ],
  },
  [`${PACKAGE_NAME}/net/mqtt`]: {
    connect: ["network.mqtt.client"],
  },
  [`${PACKAGE_NAME}/net/tcp`]: {
    connect: ["network.tcp.client"],
    listen: ["network.tcp.server"],
  },
  [`${PACKAGE_NAME}/net/udp`]: {
    udpSocket: ["network.udp"],
  },
};

/** Value implementations that are declared for type-checking but cannot be
 * linked into a PocketJS application until their Guest Binding is complete. */
const STAGED_NETWORK_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  [`${PACKAGE_NAME}/net/http`]: new Set(["fetch", "serve", "Headers", "Request", "Response"]),
  [`${PACKAGE_NAME}/net/websocket`]: new Set(["connect", "serve", "upgrade"]),
  [`${PACKAGE_NAME}/net/mqtt`]: new Set(["connect"]),
  [`${PACKAGE_NAME}/net/tcp`]: new Set(["connect", "listen"]),
  [`${PACKAGE_NAME}/net/udp`]: new Set(["udpSocket"]),
};

function makeNetworkDemandGate(
  features: BuildFeatures | undefined,
  testOnlyStagedHttpClientFetch = false,
): PluginObj {
  const requireCapabilities = (
    path: { buildCodeFrameError(message: string): Error },
    source: string,
    exportNames: readonly string[] | null,
  ): void => {
    const surface = NETWORK_SURFACE_DEMANDS[source];
    if (!surface) return;
    const names = exportNames ?? [
      ...new Set([...Object.keys(surface), ...(STAGED_NETWORK_VALUES[source] ?? [])]),
    ];
    const demanded = new Set<string>();
    for (const name of names) {
      for (const capability of surface[name] ?? []) demanded.add(capability);
    }
    const missing = [...demanded].filter((capability) => features?.[capability] !== true);
    if (missing.length === 0) return;
    const selected = exportNames === null ? "namespace/all value exports" :
      exportNames.map((name) => `\`${name}\``).join(", ");
    throw path.buildCodeFrameError(
      `PocketJS: ${source} ${selected} requires admitted ` +
        `${missing.length === 1 ? "capability" : "capabilities"} ${missing.map((id) => `\`${id}\``).join(", ")}. ` +
        "The ResolvedBuildPlan does not provide them.",
    );
  };

  const requireReadySurface = (
    path: { buildCodeFrameError(message: string): Error },
    source: string,
    exportNames: readonly string[] | null,
  ): void => {
    const staged = STAGED_NETWORK_VALUES[source];
    if (!staged) return;
    const names = exportNames ?? [...staged];
    const unavailable = names.filter((name) =>
      staged.has(name) && !(
        testOnlyStagedHttpClientFetch &&
        source === `${PACKAGE_NAME}/net/http` &&
        name === "fetch"
      )
    );
    if (unavailable.length === 0) return;
    throw path.buildCodeFrameError(
      `PocketJS: ${source} ${unavailable.map((name) => `\`${name}\``).join(", ")} ` +
        "is a staged surface whose Guest Binding is not available in this build.",
    );
  };

  const checkSurface = (
    path: { buildCodeFrameError(message: string): Error },
    source: string,
    exportNames: readonly string[] | null,
  ): void => {
    requireCapabilities(path, source, exportNames);
    requireReadySurface(path, source, exportNames);
  };

  return {
    name: "pocketjs-network-demand-gate",
    visitor: {
      ImportDeclaration(path) {
        const source = path.node.source.value;
        if (!NETWORK_SURFACE_DEMANDS[source] || path.node.importKind === "type") return;
        let allValues = path.node.specifiers.length === 0;
        const names: string[] = [];
        for (const specifier of path.node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            if (specifier.importKind === "type") continue;
            names.push(
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value,
            );
          } else {
            allValues = true;
          }
        }
        checkSurface(path, source, allValues ? null : names);
      },
      ExportNamedDeclaration(path) {
        const source = path.node.source?.value;
        if (!source || !NETWORK_SURFACE_DEMANDS[source] || path.node.exportKind === "type") return;
        let allValues = false;
        const names: string[] = [];
        for (const specifier of path.node.specifiers) {
          if (specifier.type !== "ExportSpecifier") {
            allValues = true;
            continue;
          }
          if (specifier.exportKind === "type") continue;
          const local = specifier.local as
            | { readonly type: "Identifier"; readonly name: string }
            | { readonly type: "StringLiteral"; readonly value: string };
          names.push(local.type === "Identifier" ? local.name : local.value);
        }
        checkSurface(path, source, allValues ? null : names);
      },
      ExportAllDeclaration(path) {
        const source = path.node.source.value;
        if (path.node.exportKind === "type") return;
        checkSurface(path, source, null);
      },
      CallExpression(path) {
        const dynamicImport = path.node.callee.type === "Import";
        const commonJsRequire = path.node.callee.type === "Identifier" &&
          path.node.callee.name === "require";
        if (!dynamicImport && !commonJsRequire) return;

        const argumentPaths = path.get("arguments");
        const argumentPath = Array.isArray(argumentPaths) && argumentPaths.length === 1
          ? argumentPaths[0]
          : undefined;
        const evaluated = argumentPath?.evaluate();
        if (!evaluated?.confident || typeof evaluated.value !== "string") {
          throw path.buildCodeFrameError(
            "PocketJS: dynamic import and require specifiers must be compile-time strings; " +
              "an unresolved specifier could bypass network capability admission.",
          );
        }
        checkSurface(path, evaluated.value, null);
      },
    },
  };
}

function canonicalFile(path: string): string | null {
  if (path === "") return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveFileLikeSpecifier(path: string, resolveDir: string): string | null {
  let candidate: string;
  if (path.startsWith("file:")) {
    try {
      const url = new globalThis.URL(path);
      if (url.protocol !== "file:") return null;
      // Bun treats search/hash as module identity suffixes while loading the
      // same file. Canonicalize the underlying file before applying the
      // private-module policy.
      url.search = "";
      url.hash = "";
      candidate = fileURLToPath(url);
    } catch {
      return null;
    }
  } else {
    if (!isAbsolute(path) && !path.startsWith(".")) return null;
    const suffix = path.search(/[?#]/u);
    candidate = suffix === -1 ? path : path.slice(0, suffix);
  }
  try {
    return Bun.resolveSync(candidate, resolveDir);
  } catch {
    return null;
  }
}

function isNetworkBindingFrameworkSource(path: string): boolean {
  const canonical = canonicalFile(path);
  return canonical !== null && NETWORK_PRIVATE_FRAMEWORK_SOURCES.has(canonical);
}

function isAllowedPrivateNetworkSourceImport(
  target: string,
  importer: string,
): boolean {
  if (importer === NETWORK_PRIVATE_SPECIFIER) {
    return target === NETWORK_V1_BINDING_FRAMEWORK_SOURCE;
  }
  const canonicalImporter = canonicalFile(importer);
  if (target === NETWORK_HTTP_BINDING_FRAMEWORK_SOURCE) {
    return canonicalImporter === NETWORK_HTTP_FRAMEWORK_SOURCE ||
      canonicalImporter === NETWORK_V1_BINDING_FRAMEWORK_SOURCE;
  }
  if (target === NETWORK_LIMITS_FRAMEWORK_SOURCE) {
    return canonicalImporter === NETWORK_INDEX_FRAMEWORK_SOURCE ||
      canonicalImporter === NETWORK_V1_BINDING_FRAMEWORK_SOURCE;
  }
  return false;
}

function isFrameworkSource(path: string): boolean {
  const canonical = canonicalFile(path);
  if (canonical === null) return false;
  const fromRoot = relative(FRAMEWORK_SOURCE_ROOT, canonical);
  return fromRoot !== "" && fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function preparePrivateNetworkFrameworkSource(
  path: string,
  source: string,
  enabled: boolean,
): string {
  void path;
  void enabled;
  return source;
}

function makePrivateNetworkIdentifierGate(
  path: string,
  context: NetworkPrivateBuildContext | undefined,
): PluginObj {
  // Only the compiler-rewritten capture module may name the private slot.
  // Treat every other source path—including an application deliberately
  // placed below framework/src—as untrusted input.
  const frameworkOwned = isNetworkBindingFrameworkSource(path);
  const reservedIdentifiers = context === undefined
    ? undefined
    : new Set([
        NETWORK_BINDING_RESERVED_IDENTIFIER,
        context.takeIdentifier,
        context.bindingIdentifier,
        context.pendingIdentifier,
        context.argumentsIdentifier,
      ]);
  return {
    name: "pocketjs-private-network-identifier",
    visitor: {
      Program(program) {
        if (reservedIdentifiers === undefined || frameworkOwned) return;
        program.traverse({
          Identifier(identifierPath) {
            if (!reservedIdentifiers.has(identifierPath.node.name)) return;
            throw identifierPath.buildCodeFrameError(
              "PocketJS: application source cannot reference the private network binding identifier.",
            );
          },
          ReferencedIdentifier(identifierPath) {
            if (identifierPath.node.name !== "arguments") return;
            const argumentOwner = identifierPath.findParent(
              (parent) => parent.isFunction() && !parent.isArrowFunctionExpression(),
            );
            if (argumentOwner) return;
            throw identifierPath.buildCodeFrameError(
              "PocketJS: top-level application arguments cannot reference the private network binding factory.",
            );
          },
          CallExpression(callPath) {
            if (
              callPath.node.callee.type !== "Identifier" ||
              callPath.node.callee.name !== "eval"
            ) return;
            // Network artifacts contain compiler-owned lexical capture state.
            // Preserve eval of global code while preventing application code
            // from inspecting any surrounding bundler/factory scope.
            callPath.node.callee = {
              type: "SequenceExpression",
              expressions: [
                { type: "NumericLiteral", value: 0 },
                { type: "Identifier", name: "eval" },
              ],
            };
          },
        });
      },
    },
  };
}

async function transformPrivateNetworkJavaScript(
  path: string,
  source: string,
  context: NetworkPrivateBuildContext,
): Promise<string> {
  const transformed = await transformAsync(source, {
    filename: path,
    sourceType: "unambiguous",
    presets: [],
    parserOpts: JSX_PARSER_OPTS,
    plugins: [makePrivateNetworkIdentifierGate(path, context)],
    babelrc: false,
    configFile: false,
    sourceMaps: false,
  });
  if (!transformed?.code && transformed?.code !== "") {
    throw new TypeError(`PocketJS transform produced no output for ${path}`);
  }
  return transformed.code;
}

function privateNetworkModuleSource(context: NetworkPrivateBuildContext): string {
  return `
import { mountNetworkV1HttpBinding } from ${JSON.stringify(NETWORK_V1_BINDING_FRAMEWORK_SOURCE)};
const ${context.bindingIdentifier} = ${context.takeIdentifier}();
mountNetworkV1HttpBinding(${context.bindingIdentifier}, Object.freeze({
  planHashBytes: Object.freeze(${JSON.stringify(context.planHashBytes)}),
  featureIds: Object.freeze(${JSON.stringify(context.featureIds)}),
}));
`;
}

/** Fold only calls proven to reference the public platform import. */
function makeFeatureFolder(features: BuildFeatures): PluginObj {
  return {
    name: "pocketjs-fold-features",
    visitor: {
      Program(program) {
        // Run before the collector's Program visitor so pass 1 and pass 2 see
        // the same target-specialized AST (Babel presets run after plugins).
        program.traverse({
          CallExpression(path) {
            if (path.node.arguments.length !== 1) return;
            const argument = path.node.arguments[0];
            if (argument?.type !== "StringLiteral") return;

            const callee = path.get("callee");
            if (!callee.isIdentifier()) return;
            const binding = path.scope.getBinding(callee.node.name);
            if (!binding?.path.isImportSpecifier()) return;
            const imported = binding.path.node.imported;
            const importedName = imported.type === "Identifier" ? imported.name : imported.value;
            const declaration = binding.path.parentPath;
            if (
              importedName !== "hasFeature" ||
              !declaration?.isImportDeclaration() ||
              declaration.node.source.value !== `${PACKAGE_NAME}/platform`
            ) return;

            path.replaceWith({ type: "BooleanLiteral", value: features[argument.value] === true });
          },
        });
      },
    },
  };
}

function makeCollector(out: Collected, framework: PocketFramework): PluginObj {
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    for (const ch of s) out.textCodepoints.add(ch.codePointAt(0)!);
    if (!seen.has(s)) {
      seen.add(s);
      out.classStrings.push(s);
    }
  };
  return {
    name: "pocketjs-collect",
    visitor: {
      Program: {
        enter(program) {
          program.traverse({
            StringLiteral(path) {
              add(path.node.value);
            },
            TemplateLiteral(path) {
              for (const q of path.node.quasis) add(q.value.cooked ?? q.value.raw);
            },
            JSXText(path) {
              const raw = path.node.extra?.raw;
              if (typeof raw === "string" && raw !== path.node.value) {
                throw path.buildCodeFrameError(
                  "PocketJS: HTML entities in JSX text are not decoded by the JSX renderer - " +
                    'write the literal character (é, ♥) or a string expression {"\\u00e9"} instead.',
                );
              }
              add(path.node.value);
            },
            JSXAttribute(path) {
              const name = path.node.name;
              if (name.type === "JSXIdentifier" && name.name === "classList") {
                throw path.buildCodeFrameError(
                  "PocketJS: `classList` is not supported (v1). Use ternaries of FULL class literals: " +
                    'class={cond() ? "p-2 bg-red-500" : "p-2 bg-slate-700"}',
                );
              }
              if (name.type === "JSXIdentifier" && name.name === "class") {
                const v = path.node.value;
                if (
                  v?.type === "JSXExpressionContainer" &&
                  v.expression.type === "TemplateLiteral" &&
                  v.expression.expressions.length > 0
                ) {
                  throw path.buildCodeFrameError(
                    "PocketJS: template-interpolated class fragments are not supported (v1). " +
                      "Styles compile at build time - use ternaries of FULL literals.",
                  );
                }
              }
            },
            ImportDeclaration(path) {
              if (framework !== "solid") return;
              const src = path.node.source.value;
              if (src !== "solid-js" && !src.startsWith("solid-js/")) return;
              for (const spec of path.node.specifiers) {
                if (spec.type !== "ImportSpecifier") continue;
                const imported =
                  spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
                if (BANNED_SOLID_IMPORTS.has(imported)) {
                  throw path.buildCodeFrameError(
                    `PocketJS: solid-js \`${imported}\` is not supported - the PSP QuickJS host has no ` +
                      "scheduler (no setTimeout/queueMicrotask-driven transitions). Use signals + " +
                      "createEffect, or animate() for motion.",
                  );
                }
              }
            },
          });
        },
      },
    },
  };
}

async function hashKey(
  path: string,
  src: string,
  framework: PocketFramework,
  features: BuildFeatures | undefined,
  privateNetworkEnabled: boolean,
  testOnlyStagedHttpClientFetch: boolean,
  testOnlyStagedHttpsClientFetch: boolean,
): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(
    CACHE_VERSION +
      "\0" +
      (await compilerImplementationHash()) +
      "\0" +
      framework +
      "\0" +
      solidPresetPkg.version +
      "\0" +
      compilerSfcPkg.version +
      "\0" +
      vuePkg.version +
      "\0" +
      vueJsxVaporPkg.version +
      "\0" +
      octanePkg.version +
      "\0" +
      babelCorePkg.version +
      "\0" +
      tsPresetPkg.version +
      "\0" +
      FRAMEWORKS[framework].rendererPath +
      "\0" +
      (features === undefined
        ? "dynamic"
        : JSON.stringify(
            Object.entries(features).sort(([left], [right]) => left.localeCompare(right)),
          )) +
      "\0" +
      (privateNetworkEnabled ? "private-network-v1" : "no-private-network") +
      "\0" +
      (testOnlyStagedHttpClientFetch
        ? "test-only-staged-http-client-fetch"
        : testOnlyStagedHttpsClientFetch
          ? "test-only-staged-https-client-fetch"
          : "staged-network-closed") +
      "\0" +
      path +
      "\0",
  );
  h.update(src);
  return h.digest("hex");
}

interface CacheEntry {
  code: string;
  classStrings: string[];
  textCodepoints: number[];
}

function resolvePackageSubpath(spec: string): string | null {
  if (spec === PACKAGE_NAME) return "";
  if (spec.startsWith(PACKAGE_NAME + "/")) return spec.slice(PACKAGE_NAME.length + 1);
  return null;
}

/**
 * Resolve an `@pocketjs/framework[/…]` import to a module file, or null to
 * let Bun's package.json resolution (or an error) take over. A framework
 * prefix (`vue-vapor/audio`) pins that framework's published alias; a bare
 * subpath resolves through the ACTIVE framework. Both are lookups into the
 * same SUBPATHS-derived table, so an absent `aliases` declaration cannot be
 * bypassed by compiler resolution.
 */
export function packagePath(spec: string, framework: PocketFramework): string | null {
  const subpath = resolvePackageSubpath(spec);
  if (subpath === null) return null;
  for (const fw of POCKET_FRAMEWORKS) {
    if (subpath === fw) {
      return SUBPATHS[""]?.aliases?.includes(fw) ? (RESOLVED[fw][""] ?? null) : null;
    }
    if (subpath.startsWith(fw + "/")) {
      const name = subpath.slice(fw.length + 1);
      return SUBPATHS[name]?.aliases?.includes(fw) ? (RESOLVED[fw][name] ?? null) : null;
    }
  }
  return RESOLVED[framework][subpath] ?? null;
}

export function frameworkVariantPath(path: string, framework: PocketFramework): string {
  if (framework === "solid" || path.includes("/node_modules/") || path.endsWith(".d.ts")) return path;
  const variant = path.replace(/(\.tsx?)$/, `${FRAMEWORKS[framework].outputSuffix}$1`);
  return variant !== path && existsSync(variant) ? variant : path;
}

function transformOptions(framework: PocketFramework) {
  if (framework === "solid") {
    return {
      presets: [
        [solidPreset, { generate: "universal", moduleName: FRAMEWORKS.solid.rendererPath }],
        [tsPreset, {}],
      ],
      parserOpts: JSX_PARSER_OPTS,
    };
  }
  return {
    presets: [[tsPreset, {}]],
    parserOpts: JSX_PARSER_OPTS,
  };
}

export async function transformFile(
  path: string,
  src: string,
  framework: PocketFramework,
  options: {
    features?: BuildFeatures;
    networkPrivate?: NetworkPrivateBuildContext;
  } = {},
): Promise<TransformResult> {
  src = preparePrivateNetworkFrameworkSource(
    path,
    src,
    options.networkPrivate !== undefined,
  );
  const isVueSfc = path.endsWith(".vue");
  if (isVueSfc && framework !== "vue-vapor") {
    throw new Error(
      `PocketJS: ${path} is a Vue SFC and requires framework \"vue-vapor\" ` +
        `(set app.framework in pocket.json or pass --framework=vue-vapor)`,
    );
  }
  const key = await hashKey(
    path,
    src,
    framework,
    options.features,
    options.networkPrivate !== undefined,
    options.networkPrivate?.testOnlyStagedHttpClientFetch === true,
    options.networkPrivate?.testOnlyStagedHttpsClientFetch === true,
  );
  const cacheFile = CACHE_DIR + key + ".json";
  const cached = (await Bun.file(cacheFile).json().catch(() => null)) as CacheEntry | null;
  if (cached && typeof cached.code === "string") {
    return {
      code: cached.code,
      classStrings: cached.classStrings,
      textCodepoints: new Set(cached.textCodepoints),
    };
  }

  if (isVueSfc) {
    const result = compileVueSfc(src, path, { stripTypes: true });
    const collected: Collected = { classStrings: [], textCodepoints: new Set() };
    const transformed = await transformAsync(result.code, {
      filename: path,
      presets: [],
      parserOpts: JSX_PARSER_OPTS,
      plugins: [
        makePrivateNetworkIdentifierGate(path, options.networkPrivate),
        makeNetworkDemandGate(
          options.features,
          options.networkPrivate?.testOnlyStagedHttpClientFetch === true ||
            options.networkPrivate?.testOnlyStagedHttpsClientFetch === true,
        ),
        ...(options.features === undefined ? [] : [makeFeatureFolder(options.features)]),
        makeCollector(collected, framework),
      ],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    if (!transformed?.code && transformed?.code !== "") {
      throw new Error(`PocketJS Vue SFC transform produced no output for ${path}`);
    }
    const entry: CacheEntry = {
      code: transformed.code!,
      classStrings: collected.classStrings,
      textCodepoints: [...collected.textCodepoints],
    };
    await Bun.write(cacheFile, JSON.stringify(entry));
    return {
      code: entry.code,
      classStrings: entry.classStrings,
      textCodepoints: new Set(entry.textCodepoints),
    };
  }

  const collected: Collected = { classStrings: [], textCodepoints: new Set() };
  const opts = transformOptions(framework);
  const plugins = [
    makePrivateNetworkIdentifierGate(path, options.networkPrivate),
    makeNetworkDemandGate(
      options.features,
      options.networkPrivate?.testOnlyStagedHttpClientFetch === true ||
        options.networkPrivate?.testOnlyStagedHttpsClientFetch === true,
    ),
    ...(options.features === undefined ? [] : [makeFeatureFolder(options.features)]),
    makeCollector(collected, framework),
  ];
  let res;
  if (framework === "vue-vapor") {
    await transformAsync(src, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    const vapor = transformVueJsxVapor(src, path, {}, false, false, false);
    res = await transformAsync(vapor.code, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins: options.features === undefined ? [] : [makeFeatureFolder(options.features)],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
  } else if (framework === "octane" && path.endsWith(".tsx")) {
    // Collector pass on the pristine source (classes/text literals), then the
    // Octane compiler lowers JSX + hooks against the pocket universal
    // renderer. Plain .ts modules take the shared TS-preset branch below —
    // Octane hook modules must be .tsx so their call sites get slots.
    await transformAsync(src, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    const compiled = octaneCompile(src, path, {
      mode: "client",
      renderer: OCTANE_RENDERER_DESCRIPTOR,
    }) as { code: string; diagnostics?: readonly unknown[] };
    res =
      options.features === undefined
        ? { code: compiled.code }
        : await transformAsync(compiled.code, {
            filename: path,
            presets: [],
            parserOpts: opts.parserOpts,
            plugins: [makeFeatureFolder(options.features)],
            babelrc: false,
            configFile: false,
            sourceMaps: false,
          });
  } else {
    res = await transformAsync(src, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
  }
  if (!res?.code && res?.code !== "") {
    throw new Error(`PocketJS transform produced no output for ${path}`);
  }

  const entry: CacheEntry = {
    code: res.code!,
    classStrings: collected.classStrings,
    textCodepoints: [...collected.textCodepoints],
  };
  await Bun.write(cacheFile, JSON.stringify(entry));
  return { code: entry.code, classStrings: entry.classStrings, textCodepoints: collected.textCodepoints };
}

export function jsxPlugin(
  framework: PocketFramework,
  opts: {
    entry?: string;
    features?: BuildFeatures;
    generatedStyles?: string;
    networkPrivate?: NetworkPrivateBuildContext;
  } = {},
): BunPlugin {
  return {
    name: `pocketjs-${framework}-jsx`,
    setup(build) {
      // Private installer/capture modules are inaccessible in every artifact
      // mode, including a plain build with no network factory. Resolve the
      // canonical target so absolute paths and symlink aliases are equivalent.
      build.onResolve({ filter: /.*/ }, (args) => {
        const resolved = resolveFileLikeSpecifier(args.path, args.resolveDir);
        if (resolved === null) return undefined;
        const target = canonicalFile(resolved);
        if (target === null) return undefined;
        const publicSpecifier = NETWORK_PUBLIC_FRAMEWORK_SPECIFIER_BY_SOURCE.get(target);
        if (publicSpecifier !== undefined) {
          throw new TypeError(
            `PocketJS: application resolver rejected direct access to ${publicSpecifier}; ` +
              `import the canonical ${publicSpecifier} package surface so capability demand can be verified.`,
          );
        }
        if (!NETWORK_PRIVATE_FRAMEWORK_SOURCES.has(target)) return undefined;
        if (isAllowedPrivateNetworkSourceImport(target, args.importer)) return undefined;
        throw new TypeError(
          "PocketJS: application resolver rejected direct access to a private network binding module.",
        );
      });
      if (opts.networkPrivate !== undefined) {
        const context = opts.networkPrivate;
        if (!opts.entry) {
          throw new TypeError("PocketJS compiler: network factory requires an application entry");
        }
        build.onResolve({ filter: /^pocketjs:network-bootstrap-v1-/ }, (args) => {
          if (args.path !== context.bootstrapSpecifier || args.importer !== "") {
            throw new TypeError(
              "PocketJS: application resolver rejected the private network bootstrap.",
            );
          }
          return { path: context.bootstrapSpecifier, namespace: NETWORK_PRIVATE_NAMESPACE };
        });
        build.onLoad(
          { filter: /.*/, namespace: NETWORK_PRIVATE_NAMESPACE },
          (args) => {
            if (args.path === context.bootstrapSpecifier) {
              return {
                contents:
                  `import ${JSON.stringify(NETWORK_PRIVATE_SPECIFIER)};\n` +
                  `import ${JSON.stringify(opts.entry)};\n`,
                loader: "js",
              };
            }
            if (args.path === NETWORK_PRIVATE_SPECIFIER) {
              return { contents: privateNetworkModuleSource(context), loader: "js" };
            }
            return undefined;
          },
        );
        build.onResolve({ filter: /^pocketjs:internal\// }, (args) => {
          const fromBootstrap =
            args.importer === context.bootstrapSpecifier;
          const fromFrameworkBinding = isNetworkBindingFrameworkSource(args.importer);
          if (
            args.path !== NETWORK_PRIVATE_SPECIFIER ||
            (!fromBootstrap && !fromFrameworkBinding)
          ) {
            throw new TypeError(
              `PocketJS: application resolver rejected private network binding import ${JSON.stringify(args.path)}.`,
            );
          }
          return { path: NETWORK_PRIVATE_SPECIFIER, namespace: NETWORK_PRIVATE_NAMESPACE };
        });
      } else {
        build.onResolve({ filter: /^pocketjs:internal\// }, (args) => {
          throw new TypeError(
            `PocketJS: application resolver rejected private network binding import ${JSON.stringify(args.path)}.`,
          );
        });
      }
      // External applications may have their own node_modules. Resolve both
      // sides of the renderer boundary to PocketJS's browser-mode Solid copy,
      // otherwise identical packages at different paths form two reactive
      // ownership domains and lifecycle hooks silently stop crossing it.
      build.onResolve({ filter: /^solid-js$/ }, () => ({
        path: SOLID_RUNTIME_PATH,
      }));
      build.onResolve({ filter: /^solid-js\/universal$/ }, () => ({
        path: SOLID_UNIVERSAL_RUNTIME_PATH,
      }));
      build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, (args) => {
        const path = packagePath(args.path, framework);
        return path ? { path } : undefined;
      });
      if (framework !== "solid") {
        build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
          let resolved: string;
          try {
            resolved = Bun.resolveSync(args.path, args.resolveDir);
          } catch {
            return undefined;
          }
          const variant = frameworkVariantPath(resolved, framework);
          return variant !== resolved ? { path: variant } : undefined;
        });
      }
      if (framework === "octane" && process.env.POCKETJS_OCTANE_PROFILER !== "1") {
        // Octane's profiler is replaced with a no-op stub in Pocket bundles:
        // its always-on per-render WeakMap bookkeeping pins render graphs
        // under the pinned QuickJS's non-ephemeron weak marking (and costs
        // frame time). See framework/src/octane-profiling-stub.ts.
        build.onResolve({ filter: /^octane\/profiling$/ }, () => ({
          path: OCTANE_PROFILING_STUB_PATH,
        }));
        build.onResolve({ filter: /^\.\/profiling\.js$/ }, (args) =>
          args.importer.includes("/node_modules/octane/dist/")
            ? { path: OCTANE_PROFILING_STUB_PATH }
            : undefined,
        );
      }
      if (framework === "vue-vapor") {
        build.onResolve({ filter: /^vue$/ }, () => ({ path: VUE_VAPOR_RUNTIME_PATH }));
        build.onResolve({ filter: /^\/vue-jsx-vapor\/(?:props|vdom|vapor|ssr)$/ }, (args) => ({
          path: args.path,
          namespace: "vue-vapor-helper",
        }));
        build.onLoad({ filter: /.*/, namespace: "vue-vapor-helper" }, (args) => {
          const contents = VAPOR_HELPERS.get(args.path);
          if (!contents) return undefined;
          return { contents, loader: "js" };
        });
      }
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (args.path.includes("/node_modules/") || args.path.endsWith(".d.ts")) return undefined;
        let src = args.path === GENERATED_STYLES_PATH &&
            opts.generatedStyles !== undefined
          ? opts.generatedStyles
          : await Bun.file(args.path).text();
        if (framework === "vue-vapor" && args.path === opts.entry) {
          src = `import "@pocketjs/framework/prelude";\n${src}`;
        }
        const { code } = await transformFile(args.path, src, framework, {
          features: opts.features,
          networkPrivate: opts.networkPrivate,
        });
        return { contents: code, loader: "js" };
      });
      build.onLoad({ filter: /\.vue$/ }, async (args) => {
        const src = await Bun.file(args.path).text();
        const { code } = await transformFile(args.path, src, framework, {
          features: opts.features,
          networkPrivate: opts.networkPrivate,
        });
        return { contents: code, loader: "js" };
      });
      build.onLoad({ filter: /\.[cm]?jsx?$/ }, async (args) => {
        const context = opts.networkPrivate;
        if (context === undefined || isFrameworkSource(args.path)) return undefined;
        const source = await Bun.file(args.path).text();
        const needsPrivateCheck = !args.path.includes("/node_modules/") ||
          source.includes(context.token) ||
          source.includes(NETWORK_BINDING_RESERVED_IDENTIFIER) ||
          /\b(?:arguments|eval)\b/.test(source) ||
          /\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/.test(source);
        if (!needsPrivateCheck) return undefined;
        const code = await transformPrivateNetworkJavaScript(args.path, source, context);
        return { contents: code, loader: args.path.endsWith("x") ? "jsx" : "js" };
      });
    },
  };
}
