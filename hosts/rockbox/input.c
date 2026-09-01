#include "input.h"

#include "pocket_spec.h"

uint32_t rockbox_input_buttons(
  int held,
  int event,
  const RockboxInputCodes *codes
) {
  uint32_t buttons = 0;
  int physical;
  if (codes == 0) return 0;

  physical = held | event;
  if ((physical & codes->select) != 0) buttons |= POCKET_BTN_CIRCLE;
  if ((physical & codes->menu) != 0) buttons |= POCKET_BTN_TRIANGLE;
  if ((physical & codes->left) != 0) buttons |= POCKET_BTN_LEFT;
  if ((physical & codes->right) != 0) buttons |= POCKET_BTN_RIGHT;
  if ((physical & codes->play) != 0) buttons |= POCKET_BTN_START;

  /* Wheel motion is queued as an event, not reported by button_status(). */
  if ((event & codes->scroll_forward) != 0) buttons |= POCKET_BTN_DOWN;
  if ((event & codes->scroll_back) != 0) buttons |= POCKET_BTN_UP;
  return buttons;
}

bool rockbox_input_exit_requested(int event, const RockboxInputCodes *codes) {
  if (codes == 0) return false;
  return (event & codes->menu) != 0 && (event & codes->repeat) != 0;
}
