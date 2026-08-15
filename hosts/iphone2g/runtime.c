#include "pocket_runtime.h"

#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

/*
 * iPhone OS 1.1.4-3.1.3 UIKit host for PocketJS.
 *
 * This translation unit intentionally contains no Objective-C metadata.  The
 * delegate and view classes are registered at runtime so ld-classic never has
 * to parse modern Objective-C sections produced by the current Clang.
 */

typedef void *id;
typedef void *Class;
typedef void *SEL;
typedef signed char BOOL;
typedef void *CGContextRef;
typedef void *CGColorSpaceRef;
typedef void *CGDataProviderRef;
typedef void *CGImageRef;
typedef void *GSEventRef;

typedef struct {
  float x;
  float y;
} CGPoint;

typedef struct {
  float width;
  float height;
} CGSize;

typedef struct {
  CGPoint origin;
  CGSize size;
} CGRect;

typedef struct {
  float a;
  float b;
  float c;
  float d;
  float tx;
  float ty;
} CGAffineTransform;

typedef enum {
  POCKET_STATE_STARTING = 0,
  POCKET_STATE_RUNNING = 1,
  POCKET_STATE_FAILED = 2,
  POCKET_STATE_TERMINATED = 3
} PocketState;

#define YES ((BOOL)1)
#define NO ((BOOL)0)
#ifndef POCKET_LOGICAL_WIDTH
#error "POCKET_LOGICAL_WIDTH must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#error "POCKET_LOGICAL_HEIGHT must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKET_RASTER_DENSITY
#define POCKET_RASTER_DENSITY 1
#endif
#ifndef POCKET_GL_DEFAULT
#define POCKET_GL_DEFAULT 0
#endif
#ifndef POCKET_REQUIRE_GL
#define POCKET_REQUIRE_GL 0
#endif
#define POCKET_STATUS_CAPACITY 256
#define POCKET_STATUS_COLUMNS 42
#define POCKET_STATUS_LINES 5
#define POCKET_STATUS_HEARTBEAT_FRAMES 60UL
#ifndef POCKET_ACCEPTANCE_PATH
#define POCKET_ACCEPTANCE_PATH "/private/var/tmp/pocketjs-iphone2g.status"
#endif
/*
 * The renderer is chosen by this marker, and the default is the software
 * rasterizer because it is measurably faster here: with the composite scoped to
 * the damage rectangle it holds a locked 60 fps at ~7.5 ms per frame, where the
 * OpenGL ES 1.1 path costs ~17-20 ms and delivers 48-51. The GL backend is
 * correct and pixel-verified, it simply re-submits and re-fills the entire
 * DrawList every frame; giving it the same damage treatment is the open work.
 *
 * Touch the file to opt into GL. Two places must agree on the answer — setup_gl
 * and the view's +layerClass — because a CAEAGLLayer never receives drawRect:
 * and so cannot composite a software frame.
 */
#ifndef POCKET_PREFER_GL_PATH
#define POCKET_PREFER_GL_PATH "/private/var/tmp/pocketjs-iphone2g.gles1"
#endif
/*
 * Touch this file and the next GL frame is read back with glReadPixels and
 * written next to it, then the request is cleared. It exists so device output
 * can be compared against the reference core's render pixel by pixel, instead
 * of against somebody's description of what the screen looked like.
 */
#ifndef POCKET_CAPTURE_REQUEST_PATH
#define POCKET_CAPTURE_REQUEST_PATH "/private/var/tmp/pocketjs-iphone2g.capture"
#endif
#ifndef POCKET_CAPTURE_OUTPUT_PATH
#define POCKET_CAPTURE_OUTPUT_PATH "/private/var/tmp/pocketjs-iphone2g.frame.rgba"
#endif
#ifndef POCKET_ACCEPTANCE_TEMP
#define POCKET_ACCEPTANCE_TEMP "/private/var/tmp/pocketjs-iphone2g.status.new"
#endif
#ifndef POCKET_BUILD_ID
#define POCKET_BUILD_ID "unknown"
#endif

/* CGImageAlphaInfo / CGBitmapInfo values present in the 1.1.4 CoreGraphics. */
#define POCKET_CG_ALPHA_PREMULTIPLIED_FIRST 2U
#define POCKET_CG_BYTE_ORDER_32_LITTLE (2U << 12)
#define POCKET_CG_RENDERING_INTENT_DEFAULT 0
#define POCKET_CG_TEXT_ENCODING_MAC_ROMAN 1

extern Class objc_getClass(const char *name);
extern Class objc_allocateClassPair(Class superclass, const char *name, size_t extra_bytes);
extern void objc_registerClassPair(Class cls);
/* For a class pair this returns the metaclass, where class methods live. */
extern Class object_getClass(id object);
extern BOOL class_addMethod(Class cls, SEL name, void (*implementation)(void), const char *types);
extern SEL sel_registerName(const char *name);
extern void *objc_msgSend(void);
extern void *objc_msgSend_stret(void);

extern int UIApplicationMain(int argc, char **argv, id principal_class_name, id delegate_class_name);
extern uint8_t *getsectdata(const char *segment_name, const char *section_name, size_t *size);
extern void *dlsym(void *handle, const char *symbol);

extern void CGContextSetRGBFillColor(
  CGContextRef context,
  float red,
  float green,
  float blue,
  float alpha
);
extern void CGContextFillRect(CGContextRef context, CGRect rect);
extern void CGContextSelectFont(CGContextRef context, const char *name, float size, int encoding);
extern void CGContextSetTextMatrix(CGContextRef context, CGAffineTransform transform);
extern void CGContextSetTextDrawingMode(CGContextRef context, int mode);
extern void CGContextShowTextAtPoint(
  CGContextRef context,
  float x,
  float y,
  const char *text,
  size_t length
);
extern void CGContextSaveGState(CGContextRef context);
extern void CGContextRestoreGState(CGContextRef context);
extern void CGContextTranslateCTM(CGContextRef context, float tx, float ty);
extern void CGContextScaleCTM(CGContextRef context, float sx, float sy);
extern void CGContextDrawImage(CGContextRef context, CGRect rect, CGImageRef image);
extern void CGContextClipToRect(CGContextRef context, CGRect rect);
extern CGColorSpaceRef CGColorSpaceCreateDeviceRGB(void);
extern void CGColorSpaceRelease(CGColorSpaceRef color_space);
extern CGDataProviderRef CGDataProviderCreateWithData(
  void *info,
  const void *data,
  size_t size,
  void (*release_data)(void *info, const void *data, size_t size)
);
extern void CGDataProviderRelease(CGDataProviderRef provider);
extern CGImageRef CGImageCreate(
  size_t width,
  size_t height,
  size_t bits_per_component,
  size_t bits_per_pixel,
  size_t bytes_per_row,
  CGColorSpaceRef color_space,
  unsigned int bitmap_info,
  CGDataProviderRef provider,
  const float *decode,
  BOOL should_interpolate,
  int rendering_intent
);
extern void CGImageRelease(CGImageRef image);
extern void glReadPixels(
  int32_t x,
  int32_t y,
  int32_t width,
  int32_t height,
  uint32_t format,
  uint32_t type,
  void *pixels
);
extern void glFinish(void);
extern void *malloc(size_t size);
extern void free(void *pointer);

static id g_window;
static id g_view;
static id g_timer;
static CGRect g_content_frame;
static PocketState g_state = POCKET_STATE_STARTING;
static char g_status_message[POCKET_STATUS_CAPACITY];

static const uint8_t *g_framebuffer;
static uint32_t g_framebuffer_width;
static uint32_t g_framebuffer_height;
static uint32_t g_framebuffer_stride;
static size_t g_framebuffer_length;
static int32_t g_drawable_width;
static int32_t g_drawable_height;

