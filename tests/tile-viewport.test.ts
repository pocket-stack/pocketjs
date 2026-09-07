import { expect, test } from "bun:test";
import { createTileCamera, visibleTiles, planTileWindow, createTileIntent } from "../framework/src/tile-viewport.ts";
import { createDragFilter } from "../framework/src/drag-filter.ts";
const options = { width: 400, height: 240, x: 128, y: 128, zoom: 10, minZoom: 1, maxZoom: 18 };
test("opening a finite atlas replaces wrapping and zoom limits without replacing the camera", () => {
  const c = createTileCamera({ ...options, bounds: { width: 256, height: 256, wrapX: true } });
  c.zoomBy(2);
  c.setWorld({ minZoom: 0, maxZoom: 7, bounds: { width: 256, height: 256 } });
  c.jump(300, -10, 10);
  expect(c.view().zoom).toBe(7); expect(c.view().x).toBeCloseTo(256 - 200 / 128);
  expect(c.view().y).toBeCloseTo(120 / 128); expect(c.view().moving).toBe(false);
  const before = c.view();
  expect(() => c.setWorld({ minZoom: 8, maxZoom: 7 })).toThrow();
  expect(c.view()).toEqual(before);
  c.zoomBy(-20); for (let n = 0; n < 20; n++) c.step(1 / 60);
  expect(c.view().zoom).toBe(0); expect(c.view().x).toBe(128);
  const p = { x: 128, y: 128, zoom: 5, level: 5, width: 400, height: 240, maxTiles: 12, margin: 256, leadX: 384, maxExtra: 12 };
  const window = planTileWindow(p);
  expect(window.visible).toEqual(visibleTiles(p)); expect(window.lookAhead).toHaveLength(12);
  expect(() => planTileWindow({ ...p, margin: 513 })).toThrow();
});
test("anchored zoom preserves the world point beneath the chosen viewport pixel", () => {
  const camera = createTileCamera(options), before = camera.view();
  const at = (v: typeof before) => ({ x: v.x + (50 - 200) / v.scale, y: v.y + (80 - 120) / v.scale });
  camera.zoomBy(1, 50, 80); for (let i = 0; i < 20; i++) camera.step(1 / 60);
  expect(camera.view().zoom).toBe(11); expect(at(camera.view()).x).toBeCloseTo(at(before).x, 10); expect(at(camera.view()).y).toBeCloseTo(at(before).y, 10);
});
test("pan and inertia are sampled consistently at 30 and 60 Hz and react before IO", () => {
  const replay = (hz: number) => { const c = createTileCamera(options); for (let i = 0; i < hz; i++) c.step(1 / hz, 300, -180); for (let i = 0; i < hz; i++) c.step(1 / hz); return c.view(); };
  expect(replay(30).x).toBeCloseTo(replay(60).x, 9); expect(replay(30).y).toBeCloseTo(replay(60).y, 9);
  const c = createTileCamera(options); c.beginDrag(); c.drag(20, 30); expect(c.view().x).toBeLessThan(options.x);
  c.endDrag(200, 0); const x = c.view().x; c.step(1 / 60); expect(c.view().x).toBeLessThan(x);
});
test("bounded tile windows cover exact edges without hidden adjacent fetches", () => {
  expect(visibleTiles({ x: 128, y: 128, zoom: 0, level: 0, width: 256, height: 256, maxTiles: 4 })).toEqual([{ column: 0, row: 0, priority: 0 }]);
  expect(() => visibleTiles({ x: 0, y: 0, zoom: 0, level: 20, width: 400, height: 240, maxTiles: 12 })).toThrow("budget");
  const t = visibleTiles({ ...options, level: 10, maxTiles: 12 }); expect(t.length).toBeLessThanOrEqual(6);
  expect(t.map(t => t.priority)).toEqual(t.map(t => t.priority).sort((a, b) => a - b));
});
test("world wrap, pole clamping and malformed input remain bounded", () => {
  const c = createTileCamera({ ...options, bounds: { width: 256, height: 256, wrapX: true } });
  c.jump(257, -100, 1); expect(c.view().x).toBe(1); expect(c.view().y).toBe(60);
  c.jump(-1, 1000, 99); expect(c.view().x).toBe(255); expect(c.view().zoom).toBe(18); expect(c.view().y).toBeLessThan(256);
  expect(() => c.step(1)).toThrow(); expect(() => c.drag(NaN, 0)).toThrow();
});
test("look-ahead has a separate cap and never replaces visible demand", () => {
  const p = { x: 256, y: 256, zoom: 0, level: 0, width: 400, height: 240, maxTiles: 12, margin: 64, leadX: 128, maxExtra: 4 };
  const plan = planTileWindow(p);
  expect(plan.visible).toEqual(visibleTiles(p)); expect(plan.lookAhead.length).toBeLessThanOrEqual(4);
  expect(plan.lookAhead.some(t => t.column === 2)).toBe(true);
  expect(plan.lookAhead.every(t => !plan.visible.some(v => v.column === t.column && v.row === t.row))).toBe(true);
  expect(planTileWindow({ ...p, maxExtra: 0 }).lookAhead).toEqual([]);
  expect(() => planTileWindow({ ...p, leadX: Infinity })).toThrow();
  expect(() => planTileWindow({ ...p, level: 24 })).toThrow("budget");
  expect(() => planTileWindow({ ...p, x: Number.MAX_VALUE })).toThrow("integer range");
  expect(() => visibleTiles({ ...p, y: 1e100 })).toThrow("integer range");
});
test("drag filter rejects stationary quantization without accumulating drift", () => {
  const filter = createDragFilter(); let x = 0, y = 0;
  for (let i = 0; i < 600; i++) { const d = filter.update(i % 2 ? 1 : -1, 0, 1 / 60); x += d.dx; y += d.dy; }
  expect(x).toBe(0); expect(y).toBe(0); expect(filter.velocity()).toEqual({ x: 0, y: 0 });
  expect(() => filter.update(NaN, 0, 1 / 60)).toThrow();
  expect(() => filter.update(0, 0, 1)).toThrow();
});
test("drag tracks total travel within a pixel budget at both sample rates and stops flinging after a hold", () => {
  for (const hz of [30, 60]) {
    const filter = createDragFilter(); let x = 0;
    for (let i = 1; i <= hz; i++) { const d = filter.update(i * 300 / hz, 0, 1 / hz); x += d.dx; expect(i * 300 / hz - x).toBeLessThanOrEqual(4.0001); }
    expect(filter.velocity().x).toBeGreaterThan(280);
    for (let i = 0; i < hz; i++) x += filter.update(300, 0, 1 / hz).dx;
    expect(x).toBeCloseTo(299, 4); expect(filter.velocity().x).toBe(0);
    filter.reset(); expect(filter.update(0, 0, 1 / hz).dx).toBe(0);
  }
});

