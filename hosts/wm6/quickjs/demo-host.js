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
    freeTexture() {},
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
    const lines = ["PocketJS Cursor (real bundle)", "viewport 480x272", ""];
    const visit = (id, depth) => {
      const current = node(id);
      if (!current) return;
      if (current.text) lines.push(" ".repeat(depth) + current.text);
      for (const child of current.children) visit(child, depth + 1);
    };
    visit(1, 0);
    return lines.join("\n");
  };

  globalThis.__wm6DrawList = () => {
    const out = ["B|0|128|128"];
    const safe = (value) => String(value).replace(/[|\r\n]/g, " ");
    const rect = (x, y, w, h, r, g, b) =>
      out.push(`R|${x}|${y}|${w}|${h}|${r}|${g}|${b}`);
    const text = (x, y, value) =>
      out.push(`T|${x}|${y}|0|0|0|0|${safe(value)}`);
    const bevel = (x, y, w, h, pressed) => {
      rect(x, y, w, h, pressed ? 210 : 192, pressed ? 206 : 192,
           pressed ? 198 : 192);
      rect(x, y, w, 2, pressed ? 0 : 255, pressed ? 0 : 255,
           pressed ? 0 : 255);
      rect(x, y, 2, h, pressed ? 0 : 255, pressed ? 0 : 255,
           pressed ? 0 : 255);
      rect(x, y + h - 2, w, 2, pressed ? 255 : 0, pressed ? 255 : 0,
           pressed ? 255 : 0);
      rect(x + w - 2, y, 2, h, pressed ? 255 : 0, pressed ? 255 : 0,
           pressed ? 255 : 0);
    };
    const labels = ["REPLAY TAPE", "OPEN MEMORY STICK", "LAUNCH SHELL"];

    labels.forEach((label, index) => {
      let owner = 0;
      for (const current of nodes.values()) {
        if (current.text === label) {
          owner = current.parent;
          break;
        }
      }
      const y = 78 + index * 32;
      bevel(120, y, 240, 24, owner === focused);
      text(240 - Math.floor(label.length * 7 / 2), y + 5, label);
    });

    let status = "hover a row, press CIRCLE";
    for (const current of nodes.values()) {
      if (current.text && labels.indexOf(current.text) < 0)
        status = current.text;
    }
    bevel(120, 184, 240, 18, false);
    text(128, 187, status);
    return out.join("\n");
  };
})();
