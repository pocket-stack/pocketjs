// vapor/oracle/dom.ts — a micro-DOM for running real Vue Vapor in bun.
//
// Vue Vapor's compiled output talks to `document` (rewritten at bundle time
// to globalThis.__vaporDocument) and to a handful of Node members. This is
// the smallest tree that satisfies it: elements/text/comments, template
// materialization for hoisted static HTML, and attribute storage. The grid
// painter (paint.ts) interprets <row> elements from this tree; nothing here
// knows about cells or palettes. Modeled on framework/src/vue-vapor-dom.ts, minus the
// native HostOps mirror.

export class VaporNode {
  parent: VaporElement | null = null;
  get parentNode(): VaporElement | null {
    return this.parent;
  }
  get isConnected(): boolean {
    let node: VaporNode | null = this;
    while (node) {
      if (node instanceof VaporElement && node.isRoot) return true;
      node = node.parent;
    }
    return false;
  }
  get nextSibling(): VaporNode | null {
    if (!this.parent) return null;
    const siblings = this.parent.children;
    const index = siblings.indexOf(this);
    return index >= 0 ? (siblings[index + 1] ?? null) : null;
  }
  get previousSibling(): VaporNode | null {
    if (!this.parent) return null;
    const siblings = this.parent.children;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }
  cloneNode(_deep = false): VaporNode {
    throw new Error("cloneNode on abstract node");
  }
}