test("direction history spans repeated strokes, decays at rest and turns without a reverse tail", () => {
  for (const hz of [30, 60]) {
    const intent = createTileIntent();
    for (let stroke = 0; stroke < 5; stroke++) {
      for (let i = 0; i < hz / 2; i++) intent.sample(120 / hz, -120 / hz, 1 / hz);
      for (let i = 0; i < hz / 2; i++) intent.sample(0, 0, 1 / hz);
    }
    const lead = intent.predict(512); expect(lead.x).toBeGreaterThan(350); expect(lead.y).toBeLessThan(-350);
    const p = { x: 128, y: 128, zoom: 5, level: 5, width: 400, height: 240, maxTiles: 12, margin: 256, leadX: lead.x, leadY: lead.y, directional: true, maxExtra: 12 };
    const w = planTileWindow(p); expect(w.visible).toEqual(visibleTiles(p)); expect(w.lookAhead.length).toBeGreaterThan(3);
    expect(w.lookAhead.every(t => (t.column + .5 - 16) * lead.x + (t.row + .5 - 16) * lead.y > 0)).toBe(true);
    for (let i = 0; i < hz; i++) intent.sample(-180 / hz, 0, 1 / hz);
    expect(intent.predict(512).x).toBeLessThan(-490);
    for (let i = 0; i < hz * 9; i++) intent.sample(0, 0, 1 / hz);
    expect(intent.predict(512).confidence).toBe(0);
    intent.sample(200, 0, 1 / hz); expect(intent.predict(512).confidence).toBe(0);
  }
});
test("zoom intent exposes the final level throughout repeated animated inputs", () => {
  const c = createTileCamera(options); c.zoomBy(1); c.step(1 / 60); c.zoomBy(1);
  expect(c.view().zoom).toBeLessThan(12); expect(c.view().targetZoom).toBe(12);
  c.stop(); expect(c.view().targetZoom).toBe(c.view().zoom);
});
