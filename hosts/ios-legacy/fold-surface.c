/* Pocket Fold's local service and ES 1.1 background. Core Motion, textures,
 * and projection stay on the host. The guest owns the controls. No network
 * service, SpringBoard injection, or per-frame image upload is involved. */
#include "fold-surface.h"
#include "fold-math.h"
#include "pocket_host_service.h"
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void *id;
extern id objc_getClass(const char *name);
extern id sel_registerName(const char *name);
extern void *objc_msgSend(void);
extern void *objc_msgSend_stret(void);
extern id NSHomeDirectory(void);
extern id NSTemporaryDirectory(void);
static id send0(id object, const char *selector) {
  return ((id (*)(id, id))objc_msgSend)(object, sel_registerName(selector));
}
static double number(id object, const char *selector) {
  return ((double (*)(id, id))objc_msgSend)(object, sel_registerName(selector));
}
typedef struct { double x, y, z; } MotionVector;
typedef struct { double m[9]; } MotionMatrix;
static MotionVector vector(id object, const char *selector) {
  MotionVector value;
  ((void (*)(MotionVector *, id, id))objc_msgSend_stret)(&value, object, sel_registerName(selector));
  return value;
}

/* Fixed-function ES 1.1 declarations avoid current SDK availability metadata. */
extern void glGenTextures(int n, unsigned *textures);
extern void glDeleteTextures(int n, const unsigned *textures);
extern void glBindTexture(unsigned target, unsigned texture);
extern void glTexParameteri(unsigned target, unsigned name, int value);
extern void glTexImage2D(unsigned target, int level, int internal, int w, int h, int border, unsigned format, unsigned type, const void *data);
extern void glActiveTexture(unsigned texture);
extern void glClientActiveTexture(unsigned texture);
extern void glEnable(unsigned value);
extern void glDisable(unsigned value);
extern void glEnableClientState(unsigned value);
extern void glDisableClientState(unsigned value);
extern void glBindBuffer(unsigned target, unsigned buffer);
extern void glViewport(int x, int y, int w, int h);
extern void glClearColor(float r, float g, float b, float a);
extern void glClear(unsigned mask);
extern void glMatrixMode(unsigned mode);
extern void glLoadIdentity(void);
extern void glOrthof(float left, float right, float bottom, float top, float near, float far);
extern void glTexEnvi(unsigned target, unsigned name, int value);
extern void glBlendFunc(unsigned source, unsigned destination);
extern void glVertexPointer(int size, unsigned type, int stride, const void *data);
extern void glTexCoordPointer(int size, unsigned type, int stride, const void *data);
extern void glColorPointer(int size, unsigned type, int stride, const void *data);
extern void glDrawArrays(unsigned mode, int first, int count);
extern unsigned glGetError(void);

static id manager;
static unsigned textures[FOLD_LEVELS];
static int initialized, available, active = 1, loaded, opened, manual;
static int reference_valid, convention = -1, pending_calibrate;
static double reference[9], angle, manual_degrees, last_timestamp;
static double min_angle, max_angle, last_rate, sensor_age;
static unsigned long samples, calibrations, frames;
static int dirty = 1;
static char asset_path[4096], status_path[4096], control_path[4096];
static const char *texture_error = "snapshot-missing";

static void start_motion(void) {
  if (manager && available && active) {
    ((void (*)(id, id, double))objc_msgSend)(manager,
      sel_registerName("setDeviceMotionUpdateInterval:"), 1.0 / 100.0);
    ((void (*)(id, id, unsigned))objc_msgSend)(manager,
      sel_registerName("startDeviceMotionUpdatesUsingReferenceFrame:"), 1U);
  }
}
void pocket_fold_active(int value) {
  active = value;
  if (manager) {
    if (active) { reference_valid = 0; last_timestamp = 0; angle = 0; start_motion(); }
    else send0(manager, "stopDeviceMotionUpdates");
  }
  dirty = 1;
}

