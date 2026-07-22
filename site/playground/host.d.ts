export const BTN: Readonly<{
  SELECT: number;
  START: number;
  UP: number;
  RIGHT: number;
  DOWN: number;
  LEFT: number;
  LTRIGGER: number;
  RTRIGGER: number;
  TRIANGLE: number;
  CIRCLE: number;
  CROSS: number;
  SQUARE: number;
}>;

export class PocketHost {
  wasm: any;
  frameCb: ((buttons: number) => void) | null;
  rafId: number;
  held: number;
  tickCount: number;
  blitCount: number;
  press(bit: number, down: boolean): void;
  afterNextTick(callback: () => void): () => void;
  _safeFrame(): boolean;
}
