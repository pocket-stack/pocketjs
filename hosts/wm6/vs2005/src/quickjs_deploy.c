#include <windows.h>

#include "wm6_quickjs_abi.h"
#include "wm6_framebuffer.h"

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

static unsigned char *read_neighbor_file(
    const WCHAR *name,
    unsigned int *length)
{
    WCHAR path[MAX_PATH];
    HANDLE file;
    DWORD size;
    DWORD read;
    unsigned char *bytes;

    *length = 0;
    if (!GetModuleFileName(NULL, path, MAX_PATH))
        return NULL;
    if (!append_file_name(path, MAX_PATH, name))
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
    bytes = (unsigned char *)LocalAlloc(LMEM_FIXED, size + 1);
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

static int g_framebuffer_ready;
static HMODULE g_quickjs_module;
static wm6_qjs_handle g_quickjs_runtime;
static wm6_qjs_frame_fn g_quickjs_frame;
static wm6_qjs_destroy_fn g_quickjs_destroy;
static unsigned int g_buttons;
static DEVMODE g_original_display_mode;
static int g_display_rotated;

static void restore_display_orientation(void);

static int rotate_display_90(void)
{
    DEVMODE current;
    DEVMODE requested;
    LONG status;

    memset(&current, 0, sizeof(current));
    current.dmSize = sizeof(current);
    if (!EnumDisplaySettings(NULL, ENUM_CURRENT_SETTINGS, &current))
        return 0;
    if (current.dmDisplayOrientation == DMDO_90 &&
        GetSystemMetrics(SM_CXSCREEN) > GetSystemMetrics(SM_CYSCREEN))
        return 1;
    g_original_display_mode = current;
    requested = current;
    requested.dmFields = DM_DISPLAYORIENTATION;
    requested.dmDisplayOrientation = DMDO_90;
    status = ChangeDisplaySettingsEx(
        NULL, &requested, NULL, CDS_TEST, NULL);
    if (status != DISP_CHANGE_SUCCESSFUL)
        return 0;
    /*
     * Windows CE also uses CDS_TEST with DM_DISPLAYORIENTATION to return the
     * current orientation in this field, so restore the requested value.
     */
    requested.dmDisplayOrientation = DMDO_90;
    status = ChangeDisplaySettingsEx(
        NULL, &requested, NULL, CDS_RESET, NULL);
    if (status != DISP_CHANGE_SUCCESSFUL)
        return 0;
    g_display_rotated = 1;
    if (GetSystemMetrics(SM_CXSCREEN) <= GetSystemMetrics(SM_CYSCREEN)) {
        restore_display_orientation();
        return 0;
    }
    return 1;
}

static void restore_display_orientation(void)
{
    DEVMODE requested;

    if (!g_display_rotated)
        return;
    requested = g_original_display_mode;
    requested.dmFields = DM_DISPLAYORIENTATION;
    ChangeDisplaySettingsEx(NULL, &requested, NULL, CDS_RESET, NULL);
    g_display_rotated = 0;
}

static unsigned int button_for_key(WPARAM key)
{
    switch (key) {
    case VK_UP:
        return 0x0010u;
    case VK_RIGHT:
        return 0x0020u;
    case VK_DOWN:
        return 0x0040u;
    case VK_LEFT:
        return 0x0080u;
    case VK_RETURN:
    case VK_SPACE:
        return 0x2000u;
    }
    return 0;
}

static int render_core_frame(void)
{
    const unsigned char *pixels;
    unsigned int width;
    unsigned int height;
    unsigned int stride;
    unsigned int byte_length;

    if (!g_quickjs_runtime || !g_quickjs_frame || !g_framebuffer_ready)
        return 0;
    width = height = stride = byte_length = 0;
    pixels = g_quickjs_frame(
        g_quickjs_runtime,
        g_buttons,
        &width,
        &height,
        &stride,
        &byte_length);
    if (!pixels ||
        !wm6_framebuffer_copy_argb(
            pixels, width, height, stride, byte_length) ||
        !wm6_framebuffer_present()) {
        g_framebuffer_ready = 0;
        return 0;
    }
    return 1;
}

static LRESULT CALLBACK DemoWindowProc(HWND window, UINT message,
                                       WPARAM wparam, LPARAM lparam)
{
    switch (message) {
    case WM_PAINT:
        {
            PAINTSTRUCT paint;
            HDC dc = BeginPaint(window, &paint);
            if (g_framebuffer_ready && !wm6_framebuffer_present())
                g_framebuffer_ready = 0;
            if (!g_framebuffer_ready)
                FillRect(
                    dc, &paint.rcPaint,
                    (HBRUSH)GetStockObject(BLACK_BRUSH));
            EndPaint(window, &paint);
        }
        return 0;
    case WM_TIMER:
        render_core_frame();
        return 0;
    case WM_KEYDOWN:
        g_buttons |= button_for_key(wparam);
        if (wparam == VK_ESCAPE) {
            DestroyWindow(window);
            return 0;
        }
        return 0;
    case WM_KEYUP:
        g_buttons &= ~button_for_key(wparam);
        return 0;
    case WM_DESTROY:
        KillTimer(window, 1);
        wm6_framebuffer_close();
        if (g_quickjs_destroy && g_quickjs_runtime)
            g_quickjs_destroy(g_quickjs_runtime);
        g_quickjs_runtime = NULL;
        if (g_quickjs_module)
            FreeLibrary(g_quickjs_module);
        g_quickjs_module = NULL;
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(window, message, wparam, lparam);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show)
{
    static const WCHAR class_name[] = L"PocketJSWM6Demo";
    HMODULE module;
    wm6_qjs_abi_version_fn abi_version;
    wm6_qjs_create_fn create_runtime;
    wm6_qjs_set_pak_fn set_pak;
    wm6_qjs_eval_fn eval;
    wm6_qjs_drain_jobs_fn drain_jobs;
    wm6_qjs_frame_fn frame;
    wm6_qjs_destroy_fn destroy_runtime;
    wm6_qjs_handle runtime;
    char result[256];
    unsigned char *bundle;
    unsigned char *pak;
    unsigned int bundle_length;
    unsigned int pak_length;
    WCHAR create_error[256];
    WCHAR *message;
    WNDCLASS window_class;
    HWND window;
    MSG message_loop;
    int rotation_ready;
    int status;
    int viewport_height;
    int viewport_width;

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
    set_pak = (wm6_qjs_set_pak_fn)GetProcAddress(
        module, L"wm6_qjs_set_pak");
    frame = (wm6_qjs_frame_fn)GetProcAddress(
        module, L"wm6_qjs_frame");
    destroy_runtime = (wm6_qjs_destroy_fn)GetProcAddress(
        module, L"wm6_qjs_destroy");
    if (!abi_version || !create_runtime || !set_pak || !eval ||
        !drain_jobs || !frame || !destroy_runtime) {
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

    g_display_rotated = 0;
    rotation_ready = rotate_display_90();
    viewport_width = GetSystemMetrics(SM_CXSCREEN);
    viewport_height = GetSystemMetrics(SM_CYSCREEN);

    runtime = create_runtime(
        8u * 1024u * 1024u,
        256u * 1024u,
        (unsigned int)viewport_width,
        (unsigned int)viewport_height,
        result,
        sizeof(result));
    if (!runtime) {
        restore_display_orientation();
        ascii_to_wide(create_error, 256, result);
        FreeLibrary(module);
        MessageBox(NULL, create_error, L"QuickJS create failed", MB_OK);
        return 4;
    }
    bundle = read_neighbor_file(
        L"PocketJS.WM6.Demo.js", &bundle_length);
    pak = read_neighbor_file(
        L"PocketJS.WM6.Demo.pak", &pak_length);
    message = (WCHAR *)LocalAlloc(LMEM_FIXED, 1024 * sizeof(WCHAR));
    if (!bundle || !pak || !message) {
        if (bundle)
            LocalFree(bundle);
        if (pak)
            LocalFree(pak);
        if (message) LocalFree(message);
        destroy_runtime(runtime);
        FreeLibrary(module);
        restore_display_orientation();
        MessageBox(NULL, L"Demo bundle allocation failed",
                   L"PocketJS QuickJS Host", MB_OK);
        return 5;
    }
    status = set_pak(
        runtime, pak, pak_length, result, sizeof(result));
    if (status == 0)
        status = eval(runtime, (const char *)bundle, bundle_length,
                      result, sizeof(result));
    if (status == 0)
        status = drain_jobs(runtime, result, sizeof(result)) < 0 ? -1 : 0;
    LocalFree(bundle);
    LocalFree(pak);

    if (status != 0) {
        restore_display_orientation();
        ascii_to_wide(message, 1024, result);
        MessageBox(NULL, message, L"PocketJS QuickJS DLL failure", MB_OK);
        destroy_runtime(runtime);
        FreeLibrary(module);
        LocalFree(message);
        return 5;
    }
    g_buttons = 0;
    g_quickjs_module = module;
    g_quickjs_runtime = runtime;
    g_quickjs_frame = frame;
    g_quickjs_destroy = destroy_runtime;
    if (rotation_ready)
        OutputDebugString(L"PocketJS WM6: landscape display active\r\n");
    else
        OutputDebugString(L"PocketJS WM6: display rotation unavailable\r\n");
    memset(&window_class, 0, sizeof(window_class));
    window_class.lpfnWndProc = DemoWindowProc;
    window_class.hInstance = instance;
    window_class.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    window_class.lpszClassName = class_name;
    if (!RegisterClass(&window_class)) {
        restore_display_orientation();
        destroy_runtime(runtime);
        FreeLibrary(module);
        g_quickjs_module = NULL;
        g_quickjs_runtime = NULL;
        LocalFree(message);
        return 6;
    }
    window = CreateWindow(class_name,
                          rotation_ready
                              ? L"PocketJS Hero Demo [landscape]"
                              : L"PocketJS Hero Demo [rotation unavailable]",
                          WS_VISIBLE, 0, 0,
                          GetSystemMetrics(SM_CXSCREEN),
                          GetSystemMetrics(SM_CYSCREEN),
                          NULL, NULL, instance, NULL);
    if (!window) {
        restore_display_orientation();
        destroy_runtime(runtime);
        FreeLibrary(module);
        g_quickjs_module = NULL;
        g_quickjs_runtime = NULL;
        LocalFree(message);
        return 7;
    }
    g_framebuffer_ready = 0;
    if (wm6_framebuffer_open(
            window, viewport_width, viewport_height)) {
        g_framebuffer_ready = 1;
        OutputDebugString(
            L"PocketJS WM6: Rust core ARGB32 -> DirectDraw active\r\n");
    } else {
        wm6_framebuffer_close();
        OutputDebugString(L"PocketJS WM6: DirectDraw unavailable\r\n");
    }
    ShowWindow(window, show);
    UpdateWindow(window);
    if (g_framebuffer_ready) {
        render_core_frame();
        SetTimer(window, 1, 16, NULL);
    }
    while (GetMessage(&message_loop, NULL, 0, 0)) {
        TranslateMessage(&message_loop);
        DispatchMessage(&message_loop);
    }
    restore_display_orientation();
    LocalFree(message);
    return 0;
}