static void initialize(void) {
  initialized = 1;
  const char *home = (const char *)send0(NSHomeDirectory(), "UTF8String");
  const char *tmp = (const char *)send0(NSTemporaryDirectory(), "UTF8String");
  snprintf(asset_path, sizeof asset_path, "%s/Documents/fold-textures.bin", home);
  snprintf(status_path, sizeof status_path, "%sfold.status.json", tmp);
  snprintf(control_path, sizeof control_path, "%sfold.command", tmp);
  dlopen("/System/Library/Frameworks/CoreMotion.framework/CoreMotion", RTLD_NOW);
  manager = send0(send0(objc_getClass("CMMotionManager"), "alloc"), "init");
  available = manager && ((signed char (*)(id, id))objc_msgSend)(manager,
    sel_registerName("isDeviceMotionAvailable"));
  if (!available) manual = 1;
  start_motion();

  FILE *file = fopen(asset_path, "rb");
  const size_t bytes = FOLD_TEXTURE_WIDTH * FOLD_TEXTURE_HEIGHT * 4;
  char magic[8];
  if (!file) return;
  if (fread(magic, 1, 8, file) != 8 || memcmp(magic, "PFOLD001", 8)) {
    fclose(file); texture_error = "snapshot-format"; return;
  }
  unsigned char *pixels = malloc(bytes);
  if (!pixels) { fclose(file); texture_error = "snapshot-memory"; return; }
  glActiveTexture(0x84C0); /* GL_TEXTURE0 */
  glGenTextures(FOLD_LEVELS, textures);
  loaded = 1;
  for (int i = 0; i < FOLD_LEVELS; ++i) {
    if (fread(pixels, 1, bytes, file) != bytes) { loaded = 0; break; }
    glBindTexture(0x0DE1, textures[i]);
    glTexParameteri(0x0DE1, 0x2801, 0x2601); /* MIN/MAG: LINEAR */
    glTexParameteri(0x0DE1, 0x2800, 0x2601);
    glTexParameteri(0x0DE1, 0x2802, 0x812F); /* S/T: CLAMP_TO_EDGE, black padding */
    glTexParameteri(0x0DE1, 0x2803, 0x812F);
    glTexImage2D(0x0DE1, 0, 0x1908, FOLD_TEXTURE_WIDTH, FOLD_TEXTURE_HEIGHT,
      0, 0x1908, 0x1401, pixels);
    if (glGetError()) { loaded = 0; break; }
  }
  if (fgetc(file) != EOF) loaded = 0;
  fclose(file); free(pixels);
  texture_error = loaded ? "" : "snapshot-upload";
  if (!loaded) { glDeleteTextures(FOLD_LEVELS, textures); memset(textures, 0, sizeof textures); }
}

static void sample_motion(void) {
  if (!available || !active) return;
  id motion = send0(manager, "deviceMotion");
  if (!motion) return;
  double timestamp = number(motion, "timestamp");
  double now = number(send0(objc_getClass("NSProcessInfo"), "processInfo"), "systemUptime");
  sensor_age = fmax(0, now - timestamp);
  if (!isfinite(timestamp) || !isfinite(now) || timestamp <= last_timestamp || sensor_age > 0.25) return;
  double dt = last_timestamp ? timestamp - last_timestamp : 1.0 / 60.0;
  last_timestamp = timestamp;
  MotionMatrix raw;
  ((void (*)(MotionMatrix *, id, id))objc_msgSend_stret)(&raw,
    send0(motion, "attitude"), sel_registerName("rotationMatrix"));
  MotionVector gravity = vector(motion, "gravity");
  MotionVector rate = vector(motion, "rotationRate");
  for (int i = 0; i < 9; ++i) if (!isfinite(raw.m[i])) return;
  if (!isfinite(rate.y) || !isfinite(gravity.x) || !isfinite(gravity.y) || !isfinite(gravity.z)) return;
  if (convention == -1) {
    double rows = -(gravity.x * raw.m[2] + gravity.y * raw.m[5] + gravity.z * raw.m[8]);
    double columns = -(gravity.x * raw.m[6] + gravity.y * raw.m[7] + gravity.z * raw.m[8]);
    if (fabs(rows - columns) > 0.2) {
      convention = rows > columns;
      reference_valid = 0; /* Never compare poses in different matrix conventions. */
    }
  }
  double current[9];
  fold_device_matrix(raw.m, convention == -1 ? 1 : convention, current);
  if (!reference_valid || pending_calibrate) {
    memcpy(reference, current, sizeof reference);
    reference_valid = 1; pending_calibrate = 0;
    angle = 0; min_angle = 0; max_angle = 0; calibrations++;
  } else {
    double prediction = fold_tilt(reference, current) + rate.y * 0.04;
    double alpha = 1 - pow(0.3, fold_clamp(dt, 0, 0.1) * 60);
    angle += (fold_clamp(prediction, -1.48353, 1.48353) - angle) * alpha;
    min_angle = fmin(min_angle, angle); max_angle = fmax(max_angle, angle);
  }
  samples++; last_rate = rate.y;
}

