#include "pocket_runtime.h"

#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

/*
 * iPhone OS 1.1.4 UIKit host for PocketJS.
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
#define POCKET_LOGICAL_WIDTH 320
#define POCKET_LOGICAL_HEIGHT 480
#define POCKET_STATUS_CAPACITY 256
#define POCKET_STATUS_COLUMNS 42
#define POCKET_STATUS_LINES 5
#define POCKET_ACCEPTANCE_PATH "/private/var/tmp/pocketjs-iphone2g.status"
#define POCKET_ACCEPTANCE_TEMP "/private/var/tmp/pocketjs-iphone2g.status.new"
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
extern BOOL class_addMethod(Class cls, SEL name, void (*implementation)(void), const char *types);
extern SEL sel_registerName(const char *name);
extern void *objc_msgSend(void);
extern void *objc_msgSend_stret(void);

extern int UIApplicationMain(int argc, char **argv, id principal_class_name, id delegate_class_name);
extern CGContextRef UICurrentContext(void);
extern CGPoint GSEventGetLocationInWindow(GSEventRef event);
extern uint8_t *getsectdata(const char *segment_name, const char *section_name, size_t *size);

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

static int g_touch_down;
static int g_touch_x;
static int g_touch_y;
static int g_touch_hit;
static int g_touch_needs_hit;
static int g_touch_was_sent;
static int g_touch_release_after_frame;
static int g_record_next_frame;
static unsigned long g_guest_frames;
static unsigned long g_touch_sequences;

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

/* Best-effort, device-local proof fetched through the scoped USB SSH helper. */
static void write_acceptance_record(void) {
  char record[640];
  const char *state = g_state == POCKET_STATE_RUNNING
    ? "running"
    : g_state == POCKET_STATE_FAILED
      ? "failed"
      : g_state == POCKET_STATE_TERMINATED ? "terminated" : "starting";
  int length = snprintf(
    record,
    sizeof(record),
    "schema=1\nbuild_id=%s\nstate=%s\nguest_frames=%lu\ntouch_sequences=%lu\n"
    "touch_down=%d\nlast_touch_x=%d\nlast_touch_y=%d\nlast_touch_hit=%d\nerror=%s\n",
    POCKET_BUILD_ID,
    state,
    g_guest_frames,
    g_touch_sequences,
    g_touch_down,
    g_touch_x,
    g_touch_y,
    g_touch_hit,
    g_state == POCKET_STATE_FAILED ? g_status_message : ""
  );
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
  if (written == (size_t)length) {
    (void)fsync(descriptor);
  }
  (void)close(descriptor);
  if (written == (size_t)length) {
    (void)rename(POCKET_ACCEPTANCE_TEMP, POCKET_ACCEPTANCE_PATH);
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
    draw_text(context, 18.0f, fill.size.height - 112.0f, "JS + PAK / 320x480 / 30 Hz", 13.0f);
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
  return 1;
}

static int draw_framebuffer(CGContextRef context, CGRect bounds) {
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
  CGContextDrawImage(context, destination, image);
  CGContextRestoreGState(context);

  CGImageRelease(image);
  CGDataProviderRelease(provider);
  CGColorSpaceRelease(color_space);
  return 1;
}

static void update_touch_location(id event) {
  CGPoint point = GSEventGetLocationInWindow((GSEventRef)event);
  float local_x = point.x - g_content_frame.origin.x;
  float local_y = point.y - g_content_frame.origin.y;
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
  return 1;
}

static void pocket_tick(id self, SEL command, id timer) {
  int delivered_touch;
  int record_this_frame;
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
    g_touch_needs_hit = 0;
  }
  record_this_frame = g_record_next_frame;
  g_record_next_frame = 0;
  delivered_touch = g_touch_down;
  if (!pocket_runtime_frame(g_touch_down, g_touch_x, g_touch_y, g_touch_hit)) {
    fail_runtime(pocket_runtime_error());
    return;
  }
  g_guest_frames += 1;
  if (delivered_touch) {
    g_touch_was_sent = 1;
  }
  if (g_touch_release_after_frame) {
    g_touch_down = 0;
    g_touch_release_after_frame = 0;
  }
  if (!refresh_framebuffer()) {
    return;
  }
  if (g_guest_frames == 1 || delivered_touch || record_this_frame) {
    write_acceptance_record();
  }
  send_void(g_view, "setNeedsDisplay");
}

