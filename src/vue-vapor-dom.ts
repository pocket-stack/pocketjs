// Minimal DOM facade for Vue Vapor over PocketJS's native tree mirror.

import {
  createCommentNode,
  createElement,
  createTextNode,
  insertNode,
  isNativeNode,
  setProp,
  type NodeMirror,
} from "./native-tree.ts";

interface TemplateLike {
  content: {
    childNodes: NodeMirror[];
    firstChild: NodeMirror | null;
  };
  innerHTML: string;
}

function parseAttrs(raw: string, node: NodeMirror): void {
  const re = /([A-Za-z_:][-A-Za-z0-9_:]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    setProp(node, match[1], value, undefined);
  }
}

function parseTemplateHtml(html: string): NodeMirror[] {
  if (!html) return [];
  if (!html.startsWith("<")) return [createTextNode(html)];
  const match = html.match(/^<([A-Za-z][A-Za-z0-9_-]*)([^>]*)>([\s\S]*)$/);
  if (!match) return [createTextNode(html)];
  const [, tag, attrs, rest] = match;
  const node = createElement(tag.toLowerCase());
  parseAttrs(attrs, node);
  const text = rest.replace(new RegExp(`</${tag}>$`, "i"), "");
  if (text) insertNode(node, createTextNode(text));
  return [node];
}

function createTemplate(): TemplateLike {
  const content = {
    childNodes: [] as NodeMirror[],
    get firstChild() {
      return this.childNodes[0] ?? null;
    },
  };
  let current = "";
  return {
    content,
    get innerHTML() {
      return current;
    },
    set innerHTML(value: string) {
      current = value;
      content.childNodes = parseTemplateHtml(value);
    },
  };
}

function makeDomClass(predicate: (value: unknown) => boolean): unknown {
  return class {
    static [Symbol.hasInstance](value: unknown): boolean {
      return predicate(value);
    }
  };
}

export function installVueVaporDom(): void {
  const g = globalThis as unknown as {
    document?: unknown;
    Node?: unknown;
    Element?: unknown;
    HTMLElement?: unknown;
    Text?: unknown;
    Comment?: unknown;
    window?: unknown;
  };

  if (!g.Node) g.Node = makeDomClass(isNativeNode);
  if (!g.Element) g.Element = makeDomClass((value) => isNativeNode(value) && value.domNodeType === 1);
  if (!g.HTMLElement) g.HTMLElement = g.Element;
  if (!g.Text) g.Text = makeDomClass((value) => isNativeNode(value) && value.domNodeType === 3);
  if (!g.Comment) g.Comment = makeDomClass((value) => isNativeNode(value) && value.domNodeType === 8);
  if (!g.window) g.window = globalThis;

  if (!g.document) {
    g.document = {
      createElement(tag: string) {
        return tag === "template" ? createTemplate() : createElement(tag.toLowerCase());
      },
      createElementNS(_ns: string, tag: string) {
        return createElement(tag.toLowerCase());
      },
      createTextNode(value = "") {
        return createTextNode(value);
      },
      createComment(value = "") {
        return createCommentNode(value);
      },
      querySelector() {
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }
}
