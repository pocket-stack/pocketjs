/*
 * Device-local receipt paths. Pocket Clear's are the defaults; a second app
 * on the same iPod (tools/ipodtouch4.ts selects it by POCKETJS_IPODTOUCH4_APP)
 * gets its own set through -D flags so two installed apps never share a
 * status file.
 */
#ifndef POCKET_ACCEPTANCE_PATH
#define POCKET_ACCEPTANCE_PATH "/private/var/tmp/pocketjs-ipodtouch4.status"
#endif
#ifndef POCKET_ACCEPTANCE_TEMP
#define POCKET_ACCEPTANCE_TEMP "/private/var/tmp/pocketjs-ipodtouch4.status.new"
#endif
#ifndef POCKET_CAPTURE_REQUEST_PATH
#define POCKET_CAPTURE_REQUEST_PATH "/private/var/tmp/pocketjs-ipodtouch4.capture"
#endif
#ifndef POCKET_CAPTURE_OUTPUT_PATH
#define POCKET_CAPTURE_OUTPUT_PATH "/private/var/tmp/pocketjs-ipodtouch4.frame.rgba"
#endif
#ifndef POCKET_PREFER_GL_PATH
#define POCKET_PREFER_GL_PATH "/private/var/tmp/pocketjs-ipodtouch4.gles1"
#endif
#define POCKET_GL_DEFAULT 1
#define POCKET_REQUIRE_GL 1

/*
 * The iPod touch 4 (iPod4,1, iOS 6.1.6) shares the iPhone 4S display tuple —
 * 320x480 logical at density 2 on a PowerVR SGX535 — and runs the same
 * runtime-registered UIKit host. Keeping one implementation keeps touch slot
 * tracking, hit facts, damage accounting, and hardware receipts identical
 * across legacy Apple devices; this wrapper only scopes device-local paths.
 */
#include "../iphone2g/runtime.c"
