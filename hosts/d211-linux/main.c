/*
 * d211-linux — PocketJS on the ArtInChip D211DBV framebuffer.
 *
 * The host owns the display and input, and links the PocketJS runtime:
 *   - /dev/fb0 through FBIOGET_VSCREENINFO / FBIOGET_FSCREENINFO, with the
 *     pixel layout verified at runtime instead of assumed;
 *   - the evdev touch device found by capability (never eventN);
 *   - engine/ui-cabi's software rasterizer at the target raster density;
 *   - engine/quickjs-c for the guest.
 *
 * One pocket_runtime_tick per presented frame, per the frame contract.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <sys/mman.h>
#include <sys/stat.h>

#include "audio.h"
#include "backlight.h"
#include "input.h"
#include "pocket_runtime.h"
#include "pocket_ui_cabi.h"

#ifndef POCKET_BUILD_ID
#define POCKET_BUILD_ID "unstaged"
#endif
#ifndef POCKETJS_TARGET_ID
#define POCKETJS_TARGET_ID "d211-linux-dev"
#endif
#ifndef POCKETJS_HOST_ABI
#define POCKETJS_HOST_ABI 11
#endif
#ifndef POCKET_RASTER_DENSITY
#define POCKET_RASTER_DENSITY 1
#endif
#ifndef POCKET_LOGICAL_WIDTH
#define POCKET_LOGICAL_WIDTH 800
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#define POCKET_LOGICAL_HEIGHT 480
#endif

#define D211_STAT_SAMPLES 240

static volatile sig_atomic_t g_stop = 0;

static void handle_signal(int signo) {
  (void)signo;
  g_stop = 1;
}

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

/*
 * Assets are mmap'd read-only instead of read into anonymous memory. The
 * runtime borrows the pack for the whole app lifetime, so the pages stay
 * mapped either way; file-backed pages are reclaimable under memory pressure
 * (the 64 MB board OOM-kills the process when app.pak grows past ~8 MB with
 * malloc'd assets).
 */
/** 释放 mmap 资源（0 长度或空指针为空操作）。 */
static void release_asset(uint8_t *data, size_t length) {
  if (data != 0 && length > 0) munmap(data, length);
}

static uint8_t *read_asset(const char *path, size_t *out_length) {
  int descriptor = open(path, O_RDONLY);
  if (descriptor < 0) {
    fprintf(stderr, "d211: cannot open %s: %s\n", path, strerror(errno));
    return 0;
  }
  struct stat info;
  if (fstat(descriptor, &info) != 0 || info.st_size <= 0) {
    close(descriptor);
    fprintf(stderr, "d211: %s is empty\n", path);
    return 0;
  }
  size_t length = (size_t)info.st_size;
  uint8_t *data = mmap(0, length, PROT_READ, MAP_PRIVATE, descriptor, 0);
  if (data == MAP_FAILED) {
    close(descriptor);
    fprintf(stderr, "d211: cannot mmap %s: %s\n", path, strerror(errno));
    return 0;
  }
  close(descriptor);
  *out_length = length;
  return data;
}

static int executable_directory(char *buffer, size_t length) {
  ssize_t written = readlink("/proc/self/exe", buffer, length - 1);
  if (written <= 0) return 0;
  buffer[written] = '\0';
  char *slash = strrchr(buffer, '/');
  if (slash == 0) return 0;
  *slash = '\0';
  return 1;
}

static void resolve_asset(
  char *out,
  size_t out_length,
  const char *env_name,
  const char *directory,
  const char *file_name
) {
  const char *override = getenv(env_name);
  if (override != 0 && override[0] != '\0') {
    snprintf(out, out_length, "%s", override);
  } else {
    snprintf(out, out_length, "%s/%s", directory, file_name);
  }
}

/* ---- framebuffer --------------------------------------------------------- */

typedef struct {
  int fd;
  uint8_t *memory;
  size_t memory_length;
  uint32_t width;
  uint32_t height;
  uint32_t line_length;
  struct fb_bitfield red;
  struct fb_bitfield green;
  struct fb_bitfield blue;
  struct fb_bitfield alpha;
  int direct_bgra;
} D211Framebuffer;

