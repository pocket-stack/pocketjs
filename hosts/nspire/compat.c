/* Bare-metal compatibility for the single-threaded Ndless process. */

#include <stdint.h>

uint8_t __atomic_load_1(const volatile void *pointer, int order) {
  (void)order;
  return *(const volatile uint8_t *)pointer;
}

uint16_t __atomic_load_2(const volatile void *pointer, int order) {
  (void)order;
  return *(const volatile uint16_t *)pointer;
}

unsigned int __atomic_load_4(const volatile void *pointer, int order) {
  (void)order;
  return *(const volatile unsigned int *)pointer;
}

void __atomic_store_1(volatile void *pointer, uint8_t value, int order) {
  (void)order;
  *(volatile uint8_t *)pointer = value;
}

void __atomic_store_2(volatile void *pointer, uint16_t value, int order) {
  (void)order;
  *(volatile uint16_t *)pointer = value;
}

void __atomic_store_4(volatile void *pointer, unsigned int value, int order) {
  (void)order;
  *(volatile unsigned int *)pointer = value;
}

/* Arch's generic ARM Newlib references this hook; Ndless owns teardown. */
void _fini(void) {}
