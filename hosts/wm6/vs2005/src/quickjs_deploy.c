#include <windows.h>
#include <aygshell.h>

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
static int g_frame_available;
static HMODULE g_quickjs_module;
static wm6_qjs_handle g_quickjs_runtime;
static wm6_qjs_frame_fn g_quickjs_frame;
static wm6_qjs_destroy_fn g_quickjs_destroy;
static unsigned int g_buttons;
static unsigned int g_pressed_buttons;
static int g_viewport_width;
static int g_viewport_height;
static int g_touch_active;
static int g_touch_x;
static int g_touch_y;
static int g_frame_error_shown;
static int g_first_frame_reported;
static DWORD g_frame_window_started;
static unsigned int g_frame_window_count;
static DEVMODE g_original_display_mode;
static int g_display_rotated;
static int g_shell_hidden;
static int g_taskbar_hidden;
static HMODULE g_aygshell_module;
typedef BOOL (WINAPI *wm6_sh_fullscreen_fn)(HWND, DWORD);
static wm6_sh_fullscreen_fn g_sh_fullscreen;

static void restore_display_orientation(void);

static void enter_fullscreen(HWND window)
{
    DWORD state;
    HWND taskbar;

    MoveWindow(
        window,
        0,
        0,
        GetSystemMetrics(SM_CXSCREEN),
        GetSystemMetrics(SM_CYSCREEN),
        TRUE);
    SetForegroundWindow(window);
    state = SHFS_HIDETASKBAR |
            SHFS_HIDESTARTICON |
            SHFS_HIDESIPBUTTON;
    g_aygshell_module = LoadLibrary(L"aygshell.dll");
    if (g_aygshell_module) {
        g_sh_fullscreen = (wm6_sh_fullscreen_fn)GetProcAddress(
            g_aygshell_module,
            L"SHFullScreen");
    }
    if (g_sh_fullscreen && g_sh_fullscreen(window, state)) {
        g_shell_hidden = 1;
        OutputDebugString(
            L"PocketJS WM6: shell chrome hidden\r\n");
        return;
    }

    taskbar = FindWindow(L"HHTaskBar", NULL);
    if (taskbar) {
        ShowWindow(taskbar, SW_HIDE);
        g_taskbar_hidden = 1;
        g_shell_hidden = 1;
        OutputDebugString(
            L"PocketJS WM6: shell taskbar hidden by fallback\r\n");
    } else {
        OutputDebugString(
            L"PocketJS WM6: shell chrome could not be hidden\r\n");
    }
}

static void leave_fullscreen(HWND window)
{
    DWORD state;
    HWND taskbar;

    if (g_shell_hidden && g_sh_fullscreen) {
        state = SHFS_SHOWTASKBAR |
                SHFS_SHOWSTARTICON |
                SHFS_SHOWSIPBUTTON;
        g_sh_fullscreen(window, state);
    }
    if (g_taskbar_hidden) {
        taskbar = FindWindow(L"HHTaskBar", NULL);
        if (taskbar)
            ShowWindow(taskbar, SW_SHOW);
    }
    if (g_aygshell_module)
        FreeLibrary(g_aygshell_module);
    g_shell_hidden = 0;
    g_taskbar_hidden = 0;
    g_sh_fullscreen = NULL;
    g_aygshell_module = NULL;
}

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

static void update_touch_position(LPARAM position)
{
    int x;
    int y;

    x = (short)LOWORD(position);
    y = (short)HIWORD(position);
    if (x < 0)
        x = 0;
    else if (x >= g_viewport_width)
        x = g_viewport_width - 1;
    if (y < 0)
        y = 0;
    else if (y >= g_viewport_height)
        y = g_viewport_height - 1;
    g_touch_x = x;
    g_touch_y = y;
}

static int stop_frame_rendering(const WCHAR *message)
{
    if (!g_frame_error_shown) {
        g_frame_error_shown = 1;
        OutputDebugString(L"PocketJS WM6 frame failure: ");
        OutputDebugString(message);
        OutputDebugString(L"\r\n");
        MessageBox(NULL, message, L"PocketJS frame failed", MB_OK);
    }
    g_framebuffer_ready = 0;
    g_frame_available = 0;
    return 0;
}