static int g_touch_down;
static int g_touch_x;
static int g_touch_y;
static int g_touch_hit;
static int g_last_touch_hit;
static int g_touch_needs_hit;
static int g_touch_was_sent;
static int g_touch_release_after_frame;
static int g_touch_awaiting_completion;
/*
 * Which path actually drew the last frame. This is recorded rather than
 * inferred: a GL failure falls back to the software rasterizer silently and by
 * design, so without this field a hardware receipt and a software one are
 * byte-identical, and "it runs on the GPU" would be an assumption.
 */
static const char *g_renderer = "software";
/*
 * Which clock drives the frame loop, recorded for the same reason as the
 * renderer. NSTimer at 1/60 s does not actually deliver 60 frames on this
 * device — measured ~57 — because the run loop schedules it approximately.
 * CADisplayLink (iPhone OS 3.1 and later) fires with the display instead.
 */
static const char *g_clock = "nstimer";
/* Mean microseconds per stage since the previous record, from gettimeofday. */
static unsigned long g_frame_us_total;
static unsigned long g_present_us_total;
static unsigned long g_submit_us_total;
static unsigned long g_timed_frames;
static unsigned long g_frame_us_mean;
static unsigned long g_present_us_mean;
static unsigned long g_submit_us_mean;

static unsigned long g_guest_frames;
static unsigned long g_touch_sequences;
static unsigned long g_completed_touch_sequences;
static unsigned long g_status_heartbeat;
static unsigned long g_last_record_attempt_frame;
/*
 * Raw counters for the delivered frame rate, rather than a rate computed here.
 * Differencing two fetched records gave +/-4 fps of uncertainty, because the
 * record is only written every heartbeat and its timestamp has one-second
 * resolution. These two fields make the window exact: fps is
 * window_frames * 1e6 / window_us, measured entirely on the device.
 */
/*
 * The software path's CGImage composite happens in drawRect:, which UIKit calls
 * later in the run loop — outside the tick's timers. Timing it separately is
 * what makes the two renderers comparable: without this, the software path was
 * being credited only with its incremental rasterize while the GL path was
 * charged for rasterize AND present.
 */
static unsigned long g_blit_us_total;
static unsigned long g_blit_frames;
static unsigned long g_blit_us_mean;
/*
 * Cumulative drawRect: calls. The ratio of this to guest_frames is what
 * distinguishes a cheap composite from a frozen screen — a scoped invalidation
 * that never fires looks exactly like a very fast one.
 */
static unsigned long g_composites;
static unsigned long g_damage_regions_last;

static unsigned long g_window_start_us;
static unsigned long g_window_start_frame;
static unsigned long g_window_frames;
static unsigned long g_window_us;
static unsigned long g_observed_action_sequence;

static size_t cstring_length(const char *text) {
  size_t length = 0;
  if (text == NULL) {
    return 0;
  }
  while (text[length] != '\0') {
    length += 1;
  }
  return length;
}

static void copy_status_message(const char *message) {
  size_t index = 0;
  const char *source = message;
  if (source == NULL || source[0] == '\0') {
    source = "Unknown PocketJS runtime error";
  }
  while (source[index] != '\0' && index + 1 < sizeof(g_status_message)) {
    g_status_message[index] = source[index];
    index += 1;
  }
  g_status_message[index] = '\0';
}

/* Microseconds on a clock that exists in this libc; only used for deltas. */
static unsigned long now_us(void) {
  struct timeval now;
  if (gettimeofday(&now, NULL) != 0) return 0;
  return (unsigned long)now.tv_sec * 1000000UL + (unsigned long)now.tv_usec;
}

