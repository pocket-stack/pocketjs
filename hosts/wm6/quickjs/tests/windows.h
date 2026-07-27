#ifndef POCKETJS_WM6_NATIVE_TEST_WINDOWS_H
#define POCKETJS_WM6_NATIVE_TEST_WINDOWS_H

/*
 * The WM6 runtime only needs these Win32 spellings for its DLL entry point.
 * Native integration tests compile the exact production source on Linux and
 * replace no runtime behavior beyond the unused loader callback.
 */
typedef int BOOL;
typedef void *HANDLE;
typedef unsigned long DWORD;
typedef void *LPVOID;

#define WINAPI
#define TRUE 1
#define __cdecl
#define __declspec(value)

#endif