static int fb_open(D211Framebuffer *fb, const char *path) {
  memset(fb, 0, sizeof(*fb));
  fb->fd = open(path, O_RDWR);
  if (fb->fd < 0) {
    fprintf(stderr, "d211: cannot open %s: %s\n", path, strerror(errno));
    return 0;
  }

  struct fb_var_screeninfo var;
  struct fb_fix_screeninfo fix;
  if (ioctl(fb->fd, FBIOGET_VSCREENINFO, &var) < 0 ||
      ioctl(fb->fd, FBIOGET_FSCREENINFO, &fix) < 0) {
    fprintf(stderr, "d211: %s is not a framebuffer: %s\n", path, strerror(errno));
    close(fb->fd);
    fb->fd = -1;
    return 0;
  }

  fb->width = var.xres;
  fb->height = var.yres;
  fb->line_length = fix.line_length;
  fb->red = var.red;
  fb->green = var.green;
  fb->blue = var.blue;
  fb->alpha = var.transp;
  fb->memory_length = (size_t)fix.line_length * var.yres_virtual;
  fb->memory = mmap(
    NULL,
    fb->memory_length,
    PROT_READ | PROT_WRITE,
    MAP_SHARED,
    fb->fd,
    0
  );
  if (fb->memory == MAP_FAILED) {
    fb->memory = 0;
    fprintf(stderr, "d211: mmap %s failed: %s\n", path, strerror(errno));
    close(fb->fd);
    fb->fd = -1;
    return 0;
  }

  fb->direct_bgra =
    var.bits_per_pixel == 32 && var.red.offset == 16 && var.red.length == 8 &&
    var.green.offset == 8 && var.green.length == 8 && var.blue.offset == 0 &&
    var.blue.length == 8;

  /*
   * The panel is configured with two virtual pages (yres_virtual = 2 *
   * yres). This host owns the display, so force page 0 visible and keep
   * writing there; a leftover page from another UI would otherwise stay on
   * screen while every frame lands on the hidden page.
   */
  if (var.yoffset != 0 || var.xoffset != 0) {
    struct fb_var_screeninfo pan = var;
    pan.xoffset = 0;
    pan.yoffset = 0;
    if (ioctl(fb->fd, FBIOPAN_DISPLAY, &pan) < 0) {
      fprintf(
        stderr,
        "d211: cannot force visible page 0 (yoffset=%u): %s\n",
        var.yoffset,
        strerror(errno)
      );
    } else {
      fprintf(
        stderr,
        "d211: visible page forced to yoffset 0 (was %u)\n",
        var.yoffset
      );
    }
  }

  fprintf(
    stderr,
    "d211: fb %s %ux%u (virtual %ux%u) %ubpp stride=%u r=%u/%u g=%u/%u "
    "b=%u/%u a=%u/%u %s\n",
    path,
    fb->width,
    fb->height,
    var.xres_virtual,
    var.yres_virtual,
    var.bits_per_pixel,
    fb->line_length,
    var.red.offset,
    var.red.length,
    var.green.offset,
    var.green.length,
    var.blue.offset,
    var.blue.length,
    var.transp.offset,
    var.transp.length,
    fb->direct_bgra ? "direct BGRA" : "converting"
  );
  if (var.bits_per_pixel != 32) {
    fprintf(
      stderr,
      "d211: %ubpp is not supported by this host revision\n",
      var.bits_per_pixel
    );
    return 0;
  }
  return 1;
}

static void fb_close(D211Framebuffer *fb) {
  if (fb->memory != 0) munmap(fb->memory, fb->memory_length);
  if (fb->fd >= 0) close(fb->fd);
  fb->memory = 0;
  fb->fd = -1;
}

static uint32_t pack_channel(uint8_t value, const struct fb_bitfield *field) {
  if (field->length == 0) return 0;
  uint32_t scaled = value;
  if (field->length > 8) scaled <<= (field->length - 8);
  else if (field->length < 8) scaled >>= (8 - field->length);
  return (scaled & ((1u << field->length) - 1u)) << field->offset;
}

