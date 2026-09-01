#ifndef POCKETROCK_FIRMWARE_COMPAT_H
#define POCKETROCK_FIRMWARE_COMPAT_H

#include "config.h"
#include "system.h"
#include <stddef.h>
#include <stdint.h>
#include <tlsf.h>

#undef container_of
#define container_of(ptr, type, member) \
  ((type *)((char *)(ptr) - offsetof(type, member)))

#define malloc tlsf_malloc
#define calloc tlsf_calloc
#define realloc tlsf_realloc
#define free tlsf_free

double acos(double); double acosh(double); double asin(double); double asinh(double);
double atan(double); double atan2(double, double); double atanh(double); double cbrt(double);
double ceil(double); double cos(double); double cosh(double); double exp(double);
double expm1(double); double fabs(double); double floor(double); double fmax(double, double);
double fmin(double, double); double fmod(double, double); double hypot(double, double);
double log(double); double log1p(double); double log2(double); double log10(double);
double pow(double, double); double round(double); long int lrint(double);
double sin(double); double sinh(double); double sqrt(double); double tan(double);
double tanh(double); double trunc(double);

#define isnan(value) __builtin_isnan(value)
#define isfinite(value) __builtin_isfinite(value)
#define isinf(value) __builtin_isinf(value)
#define signbit(value) __builtin_signbit(value)
#define NAN __builtin_nanf("")
#define INFINITY __builtin_inf()

void abort(void) __attribute__((noreturn));
void exit(int status) __attribute__((noreturn));

typedef void FILE;
#define stdout ((FILE *)0)
#define stderr ((FILE *)0)
#define putchar(value) (value)
#define fputc(value, stream) ((void)(stream), (value))
#define fwrite(ptr, size, count, stream) \
  ((void)(ptr), (void)(size), (void)(stream), (count))
#define printf(...) ((void)0)
#define fprintf(stream, ...) ((void)(stream), 0)
#define puts(value) ((void)(value), 0)

#endif
