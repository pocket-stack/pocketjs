(() => {
  let nextNode = 2;
  let nextAnim = 1;
  const nodes = new Map();
  nodes.set(1, { id: 1, type: 0, style: -1, text: "", children: [] });

  const node = (id) => nodes.get(id);
  const detach = (id) => {
    for (const parent of nodes.values()) {
      const at = parent.children.indexOf(id);
      if (at >= 0) parent.children.splice(at, 1);
    }
  };

  globalThis.ui = {
    __host: "wm6",
    __hostAbi: 1,
    __textures: {},
    __viewport: { w: 480, h: 272 },
    createNode(type) {
      const id = nextNode++;
      nodes.set(id, { id, type, style: -1, text: "", children: [] });
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
    setFocus() {},
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
})();