static void fb_present(
  D211Framebuffer *fb,
  const uint8_t *source,
  uint32_t source_stride,
  int x0,
  int y0,
  int x1,
  int y1
) {
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > (int)fb->width) x1 = (int)fb->width;
  if (y1 > (int)fb->height) y1 = (int)fb->height;
  if (x1 <= x0 || y1 <= y0) return;

  for (int y = y0; y < y1; y++) {
    const uint8_t *src = source + (size_t)y * source_stride + (size_t)x0 * 4;
    uint8_t *dst = fb->memory + (size_t)y * fb->line_length + (size_t)x0 * 4;
    if (fb->direct_bgra) {
      memcpy(dst, src, (size_t)(x1 - x0) * 4);
      continue;
    }
    for (int x = x0; x < x1; x++) {
      uint32_t word =
        pack_channel(src[2], &fb->red) | pack_channel(src[1], &fb->green) |
        pack_channel(src[0], &fb->blue) | pack_channel(src[3], &fb->alpha);
      memcpy(dst, &word, sizeof(word));
      src += 4;
      dst += 4;
    }
  }
}

/* ---- frame statistics ---------------------------------------------------- */

typedef struct {
  uint32_t tick_ns[D211_STAT_SAMPLES];
  uint32_t render_ns[D211_STAT_SAMPLES];
  uint32_t present_ns[D211_STAT_SAMPLES];
  unsigned int count;
  unsigned int index;
} D211Stats;

static void stats_add(D211Stats *stats, uint32_t tick, uint32_t render, uint32_t present) {
  stats->tick_ns[stats->index] = tick;
  stats->render_ns[stats->index] = render;
  stats->present_ns[stats->index] = present;
  stats->index = (stats->index + 1) % D211_STAT_SAMPLES;
  if (stats->count < D211_STAT_SAMPLES) stats->count++;
}

static int compare_u32(const void *left, const void *right) {
  uint32_t a = *(const uint32_t *)left;
  uint32_t b = *(const uint32_t *)right;
  return (a > b) - (a < b);
}

static uint32_t percentile_ms(const uint32_t *samples, unsigned int count, double percentile) {
  uint32_t copy[D211_STAT_SAMPLES];
  memcpy(copy, samples, count * sizeof(copy[0]));
  qsort(copy, count, sizeof(copy[0]), compare_u32);
  unsigned int index = (unsigned int)(percentile * (double)(count - 1) + 0.5);
  if (index >= count) index = count - 1;
  return (copy[index] + 500) / 1000;
}

static void stats_print(const D211Stats *stats, uint64_t frames, uint64_t elapsed_ns) {
  if (stats->count == 0) return;
  uint64_t tick_total = 0;
  uint64_t render_total = 0;
  uint64_t present_total = 0;
  for (unsigned int i = 0; i < stats->count; i++) {
    tick_total += stats->tick_ns[i];
    render_total += stats->render_ns[i];
    present_total += stats->present_ns[i];
  }
  double fps = elapsed_ns > 0
    ? (double)frames * 1e9 / (double)elapsed_ns
    : 0.0;
  fprintf(
    stderr,
    "d211: %.1f fps | tick avg=%.2f p95=%u | render avg=%.2f p95=%u | "
    "present avg=%.2f p95=%u ms | damage attempts=%lu failures=%lu "
    "full=%lu\n",
    fps,
    (double)tick_total / stats->count / 1e6,
    percentile_ms(stats->tick_ns, stats->count, 0.95),
    (double)render_total / stats->count / 1e6,
    percentile_ms(stats->render_ns, stats->count, 0.95),
    (double)present_total / stats->count / 1e6,
    percentile_ms(stats->present_ns, stats->count, 0.95),
    pocket_runtime_damage_attempts(),
    pocket_runtime_damage_failures(),
    pocket_runtime_damage_full_redraws()
  );
}

/* ---- main ---------------------------------------------------------------- */

static int scale_axis(int raw, int maximum, int logical) {
  if (maximum <= 0) return 0;
  int value = (int)(((int64_t)raw * logical) / (maximum + 1));
  if (value < 0) value = 0;
  if (value > logical - 1) value = logical - 1;
  return value;
}

