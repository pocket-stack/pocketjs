#ifndef POCKETJS_ROCKBOX_COMPAT_H
#define POCKETJS_ROCKBOX_COMPAT_H

#include "plugin.h"
#include <tlsf.h>

/* Rockbox's container_of type-check rejects QuickJS flexible-array members. */
#undef container_of
#define container_of(ptr, type, member) \
  ((type *)((char *)(ptr) - offsetof(type, member)))

/* QuickJS and the no_std Rust core share Rockbox's remaining plugin buffer. */
#define malloc tlsf_malloc
#define calloc tlsf_calloc
#define realloc tlsf_realloc
#define free tlsf_free

#define memcpy rb->memcpy
#define memmove rb->memmove
#define memset rb->memset
#define memcmp rb->memcmp
#define memchr rb->memchr
#define strlen rb->strlen
#define strcmp rb->strcmp
#define strncmp rb->strncmp
#define strcpy rb->strcpy
#define strncpy rb->strncpy
#define strchr rb->strchr
#define strrchr rb->strrchr
#define strstr rb->strstr
#define strtol rb->strtol
#define strtoul rb->strtoul
#define qsort rb->qsort
#define snprintf rb->snprintf
#define vsnprintf rb->vsnprintf

/* Rockbox deliberately ships a tiny math.h. The hardware build links
   newlib's soft-float libm, so expose the C99 declarations QuickJS needs. */
double acos(double);
double acosh(double);
double asin(double);
double asinh(double);
double atan(double);
double atan2(double, double);
double atanh(double);
double cbrt(double);
double ceil(double);
double cos(double);
double cosh(double);
double exp(double);
double expm1(double);
double fabs(double);
double floor(double);
double fmax(double, double);
double fmin(double, double);
double fmod(double, double);
double hypot(double, double);
double log(double);
double log1p(double);
double log2(double);
double log10(double);
double pow(double, double);
double round(double);
long int lrint(double);
double sin(double);
double sinh(double);
double sqrt(double);
double tan(double);
double tanh(double);
double trunc(double);

#ifndef isnan
#define isnan(value) __builtin_isnan(value)
#endif
#ifndef isfinite
#define isfinite(value) __builtin_isfinite(value)
#endif
#ifndef isinf
#define isinf(value) __builtin_isinf(value)
#endif
#ifndef signbit
#define signbit(value) __builtin_signbit(value)
#endif
#ifndef NAN
#define NAN __builtin_nanf("")
#endif
#ifndef INFINITY
#define INFINITY __builtin_inf()
#endif

void abort(void) __attribute__((noreturn));
void exit(int status) __attribute__((noreturn));

/* Hardware Rockbox deliberately omits stdio streams. QuickJS only uses these
   in its optional diagnostics, which stay silent in this plugin. */
#ifndef SIMULATOR
typedef void FILE;
#define stdout ((FILE *)0)
#define stderr ((FILE *)0)
#define putchar(value) (value)
#define fputc(value, stream) ((void)(stream), (value))
#define fwrite(ptr, size, count, stream) \
  ((void)(ptr), (void)(size), (void)(stream), (count))
#endif

/* Diagnostic-only QuickJS printers are retained but silent on-device. */
#define printf(...) ((void)0)
#define fprintf(stream, ...) ((void)(stream), 0)
#define puts(value) ((void)(value), 0)

#endif
