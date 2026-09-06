import { expect, test } from "bun:test";
import { createRoot, createSignal, createRenderEffect, flush } from "solid-js";
import { onFrame, runFrameHooks, resetFrameHooks } from "../framework/src/frame.ts";

test("frame controllers read staged input and commit one render update before returning", () => {
  resetFrameHooks(); const paints: number[] = []; let observed = -1;
  const dispose = createRoot(dispose => {
    const [value, setValue] = createSignal(0);
    createRenderEffect(value, n => { paints.push(n); });
    onFrame(() => { setValue(1); setValue(2); });
    onFrame(() => { observed = value(); });
    return dispose;
  });
  flush(); paints.length = 0; runFrameHooks(0);
  expect(observed).toBe(2); expect(paints).toEqual([2]);
  dispose(); paints.length = 0; runFrameHooks(0); expect(paints).toEqual([]);
});
