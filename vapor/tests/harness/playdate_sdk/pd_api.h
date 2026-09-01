#ifndef POCKET_VAPOR_PLAYDATE_SDK_SHIM_H
#define POCKET_VAPOR_PLAYDATE_SDK_SHIM_H

#include <stdint.h>

typedef enum {
  kButtonLeft = 1 << 0,
  kButtonRight = 1 << 1,
  kButtonUp = 1 << 2,
  kButtonDown = 1 << 3,
  kButtonB = 1 << 4,
  kButtonA = 1 << 5,
} PDButtons;

typedef enum {
  kEventInit,
  kEventInitLua,
  kEventLock,
  kEventUnlock,
  kEventPause,
  kEventResume,
  kEventTerminate,
  kEventKeyPressed,
  kEventKeyReleased,
  kEventLowPower,
  kEventMirrorStarted,
  kEventMirrorEnded,
} PDSystemEvent;

typedef int PDCallbackFunction(void *userdata);

struct playdate_sys {
  void (*logToConsole)(const char *fmt, ...);
  void (*setUpdateCallback)(PDCallbackFunction *update, void *userdata);
  void (*getButtonState)(PDButtons *current, PDButtons *pushed, PDButtons *released);
  float (*getCrankChange)(void);
  int (*isCrankDocked)(void);
};

struct playdate_graphics {
  uint8_t *(*getFrame)(void);
  void (*markUpdatedRows)(int start, int end);
};

struct playdate_display {
  void (*setRefreshRate)(float rate);
};

typedef struct PlaydateAPI {
  const struct playdate_sys *system;
  const void *file;
  const struct playdate_graphics *graphics;
  const void *sprite;
  const struct playdate_display *display;
  const void *sound;
  const void *lua;
  const void *json;
  const void *scoreboards;
  const void *network;
} PlaydateAPI;

#endif