/* Best-effort, device-local proof fetched through the scoped USB SSH helper. */
static void write_acceptance_record(void) {
  char record[896];
  unsigned long next_heartbeat = g_status_heartbeat + 1;
  time_t written_at = time(NULL);
  const char *state = g_state == POCKET_STATE_RUNNING
    ? "running"
    : g_state == POCKET_STATE_FAILED
      ? "failed"
      : g_state == POCKET_STATE_TERMINATED ? "terminated" : "starting";
  int length = snprintf(
    record,
    sizeof(record),
    "schema=2\nbuild_id=%s\nstate=%s\npid=%ld\nwritten_at=%ld\nheartbeat=%lu\n"
    "guest_frames=%lu\ntouch_sequences=%lu\ncompleted_touch_sequences=%lu\n"
    "touch_down=%d\nlast_touch_x=%d\nlast_touch_y=%d\nlast_touch_hit=%d\n"
    "action_name=%s\naction_value=%d\naction_sequence=%lu\n"
    "renderer=%s\nclock=%s\nraster_density=%d\ndrawable_width=%ld\ndrawable_height=%ld\n"
    "frame_us=%lu\nsubmit_us=%lu\npresent_us=%lu\n"
    "window_frames=%lu\nwindow_us=%lu\nblit_us=%lu\n"
    "damage_attempts=%lu\ndamage_failures=%lu\ndamage_full_redraws=%lu\n"
    "damage_pixels=%lu\ncomposites=%lu\ndamage_regions_last=%lu\nerror=%s\n",
    POCKET_BUILD_ID,
    state,
    (long)getpid(),
    (long)written_at,
    next_heartbeat,
    g_guest_frames,
    g_touch_sequences,
    g_completed_touch_sequences,
    g_touch_down,
    g_touch_x,
    g_touch_y,
    g_last_touch_hit,
    pocket_runtime_action_name(),
    pocket_runtime_action_value(),
    pocket_runtime_action_sequence(),
    g_renderer,
    g_clock,
    POCKET_RASTER_DENSITY,
    (long)g_drawable_width,
    (long)g_drawable_height,
    g_frame_us_mean,
    g_submit_us_mean,
    g_present_us_mean,
    g_window_frames,
    g_window_us,
    g_blit_us_mean,
    pocket_runtime_damage_attempts(),
    pocket_runtime_damage_failures(),
    pocket_runtime_damage_full_redraws(),
    pocket_runtime_damage_pixels(),
    g_composites,
    g_damage_regions_last,
    g_state == POCKET_STATE_FAILED ? g_status_message : ""
  );
  g_last_record_attempt_frame = g_guest_frames;
  if (length <= 0) return;
  if ((size_t)length >= sizeof(record)) length = (int)sizeof(record) - 1;

  int descriptor = open(POCKET_ACCEPTANCE_TEMP, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (descriptor < 0) return;
  size_t written = 0;
  while (written < (size_t)length) {
    ssize_t count = write(descriptor, record + written, (size_t)length - written);
    if (count <= 0) break;
    written += (size_t)count;
  }
  (void)close(descriptor);
  if (written == (size_t)length) {
    if (rename(POCKET_ACCEPTANCE_TEMP, POCKET_ACCEPTANCE_PATH) == 0) {
      g_status_heartbeat = next_heartbeat;
    }
  }
}

static id send_id(id receiver, const char *selector) {
  return ((id (*)(id, SEL))objc_msgSend)(receiver, sel_registerName(selector));
}

static id send_id_rect(id receiver, const char *selector, CGRect rect) {
  return ((id (*)(id, SEL, CGRect))objc_msgSend)(receiver, sel_registerName(selector), rect);
}

static id send_id_object(id receiver, const char *selector, id value) {
  return ((id (*)(id, SEL, id))objc_msgSend)(receiver, sel_registerName(selector), value);
}

static BOOL send_bool_selector(id receiver, const char *selector, SEL value) {
  return ((BOOL (*)(id, SEL, SEL))objc_msgSend)(
    receiver,
    sel_registerName(selector),
    value
  );
}

static BOOL responds_to(id receiver, const char *selector) {
  if (receiver == NULL) {
    return NO;
  }
  return send_bool_selector(
    receiver,
    "respondsToSelector:",
    sel_registerName(selector)
  );
}

static id send_id_timer(
  id receiver,
  const char *selector,
  double interval,
  id target,
  SEL callback,
  id user_info,
  BOOL repeats
) {
  return ((id (*)(id, SEL, double, id, SEL, id, BOOL))objc_msgSend)(
    receiver,
    sel_registerName(selector),
    interval,
    target,
    callback,
    user_info,
    repeats
  );
}

static void send_void(id receiver, const char *selector) {
  ((void (*)(id, SEL))objc_msgSend)(receiver, sel_registerName(selector));
}

static void send_void_object(id receiver, const char *selector, id value) {
  ((void (*)(id, SEL, id))objc_msgSend)(receiver, sel_registerName(selector), value);
}

static void send_void_rect(id receiver, const char *selector, CGRect rect) {
  ((void (*)(id, SEL, CGRect))objc_msgSend)(receiver, sel_registerName(selector), rect);
}

static void send_void_bool(id receiver, const char *selector, BOOL value) {
  ((void (*)(id, SEL, BOOL))objc_msgSend)(receiver, sel_registerName(selector), value);
}

static void send_void_float(id receiver, const char *selector, float value) {
  ((void (*)(id, SEL, float))objc_msgSend)(receiver, sel_registerName(selector), value);
}

static void send_status_bar_mode(
  id application,
  int mode,
  int orientation,
  float duration,
  int fence_id
) {
  ((void (*)(id, SEL, int, int, float, int))objc_msgSend)(
    application,
    sel_registerName("setStatusBarMode:orientation:duration:fenceID:"),
    mode,
    orientation,
    duration,
    fence_id
  );
}

static CGRect send_rect(id receiver, const char *selector) {
  CGRect result;
  ((void (*)(CGRect *, id, SEL))objc_msgSend_stret)(
    &result,
    receiver,
    sel_registerName(selector)
  );
  return result;
}

static CGPoint send_point_object(id receiver, const char *selector, id value) {
  CGPoint result;
  ((void (*)(CGPoint *, id, SEL, id))objc_msgSend_stret)(
    &result,
    receiver,
    sel_registerName(selector),
    value
  );
  return result;
}

static CGContextRef current_graphics_context(void) {
  typedef CGContextRef (*CurrentContextFunction)(void);
  static CurrentContextFunction function;
  static int resolved;

  if (!resolved) {
    void *handle = (void *)(intptr_t)-2; /* Darwin RTLD_DEFAULT. */
    function = (CurrentContextFunction)dlsym(handle, "UIGraphicsGetCurrentContext");
    if (function == NULL) {
      function = (CurrentContextFunction)dlsym(handle, "UICurrentContext");
    }
    resolved = 1;
  }
  return function == NULL ? NULL : function();
}

static void draw_text_bytes(
  CGContextRef context,
  float x,
  float y,
  const char *text,
  size_t length,
  float size
) {
  CGAffineTransform upright_text = {1.0f, 0.0f, 0.0f, -1.0f, 0.0f, 0.0f};
  CGContextSelectFont(context, "Helvetica", size, POCKET_CG_TEXT_ENCODING_MAC_ROMAN);
  CGContextSetTextMatrix(context, upright_text);
  CGContextSetTextDrawingMode(context, 0);
  CGContextShowTextAtPoint(context, x, y, text, length);
}

static void draw_text(CGContextRef context, float x, float y, const char *text, float size) {
  draw_text_bytes(context, x, y, text, cstring_length(text), size);
}

static void draw_wrapped_status(CGContextRef context, float x, float y, const char *text) {
  size_t offset = 0;
  int line = 0;

  while (text != NULL && text[offset] != '\0' && line < POCKET_STATUS_LINES) {
    size_t remaining = cstring_length(text + offset);
    size_t count = remaining;
    size_t candidate;

    if (count > POCKET_STATUS_COLUMNS) {
      count = POCKET_STATUS_COLUMNS;
      candidate = count;
      while (candidate > 0 && text[offset + candidate] != ' ') {
        candidate -= 1;
      }
      if (candidate > 0) {
        count = candidate;
      }
    }

    draw_text_bytes(context, x, y - (float)(line * 18), text + offset, count, 13.0f);
    offset += count;
    while (text[offset] == ' ') {
      offset += 1;
    }
    line += 1;
  }
}

static void draw_status(CGContextRef context, CGRect bounds) {
  CGRect fill = bounds;
  if (fill.size.width <= 0.0f || fill.size.height <= 0.0f) {
    fill.origin.x = 0.0f;
    fill.origin.y = 0.0f;
    fill.size.width = (float)POCKET_LOGICAL_WIDTH;
    fill.size.height = (float)POCKET_LOGICAL_HEIGHT;
  }

  if (g_state == POCKET_STATE_FAILED) {
    CGContextSetRGBFillColor(context, 0.12f, 0.02f, 0.04f, 1.0f);
  } else {
    CGContextSetRGBFillColor(context, 0.015f, 0.035f, 0.075f, 1.0f);
  }
  CGContextFillRect(context, fill);

  CGContextSetRGBFillColor(context, 0.25f, 0.85f, 1.0f, 1.0f);
  draw_text(context, 18.0f, fill.size.height - 42.0f, "POCKETJS / IPHONE 2G", 18.0f);

  if (g_state == POCKET_STATE_FAILED) {
    CGContextSetRGBFillColor(context, 1.0f, 0.45f, 0.38f, 1.0f);
    draw_text(context, 18.0f, fill.size.height - 82.0f, "Runtime stopped", 24.0f);
    CGContextSetRGBFillColor(context, 1.0f, 0.82f, 0.78f, 1.0f);
    draw_wrapped_status(context, 18.0f, fill.size.height - 116.0f, g_status_message);
  } else {
    CGContextSetRGBFillColor(context, 0.9f, 0.95f, 1.0f, 1.0f);
    draw_text(context, 18.0f, fill.size.height - 82.0f, "Starting embedded demo...", 20.0f);
    CGContextSetRGBFillColor(context, 0.52f, 0.68f, 0.82f, 1.0f);
    draw_text(context, 18.0f, fill.size.height - 112.0f, "JS + PAK / 320x480 / 60 Hz", 13.0f);
  }
}

static void release_provider_data(void *info, const void *data, size_t size) {
  (void)info;
  (void)data;
  (void)size;
}

static void stop_timer(void) {
  if (g_timer != NULL) {
    send_void(g_timer, "invalidate");
    g_timer = NULL;
  }
}

static void fail_runtime(const char *message) {
  copy_status_message(message);
  g_state = POCKET_STATE_FAILED;
  stop_timer();
  pocket_runtime_shutdown();
  g_framebuffer = NULL;
  g_framebuffer_width = 0;
  g_framebuffer_height = 0;
  g_framebuffer_stride = 0;
  g_framebuffer_length = 0;
  g_drawable_width = 0;
  g_drawable_height = 0;
  write_acceptance_record();
  if (g_view != NULL) {
    send_void(g_view, "setNeedsDisplay");
  }
}

static int refresh_framebuffer(void) {
  const uint8_t *framebuffer = pocket_runtime_render();
  uint32_t width = pocket_runtime_width();
  uint32_t height = pocket_runtime_height();
  uint32_t stride = pocket_runtime_stride();
  size_t length = pocket_runtime_length();
  size_t required;

  if (framebuffer == NULL || width == 0 || height == 0 || stride < width * 4U) {
    fail_runtime("PocketJS returned an invalid framebuffer");
    return 0;
  }
  if ((size_t)height > ((size_t)-1) / (size_t)stride) {
    fail_runtime("PocketJS framebuffer dimensions overflow");
    return 0;
  }
  required = (size_t)stride * (size_t)height;
  if (length < required) {
    fail_runtime("PocketJS framebuffer is shorter than its stride");
    return 0;
  }

  g_framebuffer = framebuffer;
  g_framebuffer_width = width;
  g_framebuffer_height = height;
  g_framebuffer_stride = stride;
  g_framebuffer_length = length;
  g_drawable_width = (int32_t)width;
  g_drawable_height = (int32_t)height;
  return 1;
}

static int draw_framebuffer(CGContextRef context, CGRect bounds, CGRect dirty) {
  CGColorSpaceRef color_space;
  CGDataProviderRef provider;
  CGImageRef image;
  CGRect destination;

  if (
    g_framebuffer == NULL ||
    g_framebuffer_width == 0 ||
    g_framebuffer_height == 0 ||
    g_framebuffer_stride < g_framebuffer_width * 4U ||
    g_framebuffer_length < (size_t)g_framebuffer_stride * (size_t)g_framebuffer_height
  ) {
    fail_runtime("PocketJS framebuffer disappeared before drawing");
    return 0;
  }

  color_space = CGColorSpaceCreateDeviceRGB();
  if (color_space == NULL) {
    fail_runtime("CoreGraphics could not create an RGB color space");
    return 0;
  }
  provider = CGDataProviderCreateWithData(
    NULL,
    g_framebuffer,
    g_framebuffer_length,
    release_provider_data
  );
  if (provider == NULL) {
    CGColorSpaceRelease(color_space);
    fail_runtime("CoreGraphics could not create a framebuffer provider");
    return 0;
  }

  /*
   * The shared core currently exposes opaque ARGB32 words.  On little-endian
   * armv6 those words are B,G,R,A bytes, hence First + 32Little here.
   */
  image = CGImageCreate(
    (size_t)g_framebuffer_width,
    (size_t)g_framebuffer_height,
    8,
    32,
    (size_t)g_framebuffer_stride,
    color_space,
    POCKET_CG_ALPHA_PREMULTIPLIED_FIRST | POCKET_CG_BYTE_ORDER_32_LITTLE,
    provider,
    NULL,
    NO,
    POCKET_CG_RENDERING_INTENT_DEFAULT
  );
  if (image == NULL) {
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(color_space);
    fail_runtime("CoreGraphics could not create a framebuffer image");
    return 0;
  }

  destination.origin.x = 0.0f;
  destination.origin.y = 0.0f;
  destination.size.width = bounds.size.width;
  destination.size.height = bounds.size.height;
  if (destination.size.width <= 0.0f || destination.size.height <= 0.0f) {
    destination.size.width = (float)g_framebuffer_width;
    destination.size.height = (float)g_framebuffer_height;
  }

  /* CGImage rows are top-down while the 1.x Quartz draw context is y-up. */
  CGContextSaveGState(context);
  CGContextTranslateCTM(context, 0.0f, destination.size.height);
  CGContextScaleCTM(context, 1.0f, -1.0f);
  /*
   * After that flip the space is top-down with the origin at the top left,
   * which is the same space UIKit expressed `dirty` in, so it clips directly.
   * A degenerate rect means draw everything rather than nothing.
   */
  if (dirty.size.width > 0.0f && dirty.size.height > 0.0f) {
    CGContextClipToRect(context, dirty);
  }
  CGContextDrawImage(context, destination, image);
  CGContextRestoreGState(context);

  CGImageRelease(image);
  CGDataProviderRelease(provider);
  CGColorSpaceRelease(color_space);
  return 1;
}

static void update_touch_point(CGPoint point) {
  float local_x = point.x;
  float local_y = point.y;
  float view_width = g_content_frame.size.width;
  float view_height = g_content_frame.size.height;
  int logical_width = g_framebuffer_width == 0
    ? POCKET_LOGICAL_WIDTH
    : (int)g_framebuffer_width;
  int logical_height = g_framebuffer_height == 0
    ? POCKET_LOGICAL_HEIGHT
    : (int)g_framebuffer_height;

  if (view_width <= 0.0f) {
    view_width = (float)logical_width;
  }
  if (view_height <= 0.0f) {
    view_height = (float)logical_height;
  }

  g_touch_x = (int)(local_x * (float)logical_width / view_width);
  g_touch_y = (int)(local_y * (float)logical_height / view_height);
  if (g_touch_x < 0) {
    g_touch_x = 0;
  } else if (g_touch_x >= logical_width) {
    g_touch_x = logical_width - 1;
  }
  if (g_touch_y < 0) {
    g_touch_y = 0;
  } else if (g_touch_y >= logical_height) {
    g_touch_y = logical_height - 1;
  }
}

static int update_gsevent_location(id event) {
  typedef CGPoint (*GSEventLocationFunction)(GSEventRef event);
  static GSEventLocationFunction function;
  static int resolved;
  CGPoint point;

  if (!resolved) {
    void *handle = (void *)(intptr_t)-2; /* Darwin RTLD_DEFAULT. */
    function = (GSEventLocationFunction)dlsym(handle, "GSEventGetLocationInWindow");
    resolved = 1;
  }
  if (function == NULL) {
    return 0;
  }
  point = function((GSEventRef)event);
  point.x -= g_content_frame.origin.x;
  point.y -= g_content_frame.origin.y;
  update_touch_point(point);
  return 1;
}

static int update_uitouch_location(id self, id touches) {
  id touch;
  if (touches == NULL) {
    return 0;
  }
  touch = send_id(touches, "anyObject");
  if (touch == NULL) {
    return 0;
  }
  update_touch_point(send_point_object(touch, "locationInView:", self));
  return 1;
}

/*
 * OpenGL ES 1.1 presentation.
 *
 * The core ES 1.1 entry points are in the 1.1.4 OpenGLES.framework, so they
 * link normally. The framebuffer-object extension and EAGL are NOT — that
 * framework predates both — so every one of them is resolved at runtime, the
 * same way the 1.x GSEvent path is. That also means this whole block degrades
 * to "no GL" rather than "will not load" on anything that lacks them, and the
 * software rasterizer stays the fallback.
 */
#define POCKET_GL_FRAMEBUFFER_OES 0x8d40u
#define POCKET_GL_RENDERBUFFER_OES 0x8d41u
#define POCKET_GL_COLOR_ATTACHMENT0_OES 0x8ce0u
#define POCKET_GL_FRAMEBUFFER_COMPLETE_OES 0x8cd5u
#define POCKET_GL_RENDERBUFFER_WIDTH_OES 0x8d42u
#define POCKET_GL_RENDERBUFFER_HEIGHT_OES 0x8d43u

typedef void (*GlGenObjects)(int32_t count, uint32_t *names);
typedef void (*GlBindObject)(uint32_t target, uint32_t name);
typedef void (*GlFramebufferRenderbuffer)(
  uint32_t target,
  uint32_t attachment,
  uint32_t renderbuffer_target,
  uint32_t renderbuffer
);
typedef void (*GlGetRenderbufferParameteriv)(
  uint32_t target,
  uint32_t parameter,
  int32_t *value
);
typedef uint32_t (*GlCheckFramebufferStatus)(uint32_t target);
typedef void (*GlReadPixels)(
  int32_t x,
  int32_t y,
  int32_t width,
  int32_t height,
  uint32_t format,
  uint32_t type,
  void *pixels
);
typedef void (*GlDeleteObjects)(int32_t count, const uint32_t *names);

static id g_gl_context;
static uint32_t g_gl_framebuffer;
static uint32_t g_gl_renderbuffer;
static int g_gl_ready;
static int32_t g_gl_width;
static int32_t g_gl_height;

static GlGenObjects gl_gen_framebuffers;
static GlBindObject gl_bind_framebuffer;
static GlGenObjects gl_gen_renderbuffers;
static GlBindObject gl_bind_renderbuffer;
static GlFramebufferRenderbuffer gl_framebuffer_renderbuffer;
static GlGetRenderbufferParameteriv gl_get_renderbuffer_parameteriv;
static GlCheckFramebufferStatus gl_check_framebuffer_status;
static GlDeleteObjects gl_delete_framebuffers;
static GlDeleteObjects gl_delete_renderbuffers;

static BOOL send_bool_uint_object(
  id receiver,
  const char *selector,
  uint32_t target,
  id drawable
) {
  return ((BOOL (*)(id, SEL, uint32_t, id))objc_msgSend)(
    receiver,
    sel_registerName(selector),
    target,
    drawable
  );
}

static BOOL send_bool_uint(id receiver, const char *selector, uint32_t target) {
  return ((BOOL (*)(id, SEL, uint32_t))objc_msgSend)(
    receiver,
    sel_registerName(selector),
    target
  );
}

static id send_id_int(id receiver, const char *selector, int value) {
  return ((id (*)(id, SEL, int))objc_msgSend)(
    receiver,
    sel_registerName(selector),
    value
  );
}

static BOOL send_bool_class_object(Class cls, const char *selector, id value) {
  return ((BOOL (*)(Class, SEL, id))objc_msgSend)(
    cls,
    sel_registerName(selector),
    value
  );
}

/*
 * The layer class UIKit asks our view for.
 *
 * This MUST agree with whether we are going to use GL, because a CAEAGLLayer
 * never receives drawRect: — it is GL-backed. Returning it unconditionally left
 * the software fallback computing frames that were never composited to the
 * screen, and made its measured cost look artificially small. UIKit queries
 * this at view creation, before setup_gl runs, so the decision has to be made
 * from the same marker file setup_gl consults.
 */
static int pocket_prefers_gl(void) {
  return POCKET_GL_DEFAULT || access(POCKET_PREFER_GL_PATH, F_OK) == 0;
}

static Class pocket_layer_class(id self, SEL command) {
  (void)self;
  (void)command;
  if (pocket_prefers_gl()) {
    return objc_getClass("CAEAGLLayer");
  }
  return objc_getClass("CALayer");
}

static int resolve_gl_extension(void) {
  void *handle = (void *)(intptr_t)-2; /* Darwin RTLD_DEFAULT. */
  gl_gen_framebuffers = (GlGenObjects)dlsym(handle, "glGenFramebuffersOES");
  gl_bind_framebuffer = (GlBindObject)dlsym(handle, "glBindFramebufferOES");
  gl_gen_renderbuffers = (GlGenObjects)dlsym(handle, "glGenRenderbuffersOES");
  gl_bind_renderbuffer = (GlBindObject)dlsym(handle, "glBindRenderbufferOES");
  gl_framebuffer_renderbuffer =
    (GlFramebufferRenderbuffer)dlsym(handle, "glFramebufferRenderbufferOES");
  gl_get_renderbuffer_parameteriv =
    (GlGetRenderbufferParameteriv)dlsym(handle, "glGetRenderbufferParameterivOES");
  gl_check_framebuffer_status =
    (GlCheckFramebufferStatus)dlsym(handle, "glCheckFramebufferStatusOES");
  gl_delete_framebuffers = (GlDeleteObjects)dlsym(handle, "glDeleteFramebuffersOES");
  gl_delete_renderbuffers = (GlDeleteObjects)dlsym(handle, "glDeleteRenderbuffersOES");
  return gl_gen_framebuffers != NULL && gl_bind_framebuffer != NULL &&
    gl_gen_renderbuffers != NULL && gl_bind_renderbuffer != NULL &&
    gl_framebuffer_renderbuffer != NULL && gl_get_renderbuffer_parameteriv != NULL &&
    gl_check_framebuffer_status != NULL && gl_delete_framebuffers != NULL &&
    gl_delete_renderbuffers != NULL;
}

static void teardown_gl(void) {
  if (g_gl_context != NULL) {
    Class eagl = objc_getClass("EAGLContext");
    if (eagl != NULL) {
      send_bool_class_object(eagl, "setCurrentContext:", g_gl_context);
    }
  }
  /* The core's textures belong to this context, so release them while it is
   * still current — and only if it ever got as far as owning any. */
  if (g_gl_ready) {
    pocket_runtime_gl_shutdown();
  }
  if (g_gl_framebuffer != 0 && gl_delete_framebuffers != NULL) {
    gl_delete_framebuffers(1, &g_gl_framebuffer);
    g_gl_framebuffer = 0;
  }
  if (g_gl_renderbuffer != 0 && gl_delete_renderbuffers != NULL) {
    gl_delete_renderbuffers(1, &g_gl_renderbuffer);
    g_gl_renderbuffer = 0;
  }
  g_gl_ready = 0;
  g_gl_context = NULL;
  g_gl_width = 0;
  g_gl_height = 0;
  g_drawable_width = 0;
  g_drawable_height = 0;
}

/*
 * Build the drawable. Returns 0 for every failure, including "this OS has no
 * EAGL", so a false result is never a fatal condition — only a slower one.
 */
static int setup_gl(id view) {
  Class eagl = objc_getClass("EAGLContext");
  id layer;
  int32_t status;
  int forced_software;

  forced_software = !pocket_prefers_gl();
  if (forced_software) return 0;
  if (eagl == NULL || objc_getClass("CAEAGLLayer") == NULL) return 0;
  if (!resolve_gl_extension()) return 0;

  layer = send_id(view, "layer");
  if (layer == NULL || !responds_to(layer, "setOpaque:")) return 0;
  /* An opaque layer lets the window server skip blending the whole screen. */
  send_void_bool(layer, "setOpaque:", YES);

  g_gl_context = send_id_int(send_id((id)eagl, "alloc"), "initWithAPI:", 1);
  if (g_gl_context == NULL) return 0;
  if (!send_bool_class_object(eagl, "setCurrentContext:", g_gl_context)) {
    g_gl_context = NULL;
    return 0;
  }

  gl_gen_framebuffers(1, &g_gl_framebuffer);
  gl_bind_framebuffer(POCKET_GL_FRAMEBUFFER_OES, g_gl_framebuffer);
  gl_gen_renderbuffers(1, &g_gl_renderbuffer);
  gl_bind_renderbuffer(POCKET_GL_RENDERBUFFER_OES, g_gl_renderbuffer);
  if (g_gl_framebuffer == 0 || g_gl_renderbuffer == 0) {
    teardown_gl();
    return 0;
  }
  if (!send_bool_uint_object(
    g_gl_context,
    "renderbufferStorage:fromDrawable:",
    POCKET_GL_RENDERBUFFER_OES,
    layer
  )) {
    teardown_gl();
    return 0;
  }
  gl_framebuffer_renderbuffer(
    POCKET_GL_FRAMEBUFFER_OES,
    POCKET_GL_COLOR_ATTACHMENT0_OES,
    POCKET_GL_RENDERBUFFER_OES,
    g_gl_renderbuffer
  );
  status = (int32_t)gl_check_framebuffer_status(POCKET_GL_FRAMEBUFFER_OES);
  if ((uint32_t)status != POCKET_GL_FRAMEBUFFER_COMPLETE_OES) {
    teardown_gl();
    return 0;
  }
  gl_get_renderbuffer_parameteriv(
    POCKET_GL_RENDERBUFFER_OES,
    POCKET_GL_RENDERBUFFER_WIDTH_OES,
    &g_gl_width
  );
  gl_get_renderbuffer_parameteriv(
    POCKET_GL_RENDERBUFFER_OES,
    POCKET_GL_RENDERBUFFER_HEIGHT_OES,
    &g_gl_height
  );
  if (g_gl_width <= 0 || g_gl_height <= 0) {
    teardown_gl();
    return 0;
  }
  if (
    g_gl_width != POCKET_LOGICAL_WIDTH * POCKET_RASTER_DENSITY ||
    g_gl_height != POCKET_LOGICAL_HEIGHT * POCKET_RASTER_DENSITY
  ) {
    teardown_gl();
    return 0;
  }
  g_drawable_width = g_gl_width;
  g_drawable_height = g_gl_height;
  g_gl_ready = 1;
  return 1;
}

/* Shared by both capture paths: write `length` bytes and clear the request. */
static void write_capture(const uint8_t *pixels, size_t length) {
  int descriptor = open(POCKET_CAPTURE_OUTPUT_PATH, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  size_t written = 0;
  if (descriptor < 0) {
    return;
  }
  while (written < length) {
    ssize_t count = write(descriptor, pixels + written, length - written);
    if (count <= 0) break;
    written += (size_t)count;
  }
  (void)close(descriptor);
  (void)unlink(POCKET_CAPTURE_REQUEST_PATH);
}

/* The rasterizer's own framebuffer: top-down, ARGB32 words (BGRA bytes). */
static void capture_software_frame_if_requested(void) {
  if (access(POCKET_CAPTURE_REQUEST_PATH, F_OK) != 0) {
    return;
  }
  if (g_framebuffer == NULL || g_framebuffer_length == 0) {
    return;
  }
  write_capture(g_framebuffer, g_framebuffer_length);
}

/*
 * Read the just-drawn frame back off the GPU when asked. GL reports rows
 * bottom-up; the raw dump is left in that order and the host-side tool flips
 * it, so nothing here has an opinion about image formats.
 */
static void capture_frame_if_requested(void) {
  size_t length;
  uint8_t *pixels;

  if (access(POCKET_CAPTURE_REQUEST_PATH, F_OK) != 0) {
    return;
  }
  if (g_gl_width <= 0 || g_gl_height <= 0) {
    return;
  }
  length = (size_t)g_gl_width * (size_t)g_gl_height * 4U;
  pixels = (uint8_t *)malloc(length);
  if (pixels == NULL) {
    return;
  }
  glFinish();
  /* GL_RGBA + GL_UNSIGNED_BYTE is the one combination ES 1.1 always allows. */
  glReadPixels(0, 0, g_gl_width, g_gl_height, 0x1908U, 0x1401U, pixels);
  write_capture(pixels, length);
  free(pixels);
}

/*
 * Draw one frame through the GPU. Zero means fall back for good.
 *
 * `submitted_us` is set to the cost of walking the DrawList into GL, which is
 * the number that says whether there is headroom. The remaining time is
 * `presentRenderbuffer:` blocking until the next vsync — waiting, not working,
 * and it necessarily grows to fill the frame once the loop is display-synced.
 */
static int present_gl(unsigned long *submitted_us) {
  Class eagl = objc_getClass("EAGLContext");
  unsigned long started;
  if (!g_gl_ready || eagl == NULL) return 0;
  if (!send_bool_class_object(eagl, "setCurrentContext:", g_gl_context)) return 0;
  started = now_us();
  gl_bind_framebuffer(POCKET_GL_FRAMEBUFFER_OES, g_gl_framebuffer);
  if (!pocket_runtime_gl_render(g_gl_width, g_gl_height)) return 0;
  gl_bind_renderbuffer(POCKET_GL_RENDERBUFFER_OES, g_gl_renderbuffer);
  *submitted_us = now_us() - started;
  capture_frame_if_requested();
  return send_bool_uint(
    g_gl_context,
    "presentRenderbuffer:",
    POCKET_GL_RENDERBUFFER_OES
  ) ? 1 : 0;
}

static int boot_embedded_runtime(void) {
  size_t java_script_length = 0;
  size_t pack_length = 0;
  const uint8_t *java_script = getsectdata("__DATA", "__pocket_js", &java_script_length);
  const uint8_t *pack = getsectdata("__DATA", "__pocket_pak", &pack_length);

  /* The packager adds a C terminator for diagnostics; JS_Eval wants byte length. */
  if (java_script != NULL && java_script_length > 0 && java_script[java_script_length - 1] == 0) {
    java_script_length -= 1;
  }
  if (java_script == NULL || java_script_length == 0) {
    fail_runtime("Mach-O section __DATA,__pocket_js is missing or empty");
    return 0;
  }
  if (pack == NULL || pack_length == 0) {
    fail_runtime("Mach-O section __DATA,__pocket_pak is missing or empty");
    return 0;
  }
  if (!pocket_runtime_boot(
    (const char *)java_script,
    java_script_length,
    pack,
    pack_length,
    POCKET_LOGICAL_WIDTH,
    POCKET_LOGICAL_HEIGHT
  )) {
    fail_runtime(pocket_runtime_error());
    return 0;
  }

  g_state = POCKET_STATE_RUNNING;
  /*
   * GL comes up only after the core exists, because the backend allocates its
   * white texture and vertex buffer against the live Ui. Both halves must
   * succeed together or neither counts.
   */
  if (setup_gl(g_view)) {
    if (pocket_runtime_gl_initialize()) {
      g_renderer = "gles1";
      copy_status_message("Running on OpenGL ES 1.1");
    } else {
      teardown_gl();
    }
  }
#if POCKET_REQUIRE_GL
  if (!g_gl_ready) {
    fail_runtime("Required Retina OpenGL ES drawable is unavailable");
    return 0;
  }
#endif
  return 1;
}

/*
 * Ask UIKit to recomposite only the rectangle the core says changed.
 *
 * An empty damage plan means nothing changed, so nothing is invalidated and the
 * frame costs no composite at all — which is most frames for a UI that is
 * mostly still. When the plan is non-empty the rect is handed to
 * setNeedsDisplayInRect:, and drawRect: clips to whatever UIKit passes back.
 *
 * If setNeedsDisplayInRect: is unavailable, or the plan covers everything, this
 * degrades to invalidating the whole view — the behaviour it replaces.
 */
static void invalidate_damaged_region(void) {
  int bounds[4];
  CGRect dirty;

  if (g_view == NULL) {
    return;
  }
  if (!pocket_runtime_damage_bounds(bounds)) {
    /* Empty plan: the previous composite is still correct. */
    return;
  }
  if (!responds_to(g_view, "setNeedsDisplayInRect:")) {
    send_void(g_view, "setNeedsDisplay");
    return;
  }
  /* Damage is half-open logical pixels, top-left origin — the view's space. */
  dirty.origin.x = (float)bounds[0];
  dirty.origin.y = (float)bounds[1];
  dirty.size.width = (float)(bounds[2] - bounds[0]);
  dirty.size.height = (float)(bounds[3] - bounds[1]);
  if (dirty.size.width <= 0.0f || dirty.size.height <= 0.0f) {
    return;
  }
  g_damage_regions_last = (unsigned long)(bounds[2] - bounds[0]) *
    (unsigned long)(bounds[3] - bounds[1]);
  send_void_rect(g_view, "setNeedsDisplayInRect:", dirty);
}

static void pocket_tick(id self, SEL command, id timer) {
  int completed_touch;
  int delivered_touch;
  int reported_action;
  unsigned long frame_started_us;
  unsigned long present_started_us;
  unsigned long finished_us;
  unsigned long submitted_us = 0;
  (void)self;
  (void)command;
  (void)timer;

  if (g_state == POCKET_STATE_STARTING) {
    if (!boot_embedded_runtime()) {
      return;
    }
  }
  if (g_state != POCKET_STATE_RUNNING) {
    return;
  }

  if (g_touch_down && g_touch_needs_hit) {
    g_touch_hit = pocket_runtime_hit_test_bounds((float)g_touch_x, (float)g_touch_y);
    g_last_touch_hit = g_touch_hit;
    g_touch_needs_hit = 0;
  }
  delivered_touch = g_touch_down;
  frame_started_us = now_us();
  if (!pocket_runtime_frame(g_touch_down, g_touch_x, g_touch_y, g_touch_hit)) {
    fail_runtime(pocket_runtime_error());
    return;
  }
  present_started_us = now_us();
  g_guest_frames += 1;
  if (delivered_touch) {
    g_touch_was_sent = 1;
  }
  if (g_touch_release_after_frame) {
    g_touch_down = 0;
    g_touch_release_after_frame = 0;
  }
  completed_touch = !delivered_touch && g_touch_awaiting_completion;
  if (completed_touch) {
    g_completed_touch_sequences += 1;
    g_touch_awaiting_completion = 0;
  }
  reported_action = pocket_runtime_action_sequence() != g_observed_action_sequence;
  g_observed_action_sequence = pocket_runtime_action_sequence();
  if (g_gl_ready) {
    /*
     * On the GPU path the core walks its DrawList straight into GL, so there
     * is no framebuffer to publish and no drawRect: to schedule. A failure
     * here is not fatal: drop to the software rasterizer permanently and let
     * the next tick take the CGImage route.
     */
    if (!present_gl(&submitted_us)) {
      teardown_gl();
#if POCKET_REQUIRE_GL
      fail_runtime("Required OpenGL ES present failed");
      return;
#else
      g_renderer = "software-on-eagl-layer";
      /*
       * The view is already CAEAGLLayer-backed at this point, so drawRect: will
       * never fire and the rasterizer's output cannot reach the screen. Report
       * it as its own state rather than as a working software path.
       */
      copy_status_message("OpenGL ES present failed; layer cannot composite raster");
#endif
    }
  }
  if (!g_gl_ready) {
    if (!refresh_framebuffer()) {
      return;
    }
    /*
     * Capture the software framebuffer on request too. This is the test that
     * matters for a damage-limited rasterizer: the framebuffer persists across
     * frames and only damaged spans are rewritten, so under-reported damage
     * shows up as staleness that a from-scratch reference render will catch.
     */
    capture_software_frame_if_requested();
  }
  finished_us = now_us();
  if (finished_us >= frame_started_us) {
    g_frame_us_total += present_started_us - frame_started_us;
    g_present_us_total += finished_us - present_started_us;
    g_submit_us_total += submitted_us;
    g_timed_frames += 1;
  }
  if (g_guest_frames == 1 || completed_touch || reported_action ||
      g_guest_frames - g_last_record_attempt_frame >= POCKET_STATUS_HEARTBEAT_FRAMES) {
    {
      unsigned long closed_at = now_us();
      if (g_window_start_us != 0 && closed_at > g_window_start_us) {
        g_window_frames = g_guest_frames - g_window_start_frame;
        g_window_us = closed_at - g_window_start_us;
      }
      g_window_start_us = closed_at;
      g_window_start_frame = g_guest_frames;
    }
    if (g_timed_frames > 0) {
      g_frame_us_mean = g_frame_us_total / g_timed_frames;
      g_present_us_mean = g_present_us_total / g_timed_frames;
      g_submit_us_mean = g_submit_us_total / g_timed_frames;
      if (g_blit_frames > 0) {
        g_blit_us_mean = g_blit_us_total / g_blit_frames;
        g_blit_us_total = 0;
        g_blit_frames = 0;
      }
      g_frame_us_total = 0;
      g_present_us_total = 0;
      g_submit_us_total = 0;
      g_timed_frames = 0;
    }
    write_acceptance_record();
  }
  if (!g_gl_ready) {
    invalidate_damaged_region();
  }
}

static void pocket_draw_rect(id self, SEL command, CGRect rect) {
  CGContextRef context = current_graphics_context();
  CGRect bounds;
  unsigned long blit_started_us = now_us();
  (void)command;

  if (context == NULL) {
    if (g_state != POCKET_STATE_FAILED) {
      fail_runtime("UIKit did not expose a current graphics context");
    }
    return;
  }
  bounds = send_rect(self, "bounds");
  if (g_state == POCKET_STATE_RUNNING) {
    /*
     * `rect` is what UIKit decided needs recompositing, which is normally the
     * damage rectangle we asked for. Honouring it is the difference between
     * blitting 320x480 and blitting what changed. When UIKit has discarded the
     * backing store it passes the full bounds and this is a no-op, so no
     * preservation guarantee is being relied on.
     */
    if (!draw_framebuffer(context, bounds, rect)) {
      draw_status(context, bounds);
    }
  } else {
    draw_status(context, bounds);
  }
  g_blit_us_total += now_us() - blit_started_us;
  g_blit_frames += 1;
  g_composites += 1;
}

static void begin_touch(void) {
  g_touch_down = 1;
  g_touch_sequences += 1;
  g_touch_was_sent = 0;
  g_touch_release_after_frame = 0;
  g_touch_awaiting_completion = 0;
  if (g_state == POCKET_STATE_RUNNING) {
    g_touch_hit = pocket_runtime_hit_test_bounds((float)g_touch_x, (float)g_touch_y);
    g_last_touch_hit = g_touch_hit;
    g_touch_needs_hit = 0;
  } else {
    g_touch_hit = 0;
    g_touch_needs_hit = 1;
  }
}

static void end_touch(void) {
  if (!g_touch_down) {
    return;
  }
  g_touch_awaiting_completion = 1;
  if (g_touch_was_sent) {
    g_touch_down = 0;
    g_touch_hit = 0;
    g_touch_needs_hit = 0;
  } else {
    /* Keep a very short tap alive until at least one 60 Hz guest frame. */
    g_touch_release_after_frame = 1;
  }
}

static void pocket_mouse_down(id self, SEL command, id event) {
  (void)self;
  (void)command;
  if (update_gsevent_location(event)) {
    begin_touch();
  }
}

static void pocket_mouse_dragged(id self, SEL command, id event) {
  (void)self;
  (void)command;
  if (g_touch_down) {
    update_gsevent_location(event);
  }
}

static void pocket_mouse_up(id self, SEL command, id event) {
  (void)self;
  (void)command;
  if (!g_touch_down) {
    return;
  }
  update_gsevent_location(event);
  end_touch();
}

static void pocket_touches_began(
  id self,
  SEL command,
  id touches,
  id event
) {
  (void)command;
  (void)event;
  if (update_uitouch_location(self, touches)) {
    begin_touch();
  }
}

static void pocket_touches_moved(
  id self,
  SEL command,
  id touches,
  id event
) {
  (void)command;
  (void)event;
  if (g_touch_down) {
    (void)update_uitouch_location(self, touches);
  }
}

static void pocket_touches_ended(
  id self,
  SEL command,
  id touches,
  id event
) {
  (void)command;
  (void)event;
  if (g_touch_down) {
    (void)update_uitouch_location(self, touches);
    end_touch();
  }
}

/*
 * Build an NSString without linking Foundation's constant symbols, which is
 * how the default run-loop mode is named. NSDefaultRunLoopMode is exactly
 * @"kCFRunLoopDefaultMode".
 */
static id run_loop_default_mode(void) {
  Class string_class = objc_getClass("NSString");
  if (string_class == NULL) {
    return NULL;
  }
  return ((id (*)(id, SEL, const char *))objc_msgSend)(
    (id)string_class,
    sel_registerName("stringWithUTF8String:"),
    "kCFRunLoopDefaultMode"
  );
}

/* Returns the retained display link, or NULL when the OS predates it. */
static id start_display_link(void) {
  Class link_class = objc_getClass("CADisplayLink");
  Class run_loop_class = objc_getClass("NSRunLoop");
  id link;
  id run_loop;
  id mode;

  if (link_class == NULL || run_loop_class == NULL) {
    return NULL;
  }
  if (!responds_to((id)link_class, "displayLinkWithTarget:selector:")) {
    return NULL;
  }
  link = ((id (*)(id, SEL, id, SEL))objc_msgSend)(
    (id)link_class,
    sel_registerName("displayLinkWithTarget:selector:"),
    g_view,
    sel_registerName("pocketJSTick:")
  );
  if (link == NULL) {
    return NULL;
  }
  run_loop = send_id((id)run_loop_class, "currentRunLoop");
  mode = run_loop_default_mode();
  if (run_loop == NULL || mode == NULL) {
    return NULL;
  }
  ((void (*)(id, SEL, id, id))objc_msgSend)(
    link,
    sel_registerName("addToRunLoop:forMode:"),
    run_loop,
    mode
  );
  /* Autoreleased by the class method; the run loop keeps it alive, and the
   * host retains it so `invalidate` still has a valid receiver at shutdown. */
  return send_id(link, "retain");
}

static void launch_application(id self, id application) {
  Class hardware_class = objc_getClass("UIHardware");
  Class window_class = objc_getClass("UIWindow");
  CGRect frame;

  if (g_window != NULL) {
    return;
  }

  if (responds_to(application, "setStatusBarHidden:")) {
    send_void_bool(application, "setStatusBarHidden:", YES);
  } else {
    /* 4A102 otherwise reserves the 20 px status bar and reports 320x460. */
    send_void_float((id)hardware_class, "_setStatusBarHeight:", 0.0f);
    send_status_bar_mode(application, 2, 0, 0.0f, 0);
  }
  frame.origin.x = 0.0f;
  frame.origin.y = 0.0f;
  frame.size.width = (float)POCKET_LOGICAL_WIDTH;
  frame.size.height = (float)POCKET_LOGICAL_HEIGHT;
  g_content_frame = frame;
  if (responds_to(application, "setStatusBarHidden:")) {
    g_window = send_id_rect(send_id((id)window_class, "alloc"), "initWithFrame:", frame);
  } else {
    g_window = send_id_rect(
      send_id((id)window_class, "alloc"),
      "initWithContentRect:",
      frame
    );
  }
  g_view = send_id_rect(send_id(objc_getClass("PocketJSRuntimeView"), "alloc"), "initWithFrame:", frame);

  if (g_window == NULL || g_view == NULL) {
    g_state = POCKET_STATE_FAILED;
    copy_status_message("UIKit could not create the PocketJS window");
    return;
  }

  if (POCKET_RASTER_DENSITY > 1) {
    id layer;
    if (!responds_to(g_view, "setContentScaleFactor:")) {
      g_state = POCKET_STATE_FAILED;
      copy_status_message("UIKit view cannot configure Retina scale");
      write_acceptance_record();
      return;
    }
    send_void_float(g_view, "setContentScaleFactor:", (float)POCKET_RASTER_DENSITY);
    layer = send_id(g_view, "layer");
    if (layer != NULL && responds_to(layer, "setContentsScale:")) {
      send_void_float(layer, "setContentsScale:", (float)POCKET_RASTER_DENSITY);
    }
  }

  g_state = POCKET_STATE_STARTING;
  copy_status_message("Starting embedded demo");
  write_acceptance_record();
  if (responds_to(g_view, "setMultipleTouchEnabled:")) {
    send_void_bool(g_view, "setMultipleTouchEnabled:", NO);
  }
  if (responds_to(g_window, "makeKeyAndVisible")) {
    send_void_object(g_window, "addSubview:", g_view);
    send_void(g_window, "makeKeyAndVisible");
  } else {
    send_void_object(g_window, "setContentView:", g_view);
    send_void_object(g_window, "orderFront:", self);
    send_void_object(g_window, "makeKey:", self);
    send_void_bool(g_window, "_setHidden:", NO);
  }
  send_void(g_view, "setNeedsDisplay");

  /*
   * Prefer the display's own clock. CADisplayLink arrived in iPhone OS 3.1, so
   * it is resolved by name and NSTimer stays the fallback for anything older —
   * the record says which one actually drove the frames.
   */
  g_timer = start_display_link();
  if (g_timer != NULL) {
    g_clock = "displaylink";
  } else {
    g_timer = send_id_timer(
      (id)objc_getClass("NSTimer"),
      "scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:",
      1.0 / 60.0,
      g_view,
      sel_registerName("pocketJSTick:"),
      NULL,
      YES
    );
    g_clock = "nstimer";
  }
  if (g_timer == NULL) {
    fail_runtime("UIKit could not schedule the 60 Hz runtime timer");
  }
}

static void pocket_application_did_finish_launching(id self, SEL command, id application) {
  (void)command;
  launch_application(self, application);
}

static BOOL pocket_application_did_finish_launching_with_options(
  id self,
  SEL command,
  id application,
  id options
) {
  (void)command;
  (void)options;
  launch_application(self, application);
  return g_window == NULL ? NO : YES;
}

static void terminate_application(void) {
  if (g_state == POCKET_STATE_TERMINATED) {
    return;
  }
  stop_timer();
  g_state = POCKET_STATE_TERMINATED;
  copy_status_message("Application terminated");
  write_acceptance_record();
  teardown_gl();
  pocket_runtime_shutdown();
  g_framebuffer = NULL;
}

static void pocket_application_will_terminate(id self, SEL command) {
  (void)self;
  (void)command;
  terminate_application();
}

static void pocket_application_will_terminate_with_application(
  id self,
  SEL command,
  id application
) {
  (void)self;
  (void)command;
  (void)application;
  terminate_application();
}

static Class register_view_class(void) {
  Class cls = objc_allocateClassPair(objc_getClass("UIView"), "PocketJSRuntimeView", 0);
  BOOL methods_added;
  if (cls == NULL) {
    return objc_getClass("PocketJSRuntimeView");
  }
  methods_added = class_addMethod(
      cls,
      sel_registerName("drawRect:"),
      (void (*)(void))pocket_draw_rect,
      "v@:{CGRect={CGPoint=ff}{CGSize=ff}}"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("mouseDown:"),
      (void (*)(void))pocket_mouse_down,
      "v@:@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("mouseDragged:"),
      (void (*)(void))pocket_mouse_dragged,
      "v@:@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("mouseUp:"),
      (void (*)(void))pocket_mouse_up,
      "v@:@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("touchesBegan:withEvent:"),
      (void (*)(void))pocket_touches_began,
      "v@:@@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("touchesMoved:withEvent:"),
      (void (*)(void))pocket_touches_moved,
      "v@:@@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("touchesEnded:withEvent:"),
      (void (*)(void))pocket_touches_ended,
      "v@:@@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("touchesCancelled:withEvent:"),
      (void (*)(void))pocket_touches_ended,
      "v@:@@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("pocketJSTick:"),
      (void (*)(void))pocket_tick,
      "v@:@"
    );
  if (!methods_added) {
    return NULL;
  }
  /*
   * +layerClass is what makes UIKit back this view with a CAEAGLLayer instead
   * of a plain one, which is the only way to get a GL drawable. It goes on the
   * metaclass, and only when the class exists — on iPhone OS 1.x it does not,
   * and the view then stays an ordinary software-drawn UIView.
   */
  if (objc_getClass("CAEAGLLayer") != NULL) {
    Class meta = object_getClass((id)cls);
    if (meta != NULL) {
      class_addMethod(
        meta,
        sel_registerName("layerClass"),
        (void (*)(void))pocket_layer_class,
        "#@:"
      );
    }
  }
  objc_registerClassPair(cls);
  return cls;
}

static Class register_delegate_class(void) {
  Class cls = objc_allocateClassPair(objc_getClass("NSObject"), "PocketJSRuntimeDelegate", 0);
  BOOL methods_added;
  if (cls == NULL) {
    return objc_getClass("PocketJSRuntimeDelegate");
  }
  methods_added = class_addMethod(
      cls,
      sel_registerName("applicationDidFinishLaunching:"),
      (void (*)(void))pocket_application_did_finish_launching,
      "v@:@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("application:didFinishLaunchingWithOptions:"),
      (void (*)(void))pocket_application_did_finish_launching_with_options,
      "c@:@@"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("applicationWillTerminate"),
      (void (*)(void))pocket_application_will_terminate,
      "v@:"
    ) &&
    class_addMethod(
      cls,
      sel_registerName("applicationWillTerminate:"),
      (void (*)(void))pocket_application_will_terminate_with_application,
      "v@:@"
    );
  if (!methods_added) {
    return NULL;
  }
  objc_registerClassPair(cls);
  return cls;
}

int main(int argc, char **argv) {
  id pool;
  id delegate_name;
  Class string_class;

  if (register_view_class() == NULL || register_delegate_class() == NULL) {
    return 2;
  }

  pool = send_id(send_id((id)objc_getClass("NSAutoreleasePool"), "alloc"), "init");
  string_class = objc_getClass("NSString");
  delegate_name = send_id_object(
    (id)string_class,
    "stringWithCString:",
    (id)"PocketJSRuntimeDelegate"
  );

  {
    int result = UIApplicationMain(argc, argv, NULL, delegate_name);
    send_void(pool, "release");
    return result;
  }
}
