#include "firmware_compat.h"
#include "kernel.h"
#include "panic.h"
#include <sys/time.h>

static int pocket_errno;
int *__errno(void) { return &pocket_errno; }

int gettimeofday(struct timeval *tv, void *timezone)
{
  (void)timezone;
  if (!tv) return -1;
  tv->tv_sec = current_tick / HZ;
  tv->tv_usec = (current_tick % HZ) * (1000000L / HZ);
  return 0;
}

void abort(void) { panicf("PocketRock runtime abort"); }
void exit(int status) { panicf("PocketRock runtime exit %d", status); }

void __aeabi_unwind_cpp_pr0(void) { abort(); }
void __aeabi_unwind_cpp_pr1(void) { abort(); }
void __aeabi_unwind_cpp_pr2(void) { abort(); }
