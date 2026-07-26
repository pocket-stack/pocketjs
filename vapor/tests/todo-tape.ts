// One deterministic interaction tape shared by console parity and the
// physical ESP32 verifier. It covers every TodoMVC action, including empty
// state behavior and adding a todo from the device editor.

import { Button } from "../host/input.ts";

export const TODO_TAPE: readonly number[] = [
  Button.Down,
  Button.Down,
  Button.A, // toggle last
  Button.Up,
  Button.A, // un-done the middle todo
  Button.Right, // ACTIVE
  Button.Down,
  Button.A, // toggle under ACTIVE -> row leaves the view
  Button.Right, // DONE
  Button.Right, // ALL
  Button.B, // delete first
  Button.Select, // clear completed
  Button.Start, // edit mode
  Button.Left, // glyph wraps to "9"
  Button.Right,
  Button.Right, // glyph "B"
  Button.A, // put B
  Button.A, // put B
  Button.B, // backspace
  Button.A, // put B again
  Button.Start, // save "BB"
  Button.Start, // edit mode again
  Button.Select, // cancel
  Button.Down,
  Button.B, // delete
  Button.B, // delete
  Button.B, // delete -> NOTHING HERE
  Button.B, // delete on empty (no-op)
  Button.Start,
  Button.A,
  Button.Start, // add "A" from empty state
];
