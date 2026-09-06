/** Geometry and motion for remote tile pyramids. Coordinates are level-zero
 * pixels; zoom is log2 magnification. IO and projection belong to the caller. */
export interface TileCameraOptions {
  width: number; height: number; x: number; y: number; zoom: number;
  minZoom: number; maxZoom: number;
  bounds?: { width: number; height: number; wrapX?: boolean };
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (...values: number[]) => { if (values.some(v => !Number.isFinite(v))) throw new Error("Invalid tile geometry"); };
export function createTileCamera(options: TileCameraOptions) {
  finite(options.width, options.height, options.x, options.y, options.zoom, options.minZoom, options.maxZoom);
  if (options.width <= 0 || options.height <= 0 || options.minZoom > options.maxZoom || options.minZoom < -20 || options.maxZoom > 24) throw new Error("Invalid tile camera bounds");
  if (options.bounds) { finite(options.bounds.width, options.bounds.height); if (options.bounds.width <= 0 || options.bounds.height <= 0) throw new Error("Invalid world bounds"); }
  let x = options.x, y = options.y, zoom = clamp(options.zoom, options.minZoom, options.maxZoom);
  let vx = 0, vy = 0, dragging = false;
  let tween: { start: number; end: number; elapsed: number; anchorX: number; anchorY: number } | undefined;
  function constrain() {
    const b = options.bounds; if (!b) return;
    if (b.wrapX) x = ((x % b.width) + b.width) % b.width;
    else { const half = Math.min(b.width / 2, options.width / 2 / 2 ** zoom); x = clamp(x, half, b.width - half); }
    const half = Math.min(b.height / 2, options.height / 2 / 2 ** zoom);
    y = clamp(y, half, b.height - half);
  }
  function pan(dx: number, dy: number) { finite(dx, dy); x -= dx / 2 ** zoom; y -= dy / 2 ** zoom; constrain(); }
  function setZoom(next: number, ax: number, ay: number) {
    next = clamp(next, options.minZoom, options.maxZoom);
    const before = 2 ** -zoom, after = 2 ** -next;
    x += (ax - options.width / 2) * (before - after); y += (ay - options.height / 2) * (before - after);
    zoom = next; constrain();
  }
  constrain();
  return {
    view: () => ({ x, y, zoom, scale: 2 ** zoom, moving: dragging || !!tween || Math.abs(vx) + Math.abs(vy) > 1 }),
    stop() { vx = vy = 0; dragging = false; tween = undefined; },
    beginDrag() { vx = vy = 0; dragging = true; tween = undefined; },
    drag: pan,
    endDrag(dx: number, dy: number) { finite(dx, dy); dragging = false; vx = clamp(dx, -1800, 1800); vy = clamp(dy, -1800, 1800); },
    zoomBy(delta: number, anchorX = options.width / 2, anchorY = options.height / 2) {
      finite(delta, anchorX, anchorY); vx = vy = 0;
      tween = { start: zoom, end: clamp((tween?.end ?? zoom) + delta, options.minZoom, options.maxZoom), elapsed: 0, anchorX, anchorY };
    },
    jump(nextX: number, nextY: number, nextZoom = zoom) {
      finite(nextX, nextY, nextZoom); x = nextX; y = nextY; zoom = clamp(nextZoom, options.minZoom, options.maxZoom);
      vx = vy = 0; tween = undefined; dragging = false; constrain();
    },
    /** Screen-space controller velocity (pixels/second); positive moves map.
     * Caller supplies elapsed simulation time, independent of network latency. */
    step(seconds: number, inputX = 0, inputY = 0) {
      finite(seconds, inputX, inputY); if (seconds <= 0 || seconds > 1 / 15 + 1e-8) throw new Error("Tile camera step exceeds budget");
      if (tween) {
        tween.elapsed += seconds; const t = Math.min(1, tween.elapsed / 0.18), eased = 1 - (1 - t) ** 3;
        setZoom(tween.start + (tween.end - tween.start) * eased, tween.anchorX, tween.anchorY);
        if (t === 1) tween = undefined;
      }
      if (!dragging) {
        const driven = inputX !== 0 || inputY !== 0;
        const decay = Math.exp(-(driven ? 18 : 4.2) * seconds);
        const tx = clamp(inputX, -1800, 1800), ty = clamp(inputY, -1800, 1800);
        // Exact integral of exponential velocity approaches. Sampling at 30/60
        // Hz gives the same distance for a held input and for a released fling.
        const k = driven ? 18 : 4.2;
        pan(tx * seconds + (vx - tx) * (1 - decay) / k, ty * seconds + (vy - ty) * (1 - decay) / k);
        vx = tx + (vx - tx) * decay; vy = ty + (vy - ty) * decay;
        if (Math.abs(vx) < 0.1) vx = 0; if (Math.abs(vy) < 0.1) vy = 0;
      }
    },
  };
}

export interface VisibleTile { column: number; row: number; priority: number }
export interface TileWindowOptions {
  x: number; y: number; zoom: number; level: number; width: number; height: number; tileSize?: number; maxTiles: number;
}
/** Explicit, bounded look-ahead, returned separately from visible demand.
 * Margins and prediction are screen pixels; callers decide whether their
 * source permits look-ahead and give these entries a lower load priority. */
export function planTileWindow(options: TileWindowOptions & { margin: number; leadX?: number; leadY?: number; maxExtra: number }) {
  const { margin, maxExtra } = options, leadX = options.leadX ?? 0, leadY = options.leadY ?? 0;
  finite(margin, leadX, leadY, maxExtra);
  if (margin < 0 || margin > 128 || Math.abs(leadX) > 128 || Math.abs(leadY) > 128 || !Number.isSafeInteger(maxExtra) || maxExtra < 0 || maxExtra > 16) throw new Error("Invalid tile look-ahead");
  const visible = visibleTiles(options);
  if (!maxExtra) return { visible, lookAhead: [] as VisibleTile[] };
  const expanded = visibleTiles({ ...options, x: options.x + leadX / 2 / 2 ** options.zoom, y: options.y + leadY / 2 / 2 ** options.zoom,
    width: options.width + 2 * margin + Math.abs(leadX), height: options.height + 2 * margin + Math.abs(leadY), maxTiles: 256 });
  return { visible, lookAhead: expanded.filter(t => !visible.some(v => v.column === t.column && v.row === t.row)).slice(0, maxExtra) };
}
/** Current viewport only, near-first. Large/invalid windows throw before any
 * enumeration. The app maps columns/rows to domain keys (including wrap). */
export function visibleTiles(options: TileWindowOptions): VisibleTile[] {
  const { x, y, zoom, level, width, height, maxTiles } = options, size = options.tileSize ?? 256;
  finite(x, y, zoom, level, width, height, size, maxTiles);
  if (!Number.isInteger(level) || level < -20 || level > 24 || zoom < -20 || zoom > 24 || size <= 0 || width <= 0 || height <= 0 || !Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 256) throw new Error("Invalid tile window");
  const scale = 2 ** level, screen = 2 ** zoom;
  const x0 = Math.floor((x - width / 2 / screen) * scale / size), y0 = Math.floor((y - height / 2 / screen) * scale / size);
  const x1 = Math.ceil((x + width / 2 / screen) * scale / size) - 1, y1 = Math.ceil((y + height / 2 / screen) * scale / size) - 1;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles) throw new Error("Tile window exceeds budget");
  const tiles: VisibleTile[] = [], cx = x * scale / size - 0.5, cy = y * scale / size - 0.5;
  for (let row = y0; row <= y1; row++) for (let column = x0; column <= x1; column++) tiles.push({ column, row, priority: (column - cx) ** 2 + (row - cy) ** 2 });
  return tiles.sort((a, b) => a.priority - b.priority);
}
