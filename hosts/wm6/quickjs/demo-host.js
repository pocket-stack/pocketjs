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

  const textures = {
    "logo.png": 1,
    "spinner-00.svg": 2,
    "spinner-01.svg": 3,
    "spinner-02.svg": 4,
    "spinner-03.svg": 5,
    "spinner-04.svg": 6,
    "spinner-05.svg": 7,
    "spinner-06.svg": 8,
    "spinner-07.svg": 9
  };
  const viewportWidth = Math.max(
    1, Math.floor(Number(globalThis.__wm6ViewportWidth) || 480));
  const viewportHeight = Math.max(
    1, Math.floor(Number(globalThis.__wm6ViewportHeight) || 272));

  globalThis.ui = {
    __host: "wm6",
    __hostAbi: 1,
    __textures: textures,
    __viewport: { w: viewportWidth, h: viewportHeight },
    createNode(type) {
      const id = nextNode++;
      nodes.set(id, { id, type, style: -1, text: "", image: -1, parent: 0, children: [] });
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
    setImage(id, handle) { const n = node(id); if (n) n.image = handle; },
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
    const lines = [
      "PocketJS Hero (real bundle)",
      `viewport ${viewportWidth}x${viewportHeight}`,
      ""
    ];
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
    const out = ["B|248|250|252"];
    const width = viewportWidth;
    const height = viewportHeight;
    const middleY = Math.max(72, Math.floor((height - 90) / 2));
    const footerY = Math.max(middleY + 118, height - 52);
    const safe = (value) => String(value).replace(/[|\r\n]/g, " ");
    const rect = (x, y, w, h, r, g, b) =>
      out.push(`R|${x}|${y}|${w}|${h}|${r}|${g}|${b}`);
    const text = (x, y, slot, r, g, b, value) =>
      out.push(`T|${x}|${y}|${slot}|${r}|${g}|${b}|${safe(value)}`);
    const image = (x, y, w, h, handle) => {
      if (handle > 0) out.push(`I|${x}|${y}|${w}|${h}|${handle}`);
    };
    const values = [];
    const imageHandles = [];
    for (const current of nodes.values()) {
      if (current.text) values.push(current.text);
      if (current.image > 0) imageHandles.push(current.image);
    }
    const exact = (value, fallback) =>
      values.indexOf(value) >= 0 ? value : fallback;
    const prefix = (value, fallback) =>
      values.find((entry) => entry.indexOf(value) === 0) || fallback;

    image(20, 20, 40, 40, textures["logo.png"]);
    text(72, 21, 9, 15, 23, 42, exact("PocketJS", "PocketJS"));
    text(72, 43, 0, 100, 116, 139,
         exact("Solid", "Solid") +
         (values.find((entry) => entry.indexOf("+ RUST + SCEGU") >= 0) ||
          " + RUST + SCEGU"));

    text(width - 132, 20, 10, 5, 150, 105, exact("60", "60"));
    text(width - 131, 43, 0, 100, 116, 139, exact("FPS", "FPS"));
    text(width - 83, 20, 10, 37, 99, 235, exact("42", "42"));
    text(width - 86, 43, 0, 100, 116, 139, exact("NODES", "NODES"));
    text(width - 31, 20, 10, 217, 119, 6, exact("9", "9"));
    text(width - 42, 43, 0, 100, 116, 139, exact("DRAWS", "DRAWS"));

    text(20, middleY, 0, 37, 99, 235,
         exact("ONE RUST CORE · ONE JSX APP",
               "ONE RUST CORE · ONE JSX APP"));
    text(20, middleY + 21, 13, 15, 23, 42,
         exact("JSX at 60 FPS.", "JSX at 60 FPS."));
    image(width - 60, middleY + 17, 40, 40,
          imageHandles.find((handle) => handle >= 2) ||
          textures["spinner-00.svg"]);
    rect(20, middleY + 68, 105, 4, 59, 130, 246);
    rect(125, middleY + 68, 105, 4, 6, 182, 212);
    text(20, middleY + 83, 1, 71, 85, 105,
         exact("Flexbox, springs and baked type —",
               "Flexbox, springs and baked type —"));
    text(width >= 480 ? 253 : 20,
         middleY + (width >= 480 ? 83 : 101), 1, 71, 85, 105,
         exact("running on a 2005 handheld.",
               "running on a 2005 handheld."));

    rect(20, footerY, 132, 32, focused ? 37 : 37,
         focused ? 99 : 99, focused ? 235 : 235);
    text(34, footerY + 6, 9, 255, 255, 255,
         exact("Press Circle", "Press Circle"));
    const counters = values.filter((entry) => /^\d+$/.test(entry));
    text(172, footerY + 8, 1, 71, 85, 105,
         prefix("Count: ", "Count: ") + (counters[counters.length - 1] || "0"));
    const reactive = values.find((entry) =>
      entry === "Reactive on real hardware.");
    if (reactive)
      text(250, footerY + 8, 1, 5, 150, 105, reactive);
    return out.join("\n");
  };
})();
