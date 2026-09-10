/* USB-side iOS 6 display capture. This helper runs outside the User app;
 * UIGetScreenImage reads the composed display, including the foreground app.
 * Keep SpringBoard in front when taking a desktop snapshot. */
#include <dlfcn.h>
#include <stdio.h>
#include <unistd.h>

typedef void *id;
extern id objc_getClass(const char *name);
extern id sel_registerName(const char *name);
extern void *objc_msgSend(void);
extern id UIImagePNGRepresentation(id image);
extern void CGImageRelease(id image);
extern unsigned long CGImageGetWidth(id image);
extern unsigned long CGImageGetHeight(id image);
static id send0(id object, const char *selector) {
  return ((id (*)(id, id))objc_msgSend)(object, sel_registerName(selector));
}
static id send1(id object, const char *selector, id value) {
  return ((id (*)(id, id, id))objc_msgSend)(object, sel_registerName(selector), value);
}
int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: screen-capture <output.png>\n"); return 2; }
  id pool = send0(send0(objc_getClass("NSAutoreleasePool"), "alloc"), "init");
  id (*capture)(void) = dlsym(RTLD_DEFAULT, "UIGetScreenImage");
  id image = capture ? capture() : NULL;
  if (!image) { fprintf(stderr, "UIGetScreenImage unavailable\n"); return 1; }
  id data = UIImagePNGRepresentation(send1(objc_getClass("UIImage"), "imageWithCGImage:", image));
  unsigned long length = (unsigned long)send0(data, "length");
  FILE *out = fopen(argv[1], "wb");
  int ok = out && data && fwrite(send0(data, "bytes"), 1, length, out) == length;
  if (out && fclose(out)) ok = 0;
  if (ok) printf("display=%lux%lu bytes=%lu\n", CGImageGetWidth(image), CGImageGetHeight(image), length);
  CGImageRelease(image);
  send0(pool, "release");
  return ok ? 0 : 1;
}
