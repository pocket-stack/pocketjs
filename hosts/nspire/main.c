#include <libndls.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "framebuffer.h"
#include "input.h"
#include "pocket_runtime.h"

extern const unsigned char pocket_app_js[];
extern const unsigned int pocket_app_js_len;
extern const unsigned char pocket_app_pak[];
extern const unsigned int pocket_app_pak_len;

void pocket_host_boot_stage(int stage) {
  char path[256];
  FILE *file;
  const char *documents = get_documents_dir();
  if (documents == 0 ||
      snprintf(path, sizeof(path), "%spocketjs-boot-stage.txt.tns", documents) >=
        (int)sizeof(path)) return;
  file = fopen(path, "wb");
  if (file == 0) return;
  fprintf(file, "schema=1\nstage=%d\n", stage);
  fclose(file);
}

int main(void) {
  uint16_t *screen;
  char diagnostic_keys[512];
  unsigned frame = 0;

  pocket_host_boot_stage(0);
  if (!is_cx2) {
    show_msgbox("PocketJS", "This build only supports TI-Nspire CX II.");
    return 1;
  }
  screen = (uint16_t *)malloc(NSPIRE_SCREEN_PIXELS * sizeof(uint16_t));
  if (screen == 0) {
    show_msgbox("PocketJS", "RGB565 framebuffer allocation failed.");
    return 1;
  }
  if (!pocket_runtime_boot(
        (const char *)pocket_app_js,
        (size_t)pocket_app_js_len,
        pocket_app_pak,
        (size_t)pocket_app_pak_len,
        (int)NSPIRE_SCREEN_WIDTH,
        (int)NSPIRE_SCREEN_HEIGHT)) {
    show_msgbox("PocketJS boot error", pocket_runtime_error());
    free(screen);
    return 1;
  }

  pocket_host_boot_stage(20);
  lcd_init(SCR_320x240_565);
  pocket_host_boot_stage(21);
  while (!nspire_input_exit_requested()) {
    const uint32_t buttons = nspire_input_buttons();
    const uint32_t analog = nspire_input_analog();
    nspire_input_diagnostic(diagnostic_keys, sizeof(diagnostic_keys));
    if (frame == 0) pocket_host_boot_stage(30);
    if (!pocket_runtime_set_diagnostic_text(diagnostic_keys) ||
        !pocket_runtime_tick_analog(buttons, analog)) {
      lcd_init(SCR_TYPE_INVALID);
      show_msgbox("PocketJS runtime error", pocket_runtime_error());
      pocket_runtime_shutdown();
      free(screen);
      return 1;
    }
    if (frame == 0) pocket_host_boot_stage(31);
    /* Tick at 60 Hz, but avoid a full LCD transfer more than 30 times/s. */
    if ((frame++ & 1u) == 0u) {
      const uint8_t *pixels = pocket_runtime_render();
      if (frame == 1) pocket_host_boot_stage(32);
      if (pixels == 0 || pocket_runtime_width() != NSPIRE_SCREEN_WIDTH ||
          pocket_runtime_height() != NSPIRE_SCREEN_HEIGHT) {
        lcd_init(SCR_TYPE_INVALID);
        show_msgbox("PocketJS", "The software renderer returned a bad frame.");
        pocket_runtime_shutdown();
        free(screen);
        return 1;
      }
      nspire_bgra_to_rgb565(screen, pixels, NSPIRE_SCREEN_PIXELS);
      if (frame == 1) pocket_host_boot_stage(33);
      lcd_blit(screen, SCR_320x240_565);
      if (frame == 1) pocket_host_boot_stage(34);
    }
    msleep(16);
  }

  lcd_init(SCR_TYPE_INVALID);
  pocket_runtime_shutdown();
  free(screen);
  return 0;
}
