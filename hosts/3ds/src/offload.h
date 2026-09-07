#ifndef POCKET_OFFLOAD_H
#define POCKET_OFFLOAD_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
bool offload_start(void);
void offload_stop(void);
void offload_frame(void);
void offload_measure(unsigned microseconds);
void offload_measure_parts(unsigned ui, unsigned prepare, unsigned submit);
int offload_session(void);
bool offload_submit(const char *bytes, size_t length);
size_t offload_take(char *out);
const uint8_t *offload_image(uint32_t token, unsigned *width, unsigned *height);
const uint8_t *offload_mesh(uint32_t token, unsigned *length);
void offload_release_image(uint32_t token);
void offload_reset(void);
#endif
