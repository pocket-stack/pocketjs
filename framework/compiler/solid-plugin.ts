// framework/compiler/solid-plugin.ts — pass-1 babel transform + AST collection.
//
// transformFile(path, src) runs babel-preset-solid {generate:'universal',
// moduleName:<ABSOLUTE framework/src/renderer.ts>} + @babel/preset-typescript over one
// .tsx/.ts source and, IN THE SAME TRAVERSAL, collects:
//   - candidate class strings: every StringLiteral value, every
//     TemplateLiteral quasi, and every JSXText chunk [R] — never regex over
//     quotes. tailwind.ts decides later which candidates are style literals.
//   - text codepoints: every codepoint of the same literals (charset input
//     for bake-font.ts).
//
// Lints (throw with a code frame, per docs/DESIGN.md "loud errors"):
//   - `classList` JSX attribute (unsupported v1),
//   - template-interpolated `class` fragments (class={`a ${b}`}),
//   - importing createResource / useTransition / startTransition from
//     solid-js (QuickJS has no scheduler — off-limits on PSP).
//
// Results are cached in .cache/transforms/ keyed by content hash, so pass 2
// (the Bun.build plugin below) serves the exact pass-1 output for free.

import { transformAsync, type PluginObj } from "@babel/core";
import solidPreset from "babel-preset-solid"; // untyped — see framework/compiler/ambient.d.ts
import tsPreset from "@babel/preset-typescript"; // untyped — see framework/compiler/ambient.d.ts
import type { BunPlugin } from "bun";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
// Toolchain identity for the transform cache key: a preset/babel upgrade must
// invalidate cached output (CACHE_VERSION only covers changes to THIS file).
import solidPresetPkg from "babel-preset-solid/package.json";
import babelCorePkg from "@babel/core/package.json";
import tsPresetPkg from "@babel/preset-typescript/package.json";

const resolveLocalPath = (rel: string) => resolve(fileURLToPath(new URL(rel, import.meta.url)));

export const RENDERER_PATH = resolveLocalPath("../src/renderer.ts");
const INDEX_PATH = resolveLocalPath("../src/index.ts");
const ANIMATION_PATH = resolveLocalPath("../src/animation.ts");
const COMPONENTS_PATH = resolveLocalPath("../src/components.ts");
const INPUT_API_PATH = resolveLocalPath("../src/input-api.ts");
const LIFECYCLE_PATH = resolveLocalPath("../src/lifecycle.ts");
const PACKAGE_NAME = "@pocketjs/framework";

const CACHE_DIR = resolveLocalPath("../../.cache/transforms/");
/** Bump to invalidate every cached transform (changes to this file's
 *  collector/lints/options — dependency versions are hashed separately). */
const CACHE_VERSION = "7";

const BANNED_SOLID_IMPORTS = new Set(["createResource", "useTransition", "startTransition"]);

