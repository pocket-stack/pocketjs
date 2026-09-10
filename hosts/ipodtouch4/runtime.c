#include <stdio.h>

/* Every User app owns its tmp directory. Resolve it at runtime because iOS
 * chooses a container UUID at installation and may change it on update. */
extern void *NSTemporaryDirectory(void);
extern void *sel_registerName(const char *name);
extern void *objc_msgSend(void);
static const char *pocket_ipod_receipt_path(unsigned index, const char *suffix) {
  static char paths[5][4096];
  if (!paths[index][0]) {
    const char *tmp = ((const char *(*)(void *, void *))objc_msgSend)(
      NSTemporaryDirectory(), sel_registerName("UTF8String"));
    snprintf(paths[index], sizeof(paths[index]), "%spocketjs.%s", tmp, suffix);
  }
  return paths[index];
}
#define POCKET_ACCEPTANCE_PATH pocket_ipod_receipt_path(0, "status")
#define POCKET_ACCEPTANCE_TEMP pocket_ipod_receipt_path(1, "status.new")
#define POCKET_CAPTURE_REQUEST_PATH pocket_ipod_receipt_path(2, "capture")
#define POCKET_CAPTURE_OUTPUT_PATH pocket_ipod_receipt_path(3, "frame.rgba")
#define POCKET_PREFER_GL_PATH pocket_ipod_receipt_path(4, "gles1")
#define POCKET_GL_DEFAULT 1
#define POCKET_REQUIRE_GL 1

#ifdef POCKET_FOLD_SURFACE
#if POCKET_LOGICAL_WIDTH != 320 || POCKET_LOGICAL_HEIGHT != 480
#error "Pocket Fold requires a 320x480 portrait viewport"
#endif
#include "../ios-legacy/fold-surface.h"
#define POCKET_SVC_STATE_NAME() "local-fold"
#define POCKET_GL_BACKGROUND_RENDER(w, h) pocket_fold_render(w, h)
#define POCKET_GL_BACKGROUND_SHUTDOWN() pocket_fold_shutdown()
#define POCKET_HOST_ACTIVE(active) pocket_fold_active(active)
#endif

/* The iPod touch 4 shares the iPhone 4S legacy UIKit implementation. */
#include "../ios-legacy/runtime.c"