int main(void) {
  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);

  char directory[512];
  if (!executable_directory(directory, sizeof(directory))) {
    snprintf(directory, sizeof(directory), ".");
  }
  char java_script_path[1024];
  char pack_path[1024];
  resolve_asset(java_script_path, sizeof(java_script_path), "POCKET_JS", directory, "app.js");
  resolve_asset(pack_path, sizeof(pack_path), "POCKET_PAK", directory, "app.pak");

  size_t java_script_length = 0;
  size_t pack_length = 0;
  uint8_t *java_script = read_asset(java_script_path, &java_script_length);
  if (java_script == 0) return 1;
  uint8_t *pack = read_asset(pack_path, &pack_length);
  if (pack == 0) {
    release_asset(java_script, java_script_length);
    return 1;
  }

  char framebuffer_path[256];
  const char *framebuffer_override = getenv("POCKET_FB");
  snprintf(
    framebuffer_path,
    sizeof(framebuffer_path),
    "%s",
    framebuffer_override != 0 && framebuffer_override[0] != '\0'
      ? framebuffer_override
      : "/dev/fb0"
  );
  D211Framebuffer framebuffer;
  if (!fb_open(&framebuffer, framebuffer_path)) {
    release_asset(java_script, java_script_length);
    release_asset(pack, pack_length);
    return 1;
  }

  D211Input touch;
  int touch_available = d211_input_open(&touch);
  if (touch_available) {
    fprintf(
      stderr,
      "d211: touch %s axes=%d/%d range=%dx%d %s\n",
      touch.name,
      touch.axis_x,
      touch.axis_y,
      touch.max_x,
      touch.max_y,
      touch.multi_touch ? "multi" : "single"
    );
  } else {
    fprintf(stderr, "d211: no touch-capable evdev device found\n");
  }

  /* 宿主模块：真实音频输出（aplay）与面板背光（sysfs）。 */
  pocket_runtime_set_audio_ops(d211_audio_ops_table());
  pocket_runtime_set_backlight_ops(d211_backlight_ops_table());
  fprintf(stderr, "d211: host modules: audio + backlight\n");

  uint64_t boot_start = now_ns();
  if (!pocket_runtime_boot(
        (const char *)java_script,
        java_script_length,
        pack,
        pack_length,
        POCKET_LOGICAL_WIDTH,
        POCKET_LOGICAL_HEIGHT
      )) {
    fprintf(stderr, "d211: boot failed: %s\n", pocket_runtime_error());
    d211_input_close(&touch);
    fb_close(&framebuffer);
    release_asset(java_script, java_script_length);
    release_asset(pack, pack_length);
    return 1;
  }
  fprintf(
    stderr,
    "d211: boot %s (%s abi=%d) %dx%d density=%d in %.1f ms\n",
    POCKET_BUILD_ID,
    POCKETJS_TARGET_ID,
    POCKETJS_HOST_ABI,
    POCKET_LOGICAL_WIDTH,
    POCKET_LOGICAL_HEIGHT,
    POCKET_RASTER_DENSITY,
    (double)(now_ns() - boot_start) / 1e6
  );

  long fps = 60;
  const char *fps_override = getenv("POCKET_FPS");
  if (fps_override != 0 && fps_override[0] != '\0') {
    char *end = 0;
    long parsed = strtol(fps_override, &end, 10);
    if (end != fps_override && parsed > 0 && parsed <= 240) fps = parsed;
  }
  const uint64_t frame_period_ns = 1000000000ull / (uint64_t)fps;
  const int touch_log = getenv("POCKET_TOUCH_LOG") != 0;

  D211Stats stats;
  memset(&stats, 0, sizeof(stats));
  int contact_hits[D211_MAX_CONTACTS];
  memset(contact_hits, 0, sizeof(contact_hits));
  unsigned int previous_active_mask = 0;
  int presented_once = 0;
  uint64_t frames = 0;
  uint64_t stats_start = now_ns();
  uint64_t next_frame = now_ns();

  while (!g_stop) {
    uint64_t frame_start = now_ns();

    D211ContactState contacts;
    memset(&contacts, 0, sizeof(contacts));
    if (touch_available) {
      struct pollfd descriptor;
      descriptor.fd = touch.fd;
      descriptor.events = POLLIN;
      uint64_t remaining = next_frame > frame_start ? next_frame - frame_start : 0;
      poll(&descriptor, 1, (int)(remaining / 1000000));
      unsigned int down_edges = d211_input_pump(&touch, &contacts);
      unsigned int active_mask = 0;
      for (int index = 0; index < contacts.count; index++) {
        const D211Contact *contact = &contacts.contacts[index];
        active_mask |= 1u << contact->id;
        int logical_x = scale_axis(contact->x, touch.max_x, POCKET_LOGICAL_WIDTH);
        int logical_y = scale_axis(contact->y, touch.max_y, POCKET_LOGICAL_HEIGHT);
        if ((down_edges & (1u << index)) != 0) {
          /* The bounds hit is resolved once, at the contact's down edge. */
          contact_hits[contact->id] = pocket_runtime_hit_test_bounds(
            (float)logical_x,
            (float)logical_y
          );
          if (touch_log) {
            fprintf(
              stderr,
              "d211: touch down id=%d raw=(%d,%d) logical=(%d,%d) hit=%d\n",
              contact->id,
              contact->x,
              contact->y,
              logical_x,
              logical_y,
              contact_hits[contact->id]
            );
          }
        }
      }
      for (int id = 0; id < D211_MAX_CONTACTS; id++) {
        if ((active_mask & (1u << id)) == 0 && (previous_active_mask & (1u << id)) != 0) {
          contact_hits[id] = 0;
          if (touch_log) fprintf(stderr, "d211: touch up id=%d\n", id);
        }
      }
      previous_active_mask = active_mask;
    } else {
      uint64_t remaining = next_frame > frame_start ? next_frame - frame_start : 0;
      struct timespec pause;
      pause.tv_sec = (time_t)(remaining / 1000000000ull);
      pause.tv_nsec = (long)(remaining % 1000000000ull);
      nanosleep(&pause, 0);
    }

    PocketRuntimeContactsInput input;
    memset(&input, 0, sizeof(input));
    for (int index = 0; index < contacts.count; index++) {
      const D211Contact *contact = &contacts.contacts[index];
      PocketRuntimeContact *output = &input.contacts[input.contact_count++];
      output->id = contact->id;
      output->x = scale_axis(contact->x, touch.max_x, POCKET_LOGICAL_WIDTH);
      output->y = scale_axis(contact->y, touch.max_y, POCKET_LOGICAL_HEIGHT);
      output->hit = contact_hits[contact->id];
    }

    uint64_t tick_start = now_ns();
    if (!pocket_runtime_tick_contacts(&input)) {
      fprintf(stderr, "d211: tick failed: %s\n", pocket_runtime_error());
      break;
    }
    uint64_t tick_end = now_ns();

    const uint8_t *pixels = ui_render_incremental_scaled(POCKET_RASTER_DENSITY);
    uint64_t render_end = now_ns();
    if (pixels == 0) {
      fprintf(stderr, "d211: render returned no surface\n");
      break;
    }

    int logical_bounds[4] = {0, 0, 0, 0};
    int has_damage = pocket_runtime_damage_bounds(logical_bounds);
    if (has_damage || !presented_once) {
      int x0 = has_damage ? logical_bounds[0] * POCKET_RASTER_DENSITY : 0;
      int y0 = has_damage ? logical_bounds[1] * POCKET_RASTER_DENSITY : 0;
      int x1 = has_damage ? logical_bounds[2] * POCKET_RASTER_DENSITY
                          : (int)framebuffer.width;
      int y1 = has_damage ? logical_bounds[3] * POCKET_RASTER_DENSITY
                          : (int)framebuffer.height;
      fb_present(&framebuffer, pixels, pocket_runtime_stride(), x0, y0, x1, y1);
      presented_once = 1;
    }
    uint64_t present_end = now_ns();

    stats_add(
      &stats,
      (uint32_t)(tick_end - tick_start),
      (uint32_t)(render_end - tick_end),
      (uint32_t)(present_end - render_end)
    );
    frames++;

    if (frames % 120 == 0) {
      stats_print(&stats, frames, now_ns() - stats_start);
    }

    next_frame += frame_period_ns;
    uint64_t frame_end = now_ns();
    if (next_frame > frame_end) {
      struct timespec pause;
      uint64_t remaining = next_frame - frame_end;
      pause.tv_sec = (time_t)(remaining / 1000000000ull);
      pause.tv_nsec = (long)(remaining % 1000000000ull);
      nanosleep(&pause, 0);
    } else {
      next_frame = frame_end;
    }
  }

  fprintf(stderr, "d211: shutting down after %llu frames\n", (unsigned long long)frames);
  pocket_runtime_shutdown();
  d211_input_close(&touch);
  fb_close(&framebuffer);
  release_asset(java_script, java_script_length);
  release_asset(pack, pack_length);
  return 0;
}
