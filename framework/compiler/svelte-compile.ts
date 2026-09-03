/** Compile a Svelte component against Svelte's custom-renderer API. */

import { compile, compileModule, parse } from "svelte/compiler";

/** Baked into every component as `import $renderer from ...` (see below). */
export const SVELTE_RENDERER_MODULE = "@pocketjs/framework/svelte/renderer";

const BANNED_IMPORTS = new Map([
  ["svelte/motion", "animate() from @pocketjs/framework/svelte/animation"],
  ["svelte/transition", "animate() from @pocketjs/framework/svelte/animation"],
  ["svelte/animate", "animate() from @pocketjs/framework/svelte/animation"],
  ["svelte/legacy", "runes"],
]);

interface Node {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

function where(source: string, filename: string, start: number | undefined): string {
  if (start === undefined) return filename;
  const upto = source.slice(0, start);
  const line = upto.split("\n").length;
  return `${filename}:${line}:${start - upto.lastIndexOf("\n")}`;
}

function fail(source: string, filename: string, node: Node | undefined, message: string): never {
  throw new Error(`PocketJS: ${message} (${where(source, filename, node?.start)})`);
}

/** `class="a"` is one Text; `class={x}` one ExpressionTag; `class="a {x}"` both. */
function attributeValues(value: unknown): Node[] {
  if (value === true || value == null) return [];
  return (Array.isArray(value) ? value : [value]) as Node[];
}

function checkClassExpression(source: string, filename: string, node: Node, expression: Node): void {
  if (expression.type === "ConditionalExpression") {
    checkClassExpression(source, filename, node, expression.consequent as Node);
    checkClassExpression(source, filename, node, expression.alternate as Node);
    return;
  }
  if (expression.type === "TemplateLiteral" && (expression.expressions as unknown[]).length > 0) {
    fail(
      source,
      filename,
      node,
      "template-interpolated class fragments aren't supported. Styles compile at build time — " +
        "use ternaries of FULL literals",
    );
  }
  if (expression.type === "ObjectExpression" || expression.type === "ArrayExpression") {
    fail(
      source,
      filename,
      node,
      "object and array class values aren't supported. Use ternaries of FULL class literals: " +
        'class={on ? "p-2 bg-red-500" : "p-2 bg-slate-700"}',
    );
  }
}

function checkAttributes(source: string, filename: string, element: Node): void {
  for (const attribute of (element.attributes ?? []) as Node[]) {
    if (attribute.type === "ClassDirective") {
      fail(
        source,
        filename,
        attribute,
        "`class:` directives aren't supported. The class table compiles at build time — " +
          "use ternaries of FULL class literals",
      );
    }
    if (attribute.type === "StyleDirective") {
      fail(
        source,
        filename,
        attribute,
        "`style:` directives aren't supported. Pass a style object to the component instead " +
          "(<View style={{ width: 10 }} />)",
      );
    }
    if (attribute.type !== "Attribute") continue;

    if (attribute.name === "style") {
      fail(
        source,
        filename,
        attribute,
        "a `style` attribute is CSS text, which the native tree has no parser for. " +
          "Pass a style object to the component instead (<View style={{ width: 10 }} />)",
      );
    }
    if (attribute.name !== "class") continue;

    const values = attributeValues(attribute.value);
    if (values.length > 1) {
      fail(
        source,
        filename,
        attribute,
        "interpolated class fragments aren't supported. Styles compile at build time — " +
          "use ternaries of FULL literals",
      );
    }
    for (const value of values) {
      if (value.type === "ExpressionTag") {
        checkClassExpression(source, filename, attribute, value.expression as Node);
      }
    }
  }
}

function walkFragment(source: string, filename: string, nodes: readonly Node[]): void {
  for (const node of nodes) {
    if (node.type === "RegularElement" || node.type === "SvelteElement") {
      checkAttributes(source, filename, node);
    }
    const fragment = node.fragment as { nodes?: Node[] } | undefined;
    if (fragment?.nodes) walkFragment(source, filename, fragment.nodes);
    for (const key of ["consequent", "alternate", "body", "pending", "then", "catch"] as const) {
      const branch = node[key] as { nodes?: Node[] } | undefined;
      if (branch?.nodes) walkFragment(source, filename, branch.nodes);
    }
  }
}

function checkImports(source: string, filename: string, script: unknown): void {
  const body = (script as { content?: { body?: Node[] } } | undefined)?.content?.body;
  if (!body) return;
  for (const node of body) {
    if (node.type !== "ImportDeclaration") continue;
    const specifier = (node.source as { value?: string } | undefined)?.value;
    const replacement = specifier === undefined ? undefined : BANNED_IMPORTS.get(specifier);
    if (replacement === undefined) continue;
    fail(
      source,
      filename,
      node,
      `\`${specifier}\` isn't supported — the QuickJS host has no requestAnimationFrame or ` +
        `performance.now. Use ${replacement}`,
    );
  }
}

/**
 * Compile the PocketJS component subset.
 *
 * Svelte owns the reactivity and template lowering and emits calls against the
 * renderer module named below, which the compiler's `@pocketjs/framework`
 * resolver points at framework/src/renderer-svelte.ts. Static classes and text
 * survive as ordinary string literals in that output, so the shared pass-1 AST
 * collector sees them with no template-specific walk here.
 *
 * `bind:` on elements, `<svelte:window|document|body|head>`, transitions and
 * `{@html}` are refused by Svelte itself under a custom renderer; the lints
 * here add the PocketJS rules on top.
 */
export function compileSvelte(source: string, filename: string): { code: string } {
  const ast = parse(source, { modern: true, filename });
  if (ast.css) {
    fail(
      source,
      filename,
      ast.css as unknown as Node,
      "<style> blocks aren't supported; use PocketJS class literals or a style object",
    );
  }
  checkImports(source, filename, ast.instance);
  checkImports(source, filename, ast.module);
  walkFragment(source, filename, ast.fragment.nodes as unknown as Node[]);

  const compiled = compile(source, {
    filename,
    generate: "client",
    runes: true,
    css: "external",
    dev: false,
    // Nothing reads globalThis.__svelte on a handheld.
    discloseVersion: false,
    experimental: { customRenderer: SVELTE_RENDERER_MODULE },
  });
  return { code: compiled.js.code };
}

/**
 * Compile a `.svelte.ts` runes module. `compileModule` does not strip types, so
 * that happens first.
 */
export function compileSvelteModule(source: string, filename: string): { code: string } {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const compiled = compileModule(js, { filename, generate: "client", dev: false });
  return { code: compiled.js.code };
}

if (import.meta.main) {
  const filename = process.argv[2];
  if (!filename) {
    console.error("usage: bun compiler/svelte-compile.ts <Component.svelte>");
    process.exit(1);
  }
  const source = await Bun.file(filename).text();
  const result = filename.endsWith(".svelte")
    ? compileSvelte(source, filename)
    : compileSvelteModule(source, filename);
  console.log(result.code);
}