export class VaporText extends VaporNode {
  constructor(public text: string) {
    super();
  }
  get nodeType(): number {
    return 3;
  }
  get nodeName(): string {
    return "#text";
  }
  get data(): string {
    return this.text;
  }
  set data(value: string) {
    this.text = String(value ?? "");
  }
  get nodeValue(): string {
    return this.text;
  }
  set nodeValue(value: string) {
    this.text = String(value ?? "");
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(value: string) {
    this.text = String(value ?? "");
  }
  override cloneNode(_deep = false): VaporText {
    return new VaporText(this.text);
  }
}

export class VaporComment extends VaporNode {
  constructor(public text: string) {
    super();
  }
  get nodeType(): number {
    return 8;
  }
  get nodeName(): string {
    return "#comment";
  }
  get data(): string {
    return this.text;
  }
  set data(value: string) {
    this.text = String(value ?? "");
  }
  get nodeValue(): string {
    return this.text;
  }
  set nodeValue(value: string) {
    this.text = String(value ?? "");
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(value: string) {
    this.text = String(value ?? "");
  }
  override cloneNode(_deep = false): VaporComment {
    return new VaporComment(this.text);
  }
}

export class VaporElement extends VaporNode {
  children: VaporNode[] = [];
  attrs = new Map<string, string>();
  isRoot = false;
  constructor(public tag: string) {
    super();
  }
  get nodeType(): number {
    return 1;
  }
  get nodeName(): string {
    return this.tag.toUpperCase();
  }
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get childNodes(): VaporNode[] {
    return this.children;
  }
  get firstChild(): VaporNode | null {
    return this.children[0] ?? null;
  }
  get lastChild(): VaporNode | null {
    return this.children[this.children.length - 1] ?? null;
  }
  appendChild(child: VaporNode): VaporNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: VaporNode, anchor?: VaporNode | null): VaporNode {
    if (child === anchor) return child; // DOM: inserting before itself is a no-op
    if (child.parent) child.parent.removeChild(child);
    if (anchor) {
      const index = this.children.indexOf(anchor);
      if (index < 0) throw new Error("insertBefore: anchor is not a child");
      this.children.splice(index, 0, child);
    } else {
      this.children.push(child);
    }
    child.parent = this;
    return child;
  }
  removeChild(child: VaporNode): VaporNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  replaceChild(newChild: VaporNode, oldChild: VaporNode): VaporNode {
    const index = this.children.indexOf(oldChild);
    if (index < 0) throw new Error("replaceChild: old node is not a child");
    if (newChild.parent) newChild.parent.removeChild(newChild);
    this.children[index] = newChild;
    newChild.parent = this;
    oldChild.parent = null;
    return oldChild;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  setAttribute(name: string, value: unknown): void {
    if (value === false || value == null) this.attrs.delete(name);
    else this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  get textContent(): string {
    let out = "";
    for (const child of this.children) {
      if (child instanceof VaporText) out += child.text;
      else if (child instanceof VaporElement) out += child.textContent;
    }
    return out;
  }
  set textContent(value: string) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    const text = String(value ?? "");
    if (text) this.appendChild(new VaporText(text));
  }
  override cloneNode(deep = false): VaporElement {
    const copy = new VaporElement(this.tag);
    for (const [key, val] of this.attrs) copy.attrs.set(key, val);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

// ---- template HTML materialization ------------------------------------------
// vue-jsx-vapor hoists static JSX into template("<row ...>text</row><!>...")
// strings. This parser covers exactly that emitted subset: a sibling sequence
// of elements (text-or-nested children), bare text, and <!> comment anchors.

function parseAttrString(raw: string, node: VaporElement): void {
  const re = /([A-Za-z_:][-A-Za-z0-9_:]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    node.attrs.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
  }
}

export function parseTemplateHtml(html: string): VaporNode[] {
  const nodes: VaporNode[] = [];
  let rest = html;
  while (rest.length > 0) {
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end < 0) throw new Error(`unterminated comment in template: ${html}`);
      nodes.push(new VaporComment(rest.slice(4, end)));
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith("<!>")) {
      nodes.push(new VaporComment(""));
      rest = rest.slice(3);
      continue;
    }
    if (rest.startsWith("<")) {
      const open = rest.match(/^<([A-Za-z][A-Za-z0-9_-]*)([^>]*?)(\/?)>/);
      if (!open) throw new Error(`unparseable template tag: ${rest.slice(0, 40)}`);
      const [prefix, tag, attrs, selfClose] = open;
      const el = new VaporElement(tag.toLowerCase());
      parseAttrString(attrs, el);
      rest = rest.slice(prefix.length);
      if (!selfClose) {
        // vue-jsx-vapor emits HTML5-minimized templates: a final element's
        // closing tag is omitted, so "no close tag" means "rest is children".
        const close = `</${tag}>`;
        const end = rest.toLowerCase().indexOf(close.toLowerCase());
        const inner = end < 0 ? rest : rest.slice(0, end);
        for (const child of parseTemplateHtml(inner)) el.appendChild(child);
        rest = end < 0 ? "" : rest.slice(end + close.length);
      }
      nodes.push(el);
      continue;
    }
    const next = rest.indexOf("<");
    const text = next < 0 ? rest : rest.slice(0, next);
    nodes.push(new VaporText(text));
    rest = next < 0 ? "" : rest.slice(next);
  }
  return nodes;
}

class VaporTemplate {
  content: { childNodes: VaporNode[]; firstChild: VaporNode | null };
  private html = "";
  constructor() {
    this.content = { childNodes: [], firstChild: null };
  }
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    const nodes = parseTemplateHtml(value);
    this.content = { childNodes: nodes, firstChild: nodes[0] ?? null };
  }
}

// ---- document ----------------------------------------------------------------

function createVaporDocument() {
  return {
    createElement(tag: string): VaporTemplate | VaporElement {
      return tag === "template" ? new VaporTemplate() : new VaporElement(tag.toLowerCase());
    },
    createElementNS(_ns: string, tag: string): VaporElement {
      return new VaporElement(tag.toLowerCase());
    },
    createTextNode(value = ""): VaporText {
      return new VaporText(String(value));
    },
    createComment(value = ""): VaporComment {
      return new VaporComment(String(value));
    },
    querySelector(): null {
      return null;
    },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
}

export type VaporDocument = ReturnType<typeof createVaporDocument>;

/** Install the micro-DOM globals the bundled vapor runtime expects. */
export function installOracleDom(): void {
  const g = globalThis as Record<string, unknown>;
  g.__vaporDocument = createVaporDocument();
  if (!g.Node) g.Node = VaporNode;
  if (!g.Element) g.Element = VaporElement;
  if (!g.HTMLElement) g.HTMLElement = VaporElement;
  if (!g.Text) g.Text = VaporText;
  if (!g.Comment) g.Comment = VaporComment;
  if (!g.window) g.window = globalThis;
}

/** A fresh mount container, marked connected. */
export function createRootElement(): VaporElement {
  const root = new VaporElement("root");
  root.isRoot = true;
  return root;
}
