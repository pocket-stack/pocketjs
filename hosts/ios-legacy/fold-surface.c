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
static FoldQuaternion reference, attitude = {0,0,0,1};
static FoldQuaternion manual_attitude = {0,0,0,1};
static double angle, manual_degrees, last_timestamp;
static double normal_x, normal_y, normal_z = 1;
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
    if (active) {
      reference_valid = 0; last_timestamp = 0; angle = 0;
      attitude = (FoldQuaternion){0,0,0,1}; start_motion();
    }
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
  if (!isfinite(rate.x) || !isfinite(rate.y) || !isfinite(rate.z) ||
      !isfinite(gravity.x) || !isfinite(gravity.y) || !isfinite(gravity.z)) return;
  if (convention == -1) {
    double rows = -(gravity.x * raw.m[2] + gravity.y * raw.m[5] + gravity.z * raw.m[8]);
    double columns = -(gravity.x * raw.m[6] + gravity.y * raw.m[7] + gravity.z * raw.m[8]);
    if (fabs(rows - columns) > 0.2) {
      convention = rows > columns;
      /* Default is transpose. Resolving the same convention must not reset the
       * plane when the user first moves out of an ambiguous launch pose. */
      if (convention != 1) reference_valid = 0;
    }
  }
  double current[9];
  fold_device_matrix(raw.m, convention == -1 ? 1 : convention, current);
  FoldQuaternion current_attitude = fold_quaternion(current);
  if (!reference_valid || pending_calibrate) {
    reference = current_attitude;
    reference_valid = 1; pending_calibrate = 0;
    attitude = (FoldQuaternion){0,0,0,1};
    angle = 0; min_angle = 0; max_angle = 0; calibrations++;
  } else {
    FoldQuaternion prediction = fold_predict(fold_relative(reference, current_attitude),
      rate.x, rate.y, rate.z, 0.04);
    double alpha = 1 - pow(0.3, fold_clamp(dt, 0, 0.1) * 60);
    attitude = fold_smooth(attitude, prediction, alpha);
  }
  double rotation[9]; fold_matrix(attitude, rotation);
  normal_x = rotation[2]; normal_y = rotation[5]; normal_z = rotation[8];
  angle = acos(fold_clamp(normal_z, -1, 1));
  min_angle = fmin(min_angle, angle); max_angle = fmax(max_angle, angle);
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
    double degrees, yaw, pitch, roll; int consumed = 0;
    if (sscanf(command, "{\"op\":\"manual\",\"degrees\":%lf}%n", &degrees, &consumed) == 1 &&
        consumed == (int)length && isfinite(degrees) && fabs(degrees) <= 85) {
      manual_degrees = degrees;
      manual_attitude = fold_predict((FoldQuaternion){0,0,0,1},0,degrees*M_PI/180,0,1);
    } else {
      consumed = 0;
      if (sscanf(command, "{\"op\":\"pose\",\"yaw\":%lf,\"pitch\":%lf,\"roll\":%lf}%n",
          &yaw, &pitch, &roll, &consumed) != 3 || consumed != (int)length ||
          !isfinite(yaw) || !isfinite(pitch) || !isfinite(roll) ||
          fabs(yaw)>85 || fabs(pitch)>85 || fabs(roll)>85) return;
      FoldQuaternion q = fold_predict((FoldQuaternion){0,0,0,1},0,0,roll*M_PI/180,1);
      q = fold_predict(q,0,yaw*M_PI/180,0,1);
      manual_attitude = fold_predict(q,pitch*M_PI/180,0,0,1);
      double m[9]; fold_matrix(manual_attitude,m);
      manual_degrees = acos(fold_clamp(m[8],-1,1))*180/M_PI;
    }
    manual = 1;
  }
  dirty = 1;
}
static int status_json(char *out, size_t capacity) {
  return snprintf(out, capacity,
    "{\"t\":\"fold.state\",\"source\":%s,\"available\":%s,\"active\":%s,"
    "\"manual\":%s,\"degrees\":%.2f,\"sensorDegrees\":%.2f,\"samples\":%lu,"
    "\"calibrations\":%lu,\"minDegrees\":%.2f,\"maxDegrees\":%.2f,"
    "\"normalX\":%.5f,\"normalY\":%.5f,\"normalZ\":%.5f,"
    "\"rateY\":%.5f,\"sensorAgeMs\":%.2f,\"frames\":%lu,\"error\":\"%s\"}\n",
    loaded ? "true" : "false", available ? "true" : "false", active ? "true" : "false",
    manual ? "true" : "false", manual ? manual_degrees : angle * 180 / M_PI,
    angle * 180 / M_PI, samples, calibrations, min_angle * 180 / M_PI,
    max_angle * 180 / M_PI, normal_x, normal_y, normal_z,
    last_rate, sensor_age * 1000, frames, texture_error);
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

/* Projective (s,t,0,q) coordinates cancel the complete screen homography.
 * Clip along the two-dimensional blur gradient: seven blended bands plus
 * one capped-radius band need <= 15 draws and no per-frame texture uploads. */
static void band(const FoldPose *pose, const FoldPoint *polygon, int count, int level) {
  float positions[16], uv[32], colors[32];
  int passes = level < FOLD_LEVELS-1 && pose->lift > 0.00001 ? 2 : 1;
  for (int pass = 0; pass < passes; ++pass) {
    for (int i = 0; i < count; ++i) {
      double x = polygon[i].x, y = polygon[i].y;
      FoldRay ray = fold_ray(pose, x, y);
      positions[i*2] = x; positions[i*2+1] = y;
      uv[i*4] = (ray.x + FOLD_PADDING) * ray.depth / FOLD_TEXTURE_WIDTH;
      uv[i*4+1] = (ray.y + FOLD_PADDING) * ray.depth / FOLD_TEXTURE_HEIGHT;
      uv[i*4+2] = 0; uv[i*4+3] = ray.depth;
      colors[i*4] = colors[i*4+1] = colors[i*4+2] = ray.attenuation;
      colors[i*4+3] = pass ? fold_clamp((ray.radius - fold_radii[level]) /
        (fold_radii[level+1] - fold_radii[level]), 0, 1) : 1;
    }
    if (pass) { glEnable(0x0BE2); glBlendFunc(0x0302, 0x0303); }
    else glDisable(0x0BE2);
    glBindTexture(0x0DE1, textures[level+pass]);
    glVertexPointer(2, 0x1406, 0, positions);
    glTexCoordPointer(4, 0x1406, 0, uv);
    glColorPointer(4, 0x1406, 0, colors);
    glDrawArrays(0x0006, 0, count); /* GL_TRIANGLE_FAN */
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
  FoldQuaternion rotation = manual ? manual_attitude : attitude;
  FoldPose pose = fold_pose(rotation, FOLD_WIDTH, FOLD_HEIGHT, 2053.54);
  if (pose.rotation[8] <= 0) return 1; /* Back of the calibrated screen. */
  glActiveTexture(0x84C0); glClientActiveTexture(0x84C0);
  glBindBuffer(0x8892, 0); glBindBuffer(0x8893, 0);
  glMatrixMode(0x1701); glLoadIdentity(); glOrthof(0, FOLD_WIDTH, FOLD_HEIGHT, 0, -1, 1);
  glMatrixMode(0x1700); glLoadIdentity();
  glMatrixMode(0x1702); glLoadIdentity(); glMatrixMode(0x1700);
  glEnable(0x0DE1); glTexEnvi(0x2300, 0x2200, 0x2100); /* MODULATE */
  glEnableClientState(0x8074); glEnableClientState(0x8076); glEnableClientState(0x8078);
  FoldPoint screen[4] = {{0,0},{FOLD_WIDTH,0},{FOLD_WIDTH,FOLD_HEIGHT},{0,FOLD_HEIGHT}};
  if (pose.lift < 0.00001) band(&pose, screen, 4, 0);
  else for (int i = 0; i < FOLD_LEVELS; ++i) {
    FoldPoint first[8], polygon[8];
    int n = fold_clip(&pose, screen, 4, first, fold_radii[i]/0.12, 1);
    n = fold_clip(&pose, first, n, polygon,
      i+1 < FOLD_LEVELS ? fold_radii[i+1]/0.12 : pose.lift*2+1, 0);
    if (n >= 3) band(&pose, polygon, n, i);
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
