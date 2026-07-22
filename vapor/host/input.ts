// vapor/host/input.ts — the Pocket Vapor input contract.
//
// One module, two lives. Under the oracle (real Vue Vapor on a JS host) this
// file executes: handlers register here and the test harness feeds button
// edges through __dispatchButton. Under the Pocket Vapor compiler the module
// is never executed — the compiler recognizes imports of `onButton` and
// `Button` from this path and wires handlers to the GBA key-edge register.
//
// Button values ARE the GBA KEYINPUT bit positions (and mGBA's key-mask bit
// order): a press on device sets bit (1 << Button.X).

export const Button = {
  A: 0,
  B: 1,
  Select: 2,
  Start: 3,
  Right: 4,
  Left: 5,
  Up: 6,
  Down: 7,
  R: 8,
  L: 9,
} as const;

export type ButtonId = (typeof Button)[keyof typeof Button];

type ButtonHandler = (button: number) => void;

const handlers: ButtonHandler[] = [];

/** Register a handler called once per button press edge (per frame). */
export function onButton(handler: ButtonHandler): void {
  handlers.push(handler);
}

/** Oracle-only: deliver one button press edge to every registered handler. */
export function __dispatchButton(button: number): void {
  for (const handler of handlers) handler(button);
}

/** Oracle-only: drop all registered handlers (fresh boot between tests). */
export function __resetButtons(): void {
  handlers.length = 0;
}
