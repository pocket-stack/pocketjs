/* Host-test stand-in for <3ds.h>: the handful of libctru symbols the Pocket
 * Runtime socket pump uses, so hosts/3ds/src/devserver.c runs as an ordinary
 * process against the desktop client. */
#ifndef POCKETJS_TEST_3DS_STUB_H
#define POCKETJS_TEST_3DS_STUB_H

#include <stdint.h>
#include <stdlib.h>
#include <sys/time.h>
#include <unistd.h>

typedef uint64_t u64;

static inline u64 osGetTime(void) {
  struct timeval time;
  gettimeofday(&time, NULL);
  return (u64)time.tv_sec * 1000u + (u64)time.tv_usec / 1000u;
}

static inline void *linearAlloc(size_t bytes) {
  return malloc(bytes);
}

static inline void linearFree(void *bytes) {
  free(bytes);
}

#endif
