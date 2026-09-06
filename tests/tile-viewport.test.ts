import { expect, test } from "bun:test";
import { createTileCamera, visibleTiles } from "../framework/src/tile-viewport.ts";
const options = { width: 400, height: 240, x: 128, y: 128, zoom: 10, minZoom: 1, maxZoom: 18 };
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
