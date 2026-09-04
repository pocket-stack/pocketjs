#include "../../hosts/3ds/src/offload_queue.h"
#include "../../hosts/3ds/src/offload_coverage.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
static OffloadQueue queue;
static void *produce(void *unused) {
  (void)unused;
  for (uint32_t i = 0; i < 100000; i++) {
    char bytes[OFFLOAD_BYTES]; memset(bytes, i & 255, sizeof bytes);
    while (!offload_push(&queue, bytes, sizeof bytes, i)) {}
  }
  return NULL;
}
int main(void) {
  _Static_assert(ATOMIC_INT_LOCK_FREE == 2, "UI queue requires lock-free atomics");
  uint8_t rgba[512 * 16 * 4];
  assert(coverage_decode("5OTk", 4, 12, 1, 0xff123456, rgba) == 16);
  for (unsigned i = 0; i < 12; i++) {
    assert(rgba[i * 4] == 0x56 && rgba[i * 4 + 1] == 0x34 && rgba[i * 4 + 2] == 0x12);
    assert(rgba[i * 4 + 3] == (i % 4) * 85);
  }
  assert(rgba[12 * 4] == 0);
  assert(!coverage_decode("!!!!", 4, 12, 1, 0, rgba));
  assert(!coverage_decode("5OTk", 4, 516, 1, 0, rgba));
  assert(!coverage_decode("5OTk", 4, 12, 17, 0, rgba));
  char byte = 0; OffloadRecord record;
  assert(!offload_pop(&queue, &record));
  assert(!offload_push(&queue, &byte, OFFLOAD_BYTES + 1, 0));
  for (int i = 0; i < OFFLOAD_SLOTS; i++) assert(offload_push(&queue, &byte, 1, i));
  assert(!offload_push(&queue, &byte, 1, 9));
  for (int i = 0; i < OFFLOAD_SLOTS; i++) { assert(offload_pop(&queue, &record)); assert(record.generation == (uint32_t)i); }
  // Exercise monotonic counters over uint32 wrap.
  atomic_store(&queue.read, UINT32_MAX - 4); atomic_store(&queue.write, UINT32_MAX - 4);
  pthread_t thread; assert(!pthread_create(&thread, NULL, produce, NULL));
  for (uint32_t i = 0; i < 100000; i++) {
    while (!offload_pop(&queue, &record)) {}
    assert(record.generation == i && record.length == OFFLOAD_BYTES);
    for (int j = 0; j < OFFLOAD_BYTES; j++) assert((unsigned char)record.bytes[j] == (i & 255));
  }
  pthread_join(thread, NULL); puts("100000 SPSC records verified, including full, empty and counter wrap");
}
