#pragma once

#include <inttypes.h>
#include <stdarg.h>
#include <stddef.h>

typedef struct __dc_file FILE;

extern FILE *stdout;

int printf(const char *format, ...);

int sprintf(char *str, const char *format, ...);

int snprintf(char *str, size_t size, const char *format, ...);

int vsnprintf(char *str, size_t size, const char *format, va_list ap);

int fputc(int c, FILE *stream);

int fprintf(FILE *stream, const char *format, ...);

size_t fwrite(const void *ptr, size_t size, size_t nitems, FILE *stream);

#define putchar(str) (0)

void debug_log(const char *str, int a);
