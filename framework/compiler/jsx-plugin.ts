// Framework-aware pass-1 Babel transform + AST collection.

import { transformAsync, type PluginObj } from "@babel/core";
import type { ParserOptions } from "@babel/parser";
import solidPreset from "babel-preset-solid";
import tsPreset from "@babel/preset-typescript"; // untyped - see framework/compiler/ambient.d.ts
import { transformVueJsxVapor } from "vue-jsx-vapor/api";
import { existsSync } from "node:fs";
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
import solidPresetPkg from "babel-preset-solid/package.json";
import compilerSfcPkg from "@vue/compiler-sfc/package.json";
import vuePkg from "vue/package.json";
import vueJsxVaporPkg from "vue-jsx-vapor/package.json";
import babelCorePkg from "@babel/core/package.json";
import tsPresetPkg from "@babel/preset-typescript/package.json";
import type { PocketFramework } from "../src/config.ts";

export type { PocketFramework };

export const RENDERER_PATH = new URL("../src/renderer.ts", import.meta.url).pathname;
export const RENDERER_SOLID_PATH = new URL("../src/renderer-solid.ts", import.meta.url).pathname;
export const RENDERER_VUE_VAPOR_PATH = new URL("../src/renderer-vue-vapor.ts", import.meta.url).pathname;

const INDEX_PATH = new URL("../src/index.ts", import.meta.url).pathname;
const INDEX_VUE_VAPOR_PATH = new URL("../src/index-vue-vapor.ts", import.meta.url).pathname;
const ANIMATION_PATH = new URL("../src/animation.ts", import.meta.url).pathname;
const COMPONENTS_PATH = new URL("../src/components.ts", import.meta.url).pathname;
const COMPONENTS_VUE_VAPOR_PATH = new URL("../src/components-vue-vapor.ts", import.meta.url).pathname;
const CONFIG_PATH = new URL("../src/config.ts", import.meta.url).pathname;
const GESTURE_PATH = new URL("../src/gesture.ts", import.meta.url).pathname;
const INPUT_API_PATH = new URL("../src/input-api.ts", import.meta.url).pathname;
const KINETICS_PATH = new URL("../src/kinetics.ts", import.meta.url).pathname;
const LAUNCHER_PATH = new URL("../src/launcher.ts", import.meta.url).pathname;
const LIFECYCLE_PATH = new URL("../src/lifecycle.ts", import.meta.url).pathname;
const LIFECYCLE_VUE_VAPOR_PATH = new URL("../src/lifecycle-vue-vapor.ts", import.meta.url).pathname;
const OSK_PATH = new URL("../src/osk.tsx", import.meta.url).pathname;
const PLATFORM_PATH = new URL("../src/platform.ts", import.meta.url).pathname;
const PRELUDE_PATH = new URL("../src/prelude.ts", import.meta.url).pathname;
const VUE_VAPOR_RUNTIME_PATH = new URL(
  "../../node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.prod.js",
  import.meta.url,
).pathname;

const PACKAGE_NAME = "@pocketjs/framework";
const CACHE_DIR = new URL("../../.cache/transforms/", import.meta.url).pathname;
const CACHE_VERSION = "2";
const JSX_PARSER_OPTS: ParserOptions = { plugins: ["jsx"] };

const BANNED_SOLID_IMPORTS = new Set(["createResource", "useTransition", "startTransition"]);

export const FRAMEWORKS: Record<
  PocketFramework,
  {
    label: string;
    outputSuffix: string;
    rendererPath: string;
    rootPath: string;
    subpaths: Record<string, string>;
  }