static void report_first_frame_pixels(
    const unsigned char *pixels,
    unsigned int width,
    unsigned int height,
    unsigned int stride,
    unsigned int byte_length)
{
    WCHAR receipt[256];
    DWORD alpha_pixels;
    DWORD colored_pixels;
    unsigned int row;

    if (g_first_frame_reported || !pixels || width == 0 ||
        height == 0 || stride < width * 4u ||
        height > byte_length / stride)
        return;
    alpha_pixels = 0;
    colored_pixels = 0;
    for (row = 0; row < height; row++) {
        const unsigned char *source;
        unsigned int column;

        source = pixels + row * stride;
        for (column = 0; column < width; column++) {
            const unsigned char *pixel;

            pixel = source + column * 4u;
            if (pixel[3] != 0)
                alpha_pixels++;
            if (pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
                colored_pixels++;
        }
    }
    wsprintfW(
        receipt,
        L"PocketJS WM6 receipt: Rust pixels alpha=%lu color=%lu "
        L"first BGRA=%02lx/%02lx/%02lx/%02lx\r\n",
        alpha_pixels,
        colored_pixels,
        (DWORD)pixels[0],
        (DWORD)pixels[1],
        (DWORD)pixels[2],
        (DWORD)pixels[3]);
    OutputDebugString(receipt);
}

static void report_successful_frame(
    unsigned int width,
    unsigned int height,
    unsigned int stride,
    unsigned int byte_length)
{
    WCHAR receipt[256];
    DWORD now;
    DWORD elapsed;
    DWORD fps_tenths;

    now = GetTickCount();
    if (!g_first_frame_reported) {
        wsprintfW(
            receipt,
            L"PocketJS WM6 receipt: Rust frame %lux%lu "
            L"stride=%lu bytes=%lu\r\n",
            (DWORD)width,
            (DWORD)height,
            (DWORD)stride,
            (DWORD)byte_length);
        OutputDebugString(receipt);
        g_first_frame_reported = 1;
        g_frame_window_started = now;
        g_frame_window_count = 0;
    }
    g_frame_window_count++;
    elapsed = now - g_frame_window_started;
    if (elapsed >= 2000u) {
        fps_tenths =
            (DWORD)((g_frame_window_count * 10000u) / elapsed);
        wsprintfW(
            receipt,
            L"PocketJS WM6 receipt: %lu.%lu FPS "
            L"(%lu frames/%lu ms)\r\n",
            fps_tenths / 10u,
            fps_tenths % 10u,
            (DWORD)g_frame_window_count,
            elapsed);
        OutputDebugString(receipt);
        g_frame_window_started = now;
        g_frame_window_count = 0;
    }
}

static int render_core_frame(void)
{
    const unsigned char *pixels;
    unsigned int touches[1];
    unsigned int touch_count;
    unsigned int frame_buttons;
    unsigned int width;
    unsigned int height;
    unsigned int stride;
    unsigned int byte_length;
    char error[256];

    if (!g_quickjs_runtime || !g_quickjs_frame || !g_framebuffer_ready)
        return 0;
    frame_buttons = g_buttons | g_pressed_buttons;
    g_pressed_buttons = 0;
    touch_count = 0;
    if (g_touch_active) {
        touches[0] = 0x80000000u |
                     (((unsigned int)g_touch_y & 0x3ffu) << 10) |
                     ((unsigned int)g_touch_x & 0x3ffu);
        touch_count = 1;
    }
    width = height = stride = byte_length = 0;
    if (!g_first_frame_reported)
        OutputDebugString(
            L"PocketJS WM6 trace: host frame call begin\r\n");
    pixels = g_quickjs_frame(
        g_quickjs_runtime,
        frame_buttons,
        touches,
        touch_count,
        &width,
        &height,
        &stride,
        &byte_length,
        error,
        sizeof(error));
    if (!pixels) {
        WCHAR message[256];

        ascii_to_wide(
            message,
            256,
            error[0] ? error : "QuickJS/Rust frame returned no pixels");
        return stop_frame_rendering(message);
    }
    if (!g_first_frame_reported)
        OutputDebugString(
            L"PocketJS WM6 trace: host frame call complete\r\n");
    report_first_frame_pixels(
        pixels, width, height, stride, byte_length);
    if (!wm6_framebuffer_copy_argb(
            pixels, width, height, stride, byte_length))
        return stop_frame_rendering(
            L"Rust framebuffer geometry or byte length is invalid");
    g_frame_available = 1;
    if (!g_first_frame_reported)
        OutputDebugString(
            L"PocketJS WM6 trace: ARGB32 conversion complete\r\n");
    if (!wm6_framebuffer_present())
        return stop_frame_rendering(
            L"WM6 could not present the Rust framebuffer");
    report_successful_frame(width, height, stride, byte_length);
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
            int should_present;

            should_present =
                g_framebuffer_ready && g_frame_available;
            if (!should_present)
                FillRect(
                    dc, &paint.rcPaint,
                    (HBRUSH)GetStockObject(BLACK_BRUSH));
            EndPaint(window, &paint);
            /*
             * Never lock the DirectDraw primary surface while a GDI paint DC
             * is active. Some Windows CE display drivers serialize those two
             * access paths and otherwise deadlock inside DirectDraw::Lock.
             */
            if (should_present && !wm6_framebuffer_present()) {
                g_framebuffer_ready = 0;
                g_frame_available = 0;
            }
        }
        return 0;
    case WM_TIMER:
        render_core_frame();
        return 0;
    case WM_LBUTTONDOWN:
        update_touch_position(lparam);
        g_touch_active = 1;
        SetCapture(window);
        render_core_frame();
        return 0;
    case WM_MOUSEMOVE:
        if (g_touch_active)
            update_touch_position(lparam);
        return 0;
    case WM_LBUTTONUP:
        if (g_touch_active) {
            update_touch_position(lparam);
            render_core_frame();
            g_touch_active = 0;
            ReleaseCapture();
            render_core_frame();
        }
        return 0;
    case WM_CAPTURECHANGED:
        g_touch_active = 0;
        return 0;
    case WM_KEYDOWN:
        {
            unsigned int button;

            button = button_for_key(wparam);
            if (button && !(g_buttons & button))
                g_pressed_buttons |= button;
            g_buttons |= button;
        }
        if (wparam == VK_ESCAPE) {
            DestroyWindow(window);
            return 0;
        }
        return 0;
    case WM_KEYUP:
        g_buttons &= ~button_for_key(wparam);
        return 0;
    case WM_KILLFOCUS:
        g_buttons = 0;
        g_pressed_buttons = 0;
        g_touch_active = 0;
        if (GetCapture() == window)
            ReleaseCapture();
        return 0;
    case WM_DESTROY:
        leave_fullscreen(window);
        KillTimer(window, 1);
        wm6_framebuffer_close();
        g_framebuffer_ready = 0;
        g_frame_available = 0;
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
    unsigned int loaded_abi;
    int viewport_height;
    int viewport_width;

    (void)instance;
    (void)previous;
    (void)command;
    (void)show;

    module = LoadLibrary(L"PocketJS.WM6.QuickJS.v3.dll");
    if (!module) {
        MessageBox(
            NULL,
            L"PocketJS.WM6.QuickJS.v3.dll was not deployed or could not load",
            L"PocketJS QuickJS Host",
            MB_OK);
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
    loaded_abi = abi_version();
    if (loaded_abi != WM6_QJS_ABI_VERSION) {
        wsprintfW(
            create_error,
            L"QuickJS ABI mismatch: expected %lu, loaded %lu",
            (DWORD)WM6_QJS_ABI_VERSION,
            (DWORD)loaded_abi);
        FreeLibrary(module);
        MessageBox(NULL, create_error,
                   L"PocketJS QuickJS Host", MB_OK);
        return 3;
    }

    g_display_rotated = 0;
    g_shell_hidden = 0;
    g_taskbar_hidden = 0;
    g_aygshell_module = NULL;
    g_sh_fullscreen = NULL;
    rotation_ready = rotate_display_90();
    viewport_width = GetSystemMetrics(SM_CXSCREEN);
    viewport_height = GetSystemMetrics(SM_CYSCREEN);
    g_viewport_width = viewport_width;
    g_viewport_height = viewport_height;

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
    g_pressed_buttons = 0;
    g_touch_active = 0;
    g_touch_x = 0;
    g_touch_y = 0;
    g_frame_error_shown = 0;
    g_first_frame_reported = 0;
    g_frame_window_started = 0;
    g_frame_window_count = 0;
    g_quickjs_module = module;
    g_quickjs_runtime = runtime;
    g_quickjs_frame = frame;
    g_quickjs_destroy = destroy_runtime;
    if (rotation_ready)
        OutputDebugString(L"PocketJS WM6: landscape display active\r\n");
    else
        OutputDebugString(L"PocketJS WM6: display rotation unavailable\r\n");
    wsprintfW(
        message,
        L"PocketJS WM6 receipt: ABI v%lu, viewport=%lux%lu, "
        L"bundle=%lu bytes, pak=%lu bytes\r\n",
        (DWORD)WM6_QJS_ABI_VERSION,
        (DWORD)viewport_width,
        (DWORD)viewport_height,
        (DWORD)bundle_length,
        (DWORD)pak_length);
    OutputDebugString(message);
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
    g_frame_available = 0;
    if (wm6_framebuffer_open(
            window, viewport_width, viewport_height)) {
        g_framebuffer_ready = 1;
        OutputDebugString(
            L"PocketJS WM6: Rust core ARGB32 presenter active\r\n");
    } else {
        wm6_framebuffer_close();
        OutputDebugString(L"PocketJS WM6: DirectDraw unavailable\r\n");
    }
    ShowWindow(window, show);
    enter_fullscreen(window);
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
