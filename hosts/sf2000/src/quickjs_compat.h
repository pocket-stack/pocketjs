#pragma once

/*
 * QuickJS already has a small single-threaded MIPS/newlib path for PSP.
 * UniFrog uses the same constraints: no process environment, no timezone
 * database, and no useful pthread-backed Atomics implementation inside a
 * libretro module.  Select that path without pretending the Rust target is a
 * PSP target (the JSValue ABI remains the normal 32-bit NaN-boxed ABI).
 */
#define __PSP__ 1
