#include <windows.h>

#include "wm6_quickjs_abi.h"

static int append_file_name(WCHAR *path, unsigned int capacity,
                            const WCHAR *name)
{
    unsigned int length;
    unsigned int index;

    length = 0;
    while (path[length] != L'\0')
        length++;
    while (length > 0 && path[length - 1] != L'\\')
        length--;
    index = 0;
    while (name[index] != L'\0' && length + index + 1 < capacity) {
        path[length + index] = name[index];
        index++;
    }
    path[length + index] = L'\0';
    return name[index] == L'\0';
}

static char *read_cards_bundle(unsigned int *length)
{
    WCHAR path[MAX_PATH];
    HANDLE file;
    DWORD size;
    DWORD read;
    char *bytes;

    *length = 0;
    if (!GetModuleFileName(NULL, path, MAX_PATH))
        return NULL;
    if (!append_file_name(path, MAX_PATH, L"PocketJS.WM6.Cards.js"))
        return NULL;
    file = CreateFile(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE)
        return NULL;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size == 0) {
        CloseHandle(file);
        return NULL;
    }
    bytes = (char *)LocalAlloc(LMEM_FIXED, size + 1);
    if (!bytes) {
        CloseHandle(file);
        return NULL;
    }
    if (!ReadFile(file, bytes, size, &read, NULL) || read != size) {
        LocalFree(bytes);
        CloseHandle(file);
        return NULL;
    }
    CloseHandle(file);
    bytes[size] = '\0';
    *length = size;
    return bytes;
}

static void ascii_to_wide(WCHAR *output, unsigned int capacity,
                          const char *text)
{
    unsigned int index;

    if (capacity == 0)
        return;
    index = 0;
    while (text && text[index] != '\0' && index + 1 < capacity) {
        unsigned char ch = (unsigned char)text[index];
        output[index] = ch < 128 ? (WCHAR)ch : L'?';
        index++;
    }
    output[index] = L'\0';
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show)
{
    static const char snapshot[] = "__wm6Snapshot()";
    HMODULE module;
    wm6_qjs_abi_version_fn abi_version;
    wm6_qjs_create_fn create_runtime;
    wm6_qjs_eval_fn eval;
    wm6_qjs_drain_jobs_fn drain_jobs;
    wm6_qjs_destroy_fn destroy_runtime;
    wm6_qjs_handle runtime;
    char result[256];
    char *bundle;
    char *snapshot_text;
    unsigned int bundle_length;
    WCHAR *message;
    int status;

    (void)instance;
    (void)previous;
    (void)command;
    (void)show;

    module = LoadLibrary(L"PocketJS.WM6.QuickJS.dll");
    if (!module) {
        MessageBox(NULL, L"LoadLibrary failed", L"PocketJS QuickJS Host", MB_OK);
        return 1;
    }
    abi_version = (wm6_qjs_abi_version_fn)GetProcAddress(
        module, L"wm6_qjs_abi_version");
    create_runtime = (wm6_qjs_create_fn)GetProcAddress(
        module, L"wm6_qjs_create");
    eval = (wm6_qjs_eval_fn)GetProcAddress(module, L"wm6_qjs_eval");
    drain_jobs = (wm6_qjs_drain_jobs_fn)GetProcAddress(
        module, L"wm6_qjs_drain_jobs");
    destroy_runtime = (wm6_qjs_destroy_fn)GetProcAddress(
        module, L"wm6_qjs_destroy");
    if (!abi_version || !create_runtime || !eval ||
        !drain_jobs || !destroy_runtime) {
        FreeLibrary(module);
        MessageBox(NULL, L"QuickJS ABI export missing",
                   L"PocketJS QuickJS Host", MB_OK);
        return 2;
    }
    if (abi_version() != WM6_QJS_ABI_VERSION) {
        FreeLibrary(module);
        MessageBox(NULL, L"QuickJS ABI version mismatch",
                   L"PocketJS QuickJS Host", MB_OK);
        return 3;
    }

    runtime = create_runtime(8u * 1024u * 1024u, 256u * 1024u,
                             result, sizeof(result));
    if (!runtime) {
        ascii_to_wide(message, 256, result);
        FreeLibrary(module);
        MessageBox(NULL, message, L"QuickJS create failed", MB_OK);
        return 4;
    }
    bundle = read_cards_bundle(&bundle_length);
    snapshot_text = (char *)LocalAlloc(LMEM_FIXED, 8192);
    message = (WCHAR *)LocalAlloc(LMEM_FIXED, 8192 * sizeof(WCHAR));
    if (!bundle || !snapshot_text || !message) {
        if (bundle) LocalFree(bundle);
        if (snapshot_text) LocalFree(snapshot_text);
        if (message) LocalFree(message);
        destroy_runtime(runtime);
        FreeLibrary(module);
        MessageBox(NULL, L"Cards bundle allocation failed",
                   L"PocketJS QuickJS Host", MB_OK);
        return 5;
    }
    status = eval(runtime, bundle, bundle_length,
                  result, sizeof(result));
    if (status == 0)
        status = drain_jobs(runtime, result, sizeof(result)) < 0 ? -1 : 0;
    if (status == 0)
        status = eval(runtime, snapshot, sizeof(snapshot) - 1,
                      snapshot_text, 8192);
    LocalFree(bundle);
    destroy_runtime(runtime);
    FreeLibrary(module);

    ascii_to_wide(message, 8192, status == 0 ? snapshot_text : result);
    MessageBox(NULL, message,
               status == 0 ? L"PocketJS Cards bundle mounted"
                           : L"PocketJS QuickJS DLL failure",
               MB_OK);
    LocalFree(snapshot_text);
    LocalFree(message);
    return status == 0 ? 0 : 5;
}
