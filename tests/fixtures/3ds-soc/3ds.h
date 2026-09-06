#ifndef POCKETJS_SOC_TEST_3DS_H
#define POCKETJS_SOC_TEST_3DS_H
#include <stddef.h>
#include <stdint.h>
typedef int32_t Result;
#define R_FAILED(result) ((result) < 0)
uint64_t osGetTime(void);
Result socInit(uint32_t *buffer, size_t size);
void socExit(void);
#endif
