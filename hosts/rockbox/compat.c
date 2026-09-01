#include "compat.h"

#include <sys/time.h>

static int pocket_errno;

int *__errno(void) { return &pocket_errno; }

int gettimeofday(struct timeval *tv, void *timezone) {
  long ticks;
  (void)timezone;
  if (tv == 0) return -1;
  ticks = *rb->current_tick;
  tv->tv_sec = ticks / HZ;
  tv->tv_usec = (ticks % HZ) * (1000000L / HZ);
  return 0;
}

void abort(void) {
  rb->splash(HZ * 3, "PocketJS: native abort");
  exit(PLUGIN_ERROR);
  while (true) { }
}

/* Rust is built with panic=abort. These personality symbols are still named
   by ARM exception metadata but must never begin a real unwind in Rockbox. */
void __aeabi_unwind_cpp_pr0(void) { abort(); }
void __aeabi_unwind_cpp_pr1(void) { abort(); }
void __aeabi_unwind_cpp_pr2(void) { abort(); }
