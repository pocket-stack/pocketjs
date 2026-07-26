// vapor/host/screen.ts — the target's cell-grid geometry.
//
// One module, two lives. Under the compiler, `SCREEN.width`/`SCREEN.height`
// are compile-time constants of the selected target (GBA 30x20, GB 20x18,
// NES 24x20) — layout math and width ternaries fold, dead branches drop out
// of ROM. Under the oracle the values come from globals the test harness
// sets before boot, so one bundle replays as any console.

const g = globalThis as Record<string, unknown>;

export const SCREEN = {
  width: Number(g.__vaporScreenW ?? 30),
  height: Number(g.__vaporScreenH ?? 20),
};
