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

describe("Vue Vapor guest DOM", () => {
  test("uses a Pocket document without replacing an existing browser document", () => {
    let nextId = 2;
    installHost({
      kind: "injected",
      target: "test",
      strict: true,
      ops: {
        createNode: () => nextId++,
        setText() {},
      } as unknown as HostOps,
    });

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
});