> = {
  solid: {
    label: "Solid",
    outputSuffix: "",
    rendererPath: RENDERER_SOLID_PATH,
    rootPath: INDEX_PATH,
    subpaths: {
      "": INDEX_PATH,
      animation: ANIMATION_PATH,
      components: COMPONENTS_PATH,
      config: CONFIG_PATH,
      gesture: GESTURE_PATH,
      input: INPUT_API_PATH,
      kinetics: KINETICS_PATH,
      launcher: LAUNCHER_PATH,
      lifecycle: LIFECYCLE_PATH,
      // The system OSK carries class literals and key-cap glyphs, so pass 1
      // must walk it (this map lists the framework modules the collector
      // follows — pure-logic modules like host/clock stay out).
      osk: OSK_PATH,
      platform: PLATFORM_PATH,
      prelude: PRELUDE_PATH,
      renderer: RENDERER_SOLID_PATH,
    },
  },
  "vue-vapor": {
    label: "Vue Vapor",
    outputSuffix: ".vue-vapor",
    rendererPath: RENDERER_VUE_VAPOR_PATH,
    rootPath: INDEX_VUE_VAPOR_PATH,
    subpaths: {
      "": INDEX_VUE_VAPOR_PATH,
      animation: ANIMATION_PATH,
      components: COMPONENTS_VUE_VAPOR_PATH,
      config: CONFIG_PATH,
      input: INPUT_API_PATH,
      launcher: LAUNCHER_PATH,
      lifecycle: LIFECYCLE_VUE_VAPOR_PATH,
      platform: PLATFORM_PATH,
      prelude: PRELUDE_PATH,
      renderer: RENDERER_VUE_VAPOR_PATH,
    },
  },
};

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
  if (value === "solid" || value === "vue-vapor") return value;
  throw new Error(`PocketJS ${source}: framework must be "solid" or "vue-vapor"`);
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
): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(
    CACHE_VERSION +
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

function publicSubpath(spec: string, framework: PocketFramework): string | null {
  const subpath = resolvePackageSubpath(spec);
  if (subpath === null) return null;
  if (subpath === "solid") return "";
  if (subpath.startsWith("solid/")) return subpath.slice("solid/".length);
  if (subpath === "vue-vapor") return "";
  if (subpath.startsWith("vue-vapor/")) return subpath.slice("vue-vapor/".length);
  return subpath;
}

export function packagePath(spec: string, framework: PocketFramework): string | null {
  const subpath = publicSubpath(spec, framework);
  if (subpath === null) return null;
  if (spec === `${PACKAGE_NAME}/solid` || spec.startsWith(`${PACKAGE_NAME}/solid/`)) {
    return FRAMEWORKS.solid.subpaths[subpath] ?? null;
  }
  if (spec === `${PACKAGE_NAME}/vue-vapor` || spec.startsWith(`${PACKAGE_NAME}/vue-vapor/`)) {
    return FRAMEWORKS["vue-vapor"].subpaths[subpath] ?? null;
  }
  return FRAMEWORKS[framework].subpaths[subpath] ?? null;
}

export function frameworkVariantPath(path: string, framework: PocketFramework): string {
  if (framework !== "vue-vapor" || path.includes("/node_modules/") || path.endsWith(".d.ts")) return path;
  const variant = path.replace(/(\.tsx?)$/, ".vue-vapor$1");
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
  options: { features?: BuildFeatures } = {},
): Promise<TransformResult> {
  const isVueSfc = path.endsWith(".vue");
  if (isVueSfc && framework !== "vue-vapor") {
    throw new Error(
      `PocketJS: ${path} is a Vue SFC and requires framework \"vue-vapor\" ` +
        `(set app.framework in pocket.json or pass --framework=vue-vapor)`,
    );
  }
  const key = await hashKey(path, src, framework, options.features);
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
  opts: { entry?: string; features?: BuildFeatures } = {},
): BunPlugin {
  return {
    name: `pocketjs-${framework}-jsx`,
    setup(build) {
      build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, (args) => {
        const path = packagePath(args.path, framework);
        return path ? { path } : undefined;
      });
      if (framework === "vue-vapor") {
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
        let src = await Bun.file(args.path).text();
        if (framework === "vue-vapor" && args.path === opts.entry) {
          src = `import "@pocketjs/framework/prelude";\n${src}`;
        }
        const { code } = await transformFile(args.path, src, framework, { features: opts.features });
        return { contents: code, loader: "js" };
      });
      build.onLoad({ filter: /\.vue$/ }, async (args) => {
        const src = await Bun.file(args.path).text();
        const { code } = await transformFile(args.path, src, framework, { features: opts.features });
        return { contents: code, loader: "js" };
      });
    },
  };
}
