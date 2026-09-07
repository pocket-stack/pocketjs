export interface DragFilterOptions {
  /** Position hysteresis in logical pixels. */
  deadband?: number;
  /** Maximum smoothing lag beyond the hysteresis, in logical pixels. */
  maxLag?: number;
}

/** Filters total contact travel, not incremental deltas. Call once per pan
 * frame, including stationary frames. The returned scratch record is reused.
 * reset() starts a new contact; velocity is suitable for a camera's fling. */
export function createDragFilter(options: DragFilterOptions = {}) {
  const deadband = options.deadband ?? 1, maxLag = options.maxLag ?? 3;
  if (![deadband, maxLag].every(Number.isFinite) || deadband < 0 || maxLag < 0) throw new Error("Invalid drag filter");
  let x = 0, y = 0, targetX = 0, targetY = 0;
  const output = { dx: 0, dy: 0, vx: 0, vy: 0 };
  return {
    reset() { x = y = targetX = targetY = 0; output.dx = output.dy = output.vx = output.vy = 0; },
    update(totalX: number, totalY: number, seconds: number) {
      if (![totalX, totalY, seconds].every(Number.isFinite) || seconds <= 0 || seconds > 1 / 15 + 1e-8) throw new Error("Invalid drag sample");
      const rx = totalX - targetX, ry = totalY - targetY, distance = Math.hypot(rx, ry);
      if (distance > deadband) { const gain = 1 - deadband / distance; targetX += rx * gain; targetY += ry * gain; }
      const ex = targetX - x, ey = targetY - y, error = Math.hypot(ex, ey);
      // Slow motion rejects quantization; fast motion catches up within maxLag.
      const gain = Math.max(1 - Math.exp(-(18 + Math.min(162, error * 8)) * seconds), error ? 1 - maxLag / error : 0);
      output.dx = ex * gain; output.dy = ey * gain; x += output.dx; y += output.dy;
      const velocityGain = 1 - Math.exp(-20 * seconds);
      output.vx += (output.dx / seconds - output.vx) * velocityGain;
      output.vy += (output.dy / seconds - output.vy) * velocityGain;
      return output;
    },
    velocity: () => ({ x: Math.abs(output.vx) < 12 ? 0 : output.vx, y: Math.abs(output.vy) < 12 ? 0 : output.vy }),
  };
}
