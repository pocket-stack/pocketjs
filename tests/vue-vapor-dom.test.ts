import { afterEach, describe, expect, test } from "bun:test";

import { installHost, type HostOps } from "../framework/src/host.ts";
import { isNativeNode } from "../framework/src/native-tree.ts";
import { installVueVaporDom } from "../framework/src/vue-vapor-dom.ts";

const g = globalThis as Record<string, unknown>;
const domGlobals = [
  "document",
  "window",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Comment",
  "__pocketDocument",
] as const;
const originals = new Map(domGlobals.map((name) => [name, g[name]]));

afterEach(() => {
  for (const name of domGlobals) {
    const original = originals.get(name);
    if (original === undefined) delete g[name];
    else g[name] = original;
  }
});

function installStubHost(): void {
  let nextId = 2;
  installHost({
    kind: "injected",
    target: "test",
    strict: true,
    ops: {
      createNode: () => nextId++,
      setText() {},
      insertBefore() {},
    } as unknown as HostOps,
  });
}

interface TemplateStub {
  innerHTML: string;
  content: {
    childNodes: { domNodeType?: number; domData?: string; text?: string; domTag?: string }[];
    firstChild: { domNodeType?: number; domData?: string; text?: string } | null;
  };
}

function parseTemplate(html: string): TemplateStub["content"] {
  const pocketDocument = g.__pocketDocument as {
    createElement(tag: string): TemplateStub;
  };
  const template = pocketDocument.createElement("template");
  template.innerHTML = html;
  return template.content;
}

describe("Vue Vapor guest DOM", () => {
  test("uses a Pocket document without replacing an existing browser document", () => {
    installStubHost();

    const browserDocument = { kind: "browser-document" };
    g.document = browserDocument;
    installVueVaporDom();

    expect(g.document).toBe(browserDocument);
    expect(g.__pocketDocument).not.toBe(browserDocument);

    const pocketDocument = g.__pocketDocument as {
      createTextNode(value: string): unknown;
    };
    const text = pocketDocument.createTextNode("PAUSED") as { text?: string; children?: unknown[] };
    expect(isNativeNode(text)).toBe(true);
    expect(text.text).toBe("PAUSED");
    expect(text.children).toEqual([]);
  });

  test("parses template comments as comment nodes, never literal text", () => {
    installStubHost();
    installVueVaporDom();

    const node = parseTemplate("<!-- comment -->").firstChild;
    expect(node).not.toBeNull();
    expect(node!.domNodeType).toBe(8);
    expect(node!.domData).toBe(" comment ");
    expect(node!.text).toBe("");
  });

  test("keeps parsing past a comment instead of falling back to text", () => {
    installStubHost();
    installVueVaporDom();

    expect(parseTemplate("<!-- a --><!-- b -->").childNodes.map((node) => node.domData))
      .toEqual([" a ", " b "]);

    const [comment, element] = parseTemplate("<!-- lead --><view>hi</view>").childNodes;
    expect(comment.domNodeType).toBe(8);
    expect(comment.domData).toBe(" lead ");
    expect(element.domNodeType).toBe(1);
    expect(element.domTag).toBe("view");
  });
});