int pocket_host_service_open(const char *name) {
  opened = !strcmp(name, "duo-fold"); dirty = 1; return opened;
}
void pocket_host_service_send(const char *line, size_t length) {
  if (!opened || !line || length > 96 || memchr(line, 0, length)) return;
  char command[97]; memcpy(command, line, length); command[length] = 0;
  if (!strcmp(command, "{\"op\":\"calibrate\"}")) {
    pending_calibrate = 1; manual = 0;
  } else if (!strcmp(command, "{\"op\":\"motion\"}")) {
    manual = !available;
  } else {
    double degrees; int consumed = 0;
    if (sscanf(command, "{\"op\":\"manual\",\"degrees\":%lf}%n", &degrees, &consumed) != 1 ||
        consumed != (int)length || !isfinite(degrees) || degrees < -85 || degrees > 85) return;
    manual = 1; manual_degrees = degrees;
  }
  dirty = 1;
}
static int status_json(char *out, size_t capacity) {
  return snprintf(out, capacity,
    "{\"t\":\"fold.state\",\"source\":%s,\"available\":%s,\"active\":%s,"
    "\"manual\":%s,\"degrees\":%.2f,\"sensorDegrees\":%.2f,\"samples\":%lu,"
    "\"calibrations\":%lu,\"minDegrees\":%.2f,\"maxDegrees\":%.2f,"
    "\"rateY\":%.5f,\"sensorAgeMs\":%.2f,\"frames\":%lu,\"error\":\"%s\"}\n",
    loaded ? "true" : "false", available ? "true" : "false", active ? "true" : "false",
    manual ? "true" : "false", manual ? manual_degrees : angle * 180 / M_PI,
    angle * 180 / M_PI, samples, calibrations, min_angle * 180 / M_PI,
    max_angle * 180 / M_PI, last_rate, sensor_age * 1000, frames, texture_error);
}
size_t pocket_host_service_poll(char *out, size_t capacity) {
  if (!opened || !dirty || capacity < 640) return 0;
  int n = status_json(out, capacity); dirty = 0;
  return n > 0 && (size_t)n < capacity ? (size_t)n : 0;
}

static void telemetry(void) {
  if (frames % 6 == 0) {
    dirty = 1;
    /* Bounded, app-container command file for reproducible on-device captures.
     * It uses the same validator as the guest service. */
    FILE *control = fopen(control_path, "rb");
    if (control) {
      char command[97]; size_t n = fread(command, 1, sizeof command, control);
      fclose(control); unlink(control_path);
      pocket_host_service_send(command, n);
    }
  }
  if (frames % 60 == 0) {
    char state[640]; int n = status_json(state, sizeof state);
    char temporary[4112]; snprintf(temporary, sizeof temporary, "%s.new", status_path);
    FILE *file = fopen(temporary, "wb");
    if (file) {
      int ok = n > 0 && n < (int)sizeof state && fwrite(state, 1, n, file) == (size_t)n;
      if (fclose(file)) ok = 0;
      if (ok) rename(temporary, status_path);
    }
  }
}

/* Projective (s,t,0,q) texture coordinates reproduce the ray-plane mapping
 * within each quad. Linear interpolation between baked disk-blur levels
 * replaces Metal's per-pixel 32-tap kernel. Seven bands need <= 14 draws. */
