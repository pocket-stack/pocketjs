#include <stdlib.h>

/*
 * The no-std Rust core is built with panic=abort, but its objects still
 * reference the unwinding personality symbol on targets whose system
 * libraries expect one. Defining it here keeps the native link free of an
 * unwinder; reaching it would already be a fatal defect, so it aborts.
 */
__attribute__((noreturn)) void rust_eh_personality(void)
{
  abort();
}