export interface TransformResult {
  /** ESM JS: JSX compiled to createElement/insertNode/... imports from RENDERER_PATH. */
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

function makeCollector(out: Collected): PluginObj {
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    for (const ch of s) out.textCodepoints.add(ch.codePointAt(0)!);
    if (!seen.has(s)) {
      seen.add(s);
      out.classStrings.push(s);
    }
  };
  // Everything happens in ONE pre-traversal from Program.enter: plugin
  // visitors merge with the solid preset's, which replaces whole JSX subtrees
  // before a plain JSXAttribute/StringLiteral visitor would descend into
  // them — and the replacement output would pollute the collection with its
  // own synthetic literals ("view", the renderer path...). Traversing the
  // pristine AST up front sees exactly what the author wrote.
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
            // JSX text compiles to template literals later [R]; here it is
            // still JSXText — same characters, collected directly.
            JSXText(path) {
              // babel-preset-solid's universal codegen emits the RAW source
              // text, so HTML entities would render literally on screen while
              // this collector sees the parser-decoded value. Loud error per
              // the module contract (raw !== value iff entities appeared —
              // after stripping \r, which Babel normalizes out of value but
              // not raw on CRLF checkouts).
              let raw = path.node.extra?.raw;
              let val = path.node.value;
              if (typeof raw === "string") {
                raw = raw.replace(/\r/g, "");
                val = val.replace(/\r/g, "");
                if (raw !== val) {
                  throw path.buildCodeFrameError(
                    "PocketJS: HTML entities in JSX text are not decoded by the universal " +
                      'renderer — write the literal character (é, ♥) or a string expression {"\\u00e9"} instead.',
                  );
                }
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
                      "Styles compile at build time — use ternaries of FULL literals.",
                  );
                }
              }
            },
            ImportDeclaration(path) {
              const src = path.node.source.value;
              if (src !== "solid-js" && !src.startsWith("solid-js/")) return;
              for (const spec of path.node.specifiers) {
                if (spec.type !== "ImportSpecifier") continue;
                const imported =
                  spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
                if (BANNED_SOLID_IMPORTS.has(imported)) {
                  throw path.buildCodeFrameError(
                    `PocketJS: solid-js \`${imported}\` is not supported — the PSP QuickJS host has no ` +
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

async function hashKey(path: string, src: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(
    CACHE_VERSION +
      "\0" +
      solidPresetPkg.version +
      "\0" +
      babelCorePkg.version +
      "\0" +
      tsPresetPkg.version +
      "\0" +
      RENDERER_PATH +
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

function packagePath(spec: string): string | null {
  switch (resolvePackageSubpath(spec)) {
    case "":
      return INDEX_PATH;
    case "animation":
      return ANIMATION_PATH;
    case "components":
      return COMPONENTS_PATH;
    case "input":
      return INPUT_API_PATH;
    case "lifecycle":
      return LIFECYCLE_PATH;
    default:
      return null;
  }
}

/**
 * Transform one source file (content-hash cached). Throws on lint violations
 * and syntax errors; the error message carries file + code frame.
 */
export async function transformFile(path: string, src: string): Promise<TransformResult> {
  const key = await hashKey(path, src);
  const cacheFile = join(CACHE_DIR, key + ".json");
  const cached = (await Bun.file(cacheFile).json().catch(() => null)) as CacheEntry | null;
  if (cached && typeof cached.code === "string") {
    return {
      code: cached.code,
      classStrings: cached.classStrings,
      textCodepoints: new Set(cached.textCodepoints),
    };
  }

  const collected: Collected = { classStrings: [], textCodepoints: new Set() };
  const res = await transformAsync(src, {
    filename: path,
    // presets run last-to-first: preset-typescript strips types first, then
    // babel-preset-solid compiles JSX [R]. parserOpts enables JSX parsing
    // without the removed Babel 8 isTSX/allExtensions preset options.
    presets: [
      [solidPreset, { generate: "universal", moduleName: RENDERER_PATH }],
      [tsPreset, {}],
    ],
    parserOpts: { plugins: ["jsx"] },
    plugins: [makeCollector(collected)],
    babelrc: false,
    configFile: false,
    sourceMaps: false,
  });
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

/**
 * Pass-2 Bun.build plugin: serves the (cached) pass-1 transform for every
 * project .ts/.tsx module, so the bundle is built from EXACTLY the code the
 * class/charset scan saw. node_modules and .d.ts files fall through to Bun.
 */
export function solidUniversalPlugin(): BunPlugin {
  return {
    name: "pocketjs-solid-universal",
    setup(build) {
      build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, (args) => {
        const path = packagePath(args.path);
        return path ? { path } : undefined;
      });
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (args.path.includes("/node_modules/") || args.path.endsWith(".d.ts")) return undefined;
        const src = await Bun.file(args.path).text();
        const { code } = await transformFile(args.path, src);
        return { contents: code, loader: "js" };
      });
    },
  };
}
