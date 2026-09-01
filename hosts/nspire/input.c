#include "input.h"

#include <libndls.h>
#include <stdio.h>

#include "pocket_spec.h"

static uint8_t clamp_axis(uint16_t value, uint16_t extent) {
  if (extent <= 1u) return 128u;
  if (value >= extent) value = (uint16_t)(extent - 1u);
  return (uint8_t)(((uint32_t)value * 255u) / (uint32_t)(extent - 1u));
}

typedef struct {
  const char *name;
  const t_key *key;
} NspireKeyProbe;

#define KEY_PROBE(name) {#name, &KEY_NSPIRE_##name}

static const NspireKeyProbe diagnostic_keys[] = {
  KEY_PROBE(RET), KEY_PROBE(ENTER), KEY_PROBE(SPACE), KEY_PROBE(NEGATIVE),
  KEY_PROBE(PERIOD), KEY_PROBE(0), KEY_PROBE(COMMA), KEY_PROBE(PLUS),
  KEY_PROBE(1), KEY_PROBE(2), KEY_PROBE(3), KEY_PROBE(eEXP), KEY_PROBE(PI),
  KEY_PROBE(MINUS), KEY_PROBE(4), KEY_PROBE(5), KEY_PROBE(6),
  KEY_PROBE(TENX), KEY_PROBE(EE), KEY_PROBE(MULTIPLY), KEY_PROBE(7),
  KEY_PROBE(8), KEY_PROBE(9), KEY_PROBE(SQU), KEY_PROBE(DIVIDE),
  KEY_PROBE(TAN), KEY_PROBE(EXP), KEY_PROBE(APOSTROPHE), KEY_PROBE(CAT),
  KEY_PROBE(RP), KEY_PROBE(LP), KEY_PROBE(VAR), KEY_PROBE(DEL),
  KEY_PROBE(FLAG), KEY_PROBE(CLICK), KEY_PROBE(HOME), KEY_PROBE(MENU),
  KEY_PROBE(ESC), KEY_PROBE(BAR), KEY_PROBE(TAB), KEY_PROBE(EQU),
  KEY_PROBE(UP), KEY_PROBE(RIGHT), KEY_PROBE(DOWN), KEY_PROBE(LEFT),
  KEY_PROBE(SHIFT), KEY_PROBE(CTRL), KEY_PROBE(DOC), KEY_PROBE(TRIG),
  KEY_PROBE(SCRATCHPAD),
  KEY_PROBE(A), KEY_PROBE(B), KEY_PROBE(C), KEY_PROBE(D), KEY_PROBE(E),
  KEY_PROBE(F), KEY_PROBE(G), KEY_PROBE(H), KEY_PROBE(I), KEY_PROBE(J),
  KEY_PROBE(K), KEY_PROBE(L), KEY_PROBE(M), KEY_PROBE(N), KEY_PROBE(O),
  KEY_PROBE(P), KEY_PROBE(Q), KEY_PROBE(R), KEY_PROBE(S), KEY_PROBE(T),
  KEY_PROBE(U), KEY_PROBE(V), KEY_PROBE(W), KEY_PROBE(X), KEY_PROBE(Y),
  KEY_PROBE(Z),
};

#undef KEY_PROBE

void nspire_input_diagnostic(char *output, size_t capacity) {
  size_t index;
  size_t used = 0;
  if (output == 0 || capacity == 0) return;
  output[0] = '\0';
  for (index = 0; index < sizeof(diagnostic_keys) / sizeof(diagnostic_keys[0]); ++index) {
    const NspireKeyProbe *probe = &diagnostic_keys[index];
    int written;
    if (!isKeyPressed(*probe->key)) continue;
    written = snprintf(
      output + used,
      capacity - used,
      "%s%s",
      used == 0 ? "" : " + ",
      probe->name
    );
    if (written < 0) return;
    if ((size_t)written >= capacity - used) {
      output[capacity - 1] = '\0';
      return;
    }
    used += (size_t)written;
  }
}

uint32_t nspire_input_buttons(void) {
  uint32_t buttons = 0;
  if (isKeyPressed(KEY_NSPIRE_UP)) buttons |= POCKET_BTN_UP;
  if (isKeyPressed(KEY_NSPIRE_RIGHT)) buttons |= POCKET_BTN_RIGHT;
  if (isKeyPressed(KEY_NSPIRE_DOWN)) buttons |= POCKET_BTN_DOWN;
  if (isKeyPressed(KEY_NSPIRE_LEFT)) buttons |= POCKET_BTN_LEFT;
  if (isKeyPressed(KEY_NSPIRE_CTRL) || isKeyPressed(KEY_NSPIRE_ENTER) ||
      isKeyPressed(KEY_NSPIRE_CLICK)) buttons |= POCKET_BTN_CIRCLE;
  if (isKeyPressed(KEY_NSPIRE_ESC)) buttons |= POCKET_BTN_CROSS;
  if (isKeyPressed(KEY_NSPIRE_SHIFT)) buttons |= POCKET_BTN_SQUARE;
  if (isKeyPressed(KEY_NSPIRE_TAB)) buttons |= POCKET_BTN_TRIANGLE;
  if (isKeyPressed(KEY_NSPIRE_MENU)) buttons |= POCKET_BTN_START;
  if (isKeyPressed(KEY_NSPIRE_VAR)) buttons |= POCKET_BTN_SELECT;
  return buttons;
}

uint32_t nspire_input_analog(void) {
  touchpad_report_t report;
  touchpad_info_t *info = touchpad_getinfo();
  if (info == 0 || touchpad_scan(&report) != 0 || !report.proximity) {
    return POCKET_ANALOG_CENTER;
  }
  /* Ndless touchpad Y grows upward; Pocket's analog Y grows downward. */
  return ((uint32_t)clamp_axis(report.x, info->width) << 8u) |
         (uint32_t)(255u - clamp_axis(report.y, info->height));
}

bool nspire_input_exit_requested(void) {
  return isKeyPressed(KEY_NSPIRE_CTRL) && isKeyPressed(KEY_NSPIRE_ESC);
}
