#include "plugin.h"
#include <tlsf.h>

#include "input.h"
#include "pocket_runtime.h"
#include "pocket_spec.h"

#if CONFIG_KEYPAD != IPOD_4G_PAD
#error "PocketJS Rockbox host currently supports iPod classic click-wheel targets only"
#endif
#if LCD_WIDTH != 320 || LCD_HEIGHT != 240 || LCD_DEPTH != 16
#error "PocketJS Rockbox host requires the iPod classic 320x240 RGB565 display"
#endif

extern const unsigned char pocket_app_js[];
extern const unsigned int pocket_app_js_len;
extern const unsigned char pocket_app_pak[];
extern const unsigned int pocket_app_pak_len;

#define POCKETJS_RUNTIME_STACK_SIZE (16u * 1024u * 1024u)

static fb_data display[LCD_WIDTH * LCD_HEIGHT] MEM_ALIGN_ATTR;
static int boot_stage;
static size_t runtime_heap_size;
static enum plugin_status runtime_status;

static const RockboxInputCodes input_codes = {
  .select = BUTTON_SELECT,
  .menu = BUTTON_MENU,
  .left = BUTTON_LEFT,
  .right = BUTTON_RIGHT,
  .play = BUTTON_PLAY,
  .scroll_forward = BUTTON_SCROLL_FWD,
  .scroll_back = BUTTON_SCROLL_BACK,
  .repeat = BUTTON_REPEAT,
};

void *pocket_host_alloc(size_t size) { return tlsf_malloc(size); }
void *pocket_host_realloc(void *pointer, size_t size) {
  return tlsf_realloc(pointer, size);
}
void pocket_host_free(void *pointer) { tlsf_free(pointer); }
void pocket_host_boot_stage(int stage) { boot_stage = stage; }

static enum plugin_status show_runtime_error(void) {
  const char *message = pocket_runtime_error();
  rb->splashf(
    HZ * 8,
    "PJS S%d H%luK: %s",
    boot_stage,
    (unsigned long)(runtime_heap_size / 1024u),
    message && *message ? message : "runtime error"
  );
  return PLUGIN_ERROR;
}

static void pocketjs_runtime_thread(void) {
  enum plugin_status status = PLUGIN_OK;
  int pending_event = BUTTON_NONE;
  int cadence = 0;
  bool runtime_ready = false;

  if (!pocket_runtime_boot(
        pocket_app_js,
        pocket_app_js_len,
        pocket_app_pak,
        pocket_app_pak_len,
        LCD_WIDTH,
        LCD_HEIGHT
      )) {
    status = show_runtime_error();
    goto cleanup;
  }
  runtime_ready = true;

  while (true) {
    const long event = rb->button_get_w_tmo(1);
    uint32_t buttons;
    int damage[4];
    int damage_width;
    int damage_height;

    if (event != BUTTON_NONE) {
      if (rockbox_input_exit_requested((int)event, &input_codes)) break;
      if (rb->default_event_handler(event) == SYS_USB_CONNECTED) {
        status = PLUGIN_USB_CONNECTED;
        break;
      }
      pending_event |= (int)event;
    }

    /* Rockbox's native tick is normally 100 Hz; retain exactly 60 guest
       turns per second without relying on fractional sleep durations. */
    cadence += 60;
    if (cadence < HZ) continue;
    cadence -= HZ;

    buttons = rockbox_input_buttons(rb->button_status(), pending_event, &input_codes);
    pending_event = BUTTON_NONE;
    if (!pocket_runtime_tick_analog(buttons, POCKET_ANALOG_CENTER)) {
      status = show_runtime_error();
      break;
    }

    if (!pocket_runtime_render_rgb565(
          (uint16_t *)display,
          LCD_WIDTH * LCD_HEIGHT
        ) || pocket_runtime_width() != LCD_WIDTH ||
        pocket_runtime_height() != LCD_HEIGHT) {
      rb->splash(HZ * 3, "PocketJS: invalid framebuffer");
      status = PLUGIN_ERROR;
      break;
    }
    if (!pocket_runtime_damage_bounds(damage)) continue;

    if (damage[0] < 0) damage[0] = 0;
    if (damage[1] < 0) damage[1] = 0;
    if (damage[2] > LCD_WIDTH) damage[2] = LCD_WIDTH;
    if (damage[3] > LCD_HEIGHT) damage[3] = LCD_HEIGHT;
    damage_width = damage[2] - damage[0];
    damage_height = damage[3] - damage[1];
    if (damage_width <= 0 || damage_height <= 0) continue;

    rb->lcd_bitmap_part(
      display,
      damage[0],
      damage[1],
      LCD_WIDTH,
      damage[0],
      damage[1],
      damage_width,
      damage_height
    );
    rb->lcd_update_rect(
      damage[0],
      damage[1],
      damage_width,
      damage_height
    );
  }

cleanup:
  if (runtime_ready) pocket_runtime_shutdown();
  runtime_status = status;
}

enum plugin_status plugin_start(const void *parameter) {
  size_t audio_size = 0;
  size_t heap_size;
  unsigned int thread_id;
  unsigned char *audio_buffer;
  unsigned char *heap;

  (void)parameter;
  /* QuickJS source evaluation needs substantially more native stack than the
     8 KiB Rockbox main thread provides. Reserve a stable 16 MiB execution
     stack from the audio buffer; the rest is the PocketJS allocation heap. */
  rb->audio_stop();
  audio_buffer = rb->plugin_get_audio_buffer(&audio_size);
  if (audio_buffer == 0 ||
      audio_size < POCKETJS_RUNTIME_STACK_SIZE + 2u * 1024u * 1024u) {
    rb->splash(HZ * 3, "PocketJS: not enough audio memory");
    return PLUGIN_ERROR;
  }

  heap = audio_buffer + POCKETJS_RUNTIME_STACK_SIZE;
  heap_size = audio_size - POCKETJS_RUNTIME_STACK_SIZE;
  runtime_heap_size = heap_size;
  if (init_memory_pool(heap_size, heap) == (size_t)-1) {
    rb->splash(HZ * 3, "PocketJS: heap init failed");
    return PLUGIN_ERROR;
  }

#ifdef HAVE_ADJUSTABLE_CPU_FREQ
  rb->cpu_boost(true);
#endif
  rb->backlight_on();

  runtime_status = PLUGIN_ERROR;
  thread_id = rb->create_thread(
    pocketjs_runtime_thread,
    audio_buffer,
    POCKETJS_RUNTIME_STACK_SIZE,
    0,
    "pocketjs"
    IF_PRIO(, PRIORITY_USER_INTERFACE)
    IF_COP(, CPU)
  );
  if (thread_id == 0) {
    rb->splash(HZ * 3, "PocketJS: thread creation failed");
#ifdef HAVE_ADJUSTABLE_CPU_FREQ
    rb->cpu_boost(false);
#endif
    return PLUGIN_ERROR;
  }

  rb->thread_wait(thread_id);
#ifdef HAVE_ADJUSTABLE_CPU_FREQ
  rb->cpu_boost(false);
#endif
  return runtime_status;
}