static void pocket_draw_rect(id self, SEL command, CGRect rect) {
  CGContextRef context = UICurrentContext();
  CGRect bounds;
  (void)command;
  (void)rect;

  if (context == NULL) {
    return;
  }
  bounds = send_rect(self, "bounds");
  if (g_state == POCKET_STATE_RUNNING) {
    if (!draw_framebuffer(context, bounds)) {
      draw_status(context, bounds);
    }
  } else {
    draw_status(context, bounds);
  }
}

static void pocket_mouse_down(id self, SEL command, id event) {
  (void)self;
  (void)command;
  update_touch_location(event);
  g_touch_down = 1;
  g_touch_sequences += 1;
  g_touch_was_sent = 0;
  g_touch_release_after_frame = 0;
  if (g_state == POCKET_STATE_RUNNING) {
    g_touch_hit = pocket_runtime_hit_test_bounds((float)g_touch_x, (float)g_touch_y);
    g_touch_needs_hit = 0;
  } else {
    g_touch_hit = 0;
    g_touch_needs_hit = 1;
  }
}

static void pocket_mouse_dragged(id self, SEL command, id event) {
  (void)self;
  (void)command;
  if (g_touch_down) {
    update_touch_location(event);
  }
}

static void pocket_mouse_up(id self, SEL command, id event) {
  (void)self;
  (void)command;
  if (!g_touch_down) {
    return;
  }
  update_touch_location(event);
  g_record_next_frame = 1;
  if (g_touch_was_sent) {
    g_touch_down = 0;
    g_touch_hit = 0;
    g_touch_needs_hit = 0;
  } else {
    /* Keep a very short tap alive until at least one 30 Hz guest frame. */
    g_touch_release_after_frame = 1;
  }
}

static void pocket_application_did_finish_launching(id self, SEL command, id application) {
  Class hardware_class = objc_getClass("UIHardware");
  Class window_class = objc_getClass("UIWindow");
  CGRect frame;
  (void)command;

  /* 4A102 otherwise reserves the 20 px status bar and reports a 320x460 rect. */
  send_void_float((id)hardware_class, "_setStatusBarHeight:", 0.0f);
  send_status_bar_mode(application, 2, 0, 0.0f, 0);
  frame.origin.x = 0.0f;
  frame.origin.y = 0.0f;
  frame.size.width = (float)POCKET_LOGICAL_WIDTH;
  frame.size.height = (float)POCKET_LOGICAL_HEIGHT;
  g_content_frame = frame;
  g_window = send_id_rect(send_id((id)window_class, "alloc"), "initWithContentRect:", frame);
  g_view = send_id_rect(send_id(objc_getClass("PocketJSRuntimeView"), "alloc"), "initWithFrame:", frame);

  if (g_window == NULL || g_view == NULL) {
    g_state = POCKET_STATE_FAILED;
    copy_status_message("UIKit could not create the PocketJS window");
    return;
  }

  g_state = POCKET_STATE_STARTING;
  copy_status_message("Starting embedded demo");
  write_acceptance_record();
  send_void_object(g_window, "setContentView:", g_view);
  send_void_object(g_window, "orderFront:", self);
  send_void_object(g_window, "makeKey:", self);
  send_void_bool(g_window, "_setHidden:", NO);
  send_void(g_view, "setNeedsDisplay");

  g_timer = send_id_timer(
    (id)objc_getClass("NSTimer"),
    "scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:",
    1.0 / 30.0,
    g_view,
    sel_registerName("pocketJSTick:"),
    NULL,
    YES
  );
  if (g_timer == NULL) {
    fail_runtime("UIKit could not schedule the 30 Hz runtime timer");
  }
  (void)application;
}

static void pocket_application_will_terminate(id self, SEL command) {
  (void)self;
  (void)command;
  stop_timer();
  g_state = POCKET_STATE_TERMINATED;
  copy_status_message("Application terminated");
  write_acceptance_record();
  pocket_runtime_shutdown();
  g_framebuffer = NULL;
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
      sel_registerName("pocketJSTick:"),
      (void (*)(void))pocket_tick,
      "v@:@"
    );
  if (!methods_added) {
    return NULL;
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
      sel_registerName("applicationWillTerminate"),
      (void (*)(void))pocket_application_will_terminate,
      "v@:"
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
