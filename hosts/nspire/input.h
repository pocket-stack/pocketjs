#ifndef POCKETJS_NSPIRE_INPUT_H
#define POCKETJS_NSPIRE_INPUT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

uint32_t nspire_input_buttons(void);
uint32_t nspire_input_analog(void);
void nspire_input_diagnostic(char *output, size_t capacity);
bool nspire_input_exit_requested(void);

#endif