static void band(double x0, double x1, int level, double tilt) {
  float positions[20], uv[40], colors[40];
  for (int pass = 0; pass < 2; ++pass) {
    for (int column = 0; column < 5; ++column) {
      double x = x0 + (x1 - x0) * column / 4;
      for (int row = 0; row < 2; ++row) {
        int i = column * 2 + row;
        double y = row * FOLD_HEIGHT;
        FoldRay ray = fold_ray(x, y, tilt, FOLD_WIDTH, FOLD_HEIGHT, 2053.54);
        positions[i*2] = x; positions[i*2+1] = y;
        uv[i*4] = (ray.x + FOLD_PADDING) * ray.depth / FOLD_TEXTURE_WIDTH;
        uv[i*4+1] = (ray.y + FOLD_PADDING) * ray.depth / FOLD_TEXTURE_HEIGHT;
        uv[i*4+2] = 0; uv[i*4+3] = ray.depth;
        colors[i*4] = colors[i*4+1] = colors[i*4+2] = ray.attenuation;
        colors[i*4+3] = pass ? fold_clamp((ray.radius - fold_radii[level]) /
          (fold_radii[level+1] - fold_radii[level]), 0, 1) : 1;
      }
    }
    if (pass) { glEnable(0x0BE2); glBlendFunc(0x0302, 0x0303); }
    else glDisable(0x0BE2);
    glBindTexture(0x0DE1, textures[level+pass]);
    glVertexPointer(2, 0x1406, 0, positions);
    glTexCoordPointer(4, 0x1406, 0, uv);
    glColorPointer(4, 0x1406, 0, colors);
    glDrawArrays(0x0005, 0, 10);
    if (fabs(tilt) < 0.00001) break;
  }
}

int pocket_fold_render(int width, int height) {
  if (!initialized) initialize();
  sample_motion(); frames++; telemetry();
  glDisable(0x0C11); glDisable(0x0B71); glDisable(0x0B44); /* scissor, depth, cull */
  glDisable(0x0B50); glDisable(0x0BC0); glDisable(0x0B90); /* lighting, alpha, stencil */
  glViewport(0, 0, width, height);
  glClearColor(0, 0, 0, 1); glClear(0x4000);
  if (!loaded) return 1;
  glActiveTexture(0x84C0); glClientActiveTexture(0x84C0);
  glBindBuffer(0x8892, 0); glBindBuffer(0x8893, 0);
  glMatrixMode(0x1701); glLoadIdentity(); glOrthof(0, FOLD_WIDTH, FOLD_HEIGHT, 0, -1, 1);
  glMatrixMode(0x1700); glLoadIdentity();
  glMatrixMode(0x1702); glLoadIdentity(); glMatrixMode(0x1700);
  glEnable(0x0DE1); glTexEnvi(0x2300, 0x2200, 0x2100); /* MODULATE */
  glEnableClientState(0x8074); glEnableClientState(0x8076); glEnableClientState(0x8078);
  double tilt = manual ? manual_degrees * M_PI / 180 : angle;
  double spread = 0.12 * sin(fabs(tilt));
  if (spread < 0.00001) band(0, FOLD_WIDTH, 0, 0);
  else for (int i = 0; i < FOLD_LEVELS-1; ++i) {
    double d0 = fmin(FOLD_WIDTH, fold_radii[i] / spread);
    double d1 = fmin(FOLD_WIDTH, fold_radii[i+1] / spread);
    if (d1 <= d0) continue;
    double x0 = tilt > 0 ? FOLD_WIDTH-d1 : d0;
    double x1 = tilt > 0 ? FOLD_WIDTH-d0 : d1;
    band(x0, x1, i, tilt);
  }
  glDisableClientState(0x8076); /* core sets the remaining UI state */
  return glGetError() == 0;
}
void pocket_fold_shutdown(void) {
  if (manager) { send0(manager, "stopDeviceMotionUpdates"); send0(manager, "release"); manager = NULL; }
  if (loaded) glDeleteTextures(FOLD_LEVELS, textures);
  memset(textures, 0, sizeof textures); loaded = 0; initialized = 0;
  reference_valid = 0; last_timestamp = 0;
}
