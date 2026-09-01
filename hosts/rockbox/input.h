#ifndef POCKETJS_ROCKBOX_INPUT_H
#define POCKETJS_ROCKBOX_INPUT_H

#include <stdbool.h>
#include <stdint.h>

typedef struct {
  int select;
  int menu;
  int left;
  int right;
  int play;
  int scroll_forward;
  int scroll_back;
  int repeat;
} RockboxInputCodes;

uint32_t rockbox_input_buttons(
  int held,
  int event,
  const RockboxInputCodes *codes
);
bool rockbox_input_exit_requested(int event, const RockboxInputCodes *codes);

#endif
