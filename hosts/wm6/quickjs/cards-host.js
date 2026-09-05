(() => {
  let nextNode = 2;
  let nextAnim = 1;
  let focused = 0;
  const nodes = new Map();
  nodes.set(1, { id: 1, type: 0, style: -1, text: "", parent: 0, children: [] });

  const node = (id) => nodes.get(id);
  const detach = (id) => {
    for (const parent of nodes.values()) {
      const at = parent.children.indexOf(id);
      if (at >= 0) parent.children.splice(at, 1);
    }
    const child = node(id);
    if (child) child.parent = 0;
  };

  globalThis.ui = {
    __host: "wm6",
    __hostAbi: 1,
    __textures: {},
    __viewport: { w: 480, h: 272 },
    createNode(type) {
      const id = nextNode++;
      nodes.set(id, { id, type, style: -1, text: "", parent: 0, children: [] });
      return id;
    },
    destroyNode(id) {
      detach(id);
      nodes.delete(id);
    },
    insertBefore(parentId, childId, anchor) {
      const parent = node(parentId);
      if (!parent) return;
      detach(childId);
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at >= 0) parent.children.splice(at, 0, childId);
      else parent.children.push(childId);
      const child = node(childId);
      if (child) child.parent = parentId;
    },
    removeChild(_parent, child) { detach(child); },
    setStyle(id, style) { const n = node(id); if (n) n.style = style; },
    setProp() {},
    setText(id, text) { const n = node(id); if (n) n.text = String(text); },
    replaceText(id, text) { this.setText(id, text); },
    uploadTexture() { return -1; },
    setImage() {},
    setSprite() {},
    animate() { return nextAnim++; },
    cancelAnim() {},
    setFocus(id) { focused = id; },
    setActive() {},
    measureText(text, fontSlot) {
      const width = fontSlot === 12 ? 13 : fontSlot === 8 ? 8 : 7;
      return String(text).length * width;
    }
  };

  globalThis.__wm6Snapshot = () => {
    const lines = ["PocketJS Cards (real bundle)", "viewport 480x272", ""];
    const visit = (id, depth) => {
      const n = node(id);
      if (!n) return;
      if (n.text) lines.push(" ".repeat(depth) + n.text);
      for (const child of n.children) visit(child, depth + 1);
    };
    visit(1, 0);
    return lines.join("\n");
  };

  globalThis.__wm6DrawList = () => {
    const out = ["B|248|250|252"];
    const safe = (text) => String(text).replace(/[|\r\n]/g, " ");
    const text = (x, y, slot, r, g, b, value) =>
      out.push(`T|${x}|${y}|${slot}|${r}|${g}|${b}|${safe(value)}`);
    const rect = (x, y, w, h, r, g, b) =>
      out.push(`R|${x}|${y}|${w}|${h}|${r}|${g}|${b}`);
    let cardIndex = 0;
    const effectiveStyle = (n) => {
      let current = n;
      while (current) {
        if (current.style >= 0) return current.style;
        current = node(current.parent);
      }
      return -1;
    };

    for (const n of nodes.values()) {
      if (!n.text) continue;
      const style = effectiveStyle(n);
      if (style === 18) text(16, 18, 0, 37, 99, 235, n.text);
      else if (style === 19) text(16, 35, 12, 15, 23, 42, n.text);
      else if (style === 20 && n.text === "3 MODULES")
        text(398, 43, 0, 100, 116, 139, n.text);
      else if (style === 20)
        text(16, 250, 0, 100, 116, 139, n.text);
    }
    for (const n of nodes.values()) {
      if (n.style !== 0 && n.style !== 3 && n.style !== 6) continue;
      const x = 16 + cardIndex * 148;
      const isFocused = n.id === focused;
      const accent = n.style === 0 ? [59, 130, 246]
        : n.style === 3 ? [16, 185, 129] : [245, 158, 11];
      rect(x, 76, 136, 82, isFocused ? 239 : 255,
           isFocused ? 246 : 255, isFocused ? 255 : 255);
      rect(x, 76, 136, 4, accent[0], accent[1], accent[2]);
      const labels = [];
      const collect = (id) => {
        const child = node(id);
        if (!child) return;
        if (child.text) labels.push(child.text);
        for (const nested of child.children) collect(nested);
      };
      collect(n.id);
      if (labels[0]) text(x + 12, 91, 8, 15, 23, 42, labels[0]);
      if (labels[1]) text(x + 12, 115, 0, 71, 85, 105, labels[1]);
      cardIndex++;
    }
    for (const n of nodes.values()) {
      if (n.style !== 9) continue;
      rect(16, 174, 448, 54, 255, 255, 255);
      const labels = [];
      const collect = (id) => {
        const child = node(id);
        if (!child) return;
        if (child.text) labels.push(child.text);
        for (const nested of child.children) collect(nested);
      };
      collect(n.id);
      if (labels[0]) text(34, 184, 8, 15, 23, 42, labels[0]);
      if (labels[1]) text(34, 204, 0, 71, 85, 105, labels[1]);
    }
    return out.join("\n");
  };
})();
