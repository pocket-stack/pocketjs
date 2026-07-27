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

static char *g_draw_list;

static int wide_length(const WCHAR *text)
{
    int length;

    length = 0;
    while (text[length] != L'\0')
        length++;
    return length;
}

static int read_number(char **cursor)
{
    int value;

    if (**cursor == '|')
        (*cursor)++;
    value = 0;
    while (**cursor >= '0' && **cursor <= '9') {
        value = value * 10 + (**cursor - '0');
        (*cursor)++;
    }
    return value;
}

static void paint_cards(HWND window, HDC dc)
{
    RECT client;
    RECT logical;
    char *line;
    char *next;
    char *cursor;
    char saved;
    int offset_x;
    int offset_y;

    GetClientRect(window, &client);
    FillRect(dc, &client, (HBRUSH)GetStockObject(BLACK_BRUSH));
    offset_x = (client.right - 480) / 2;
    offset_y = (client.bottom - 272) / 2;
    line = g_draw_list;
    while (line && *line) {
        int x, y, w, h, size, r, g, b;
        HBRUSH brush;
        COLORREF color;

        next = line;
        while (*next && *next != '\n')
            next++;
        saved = *next;
        *next = '\0';
        cursor = line + 1;
        if (line[0] == 'B') {
            r = read_number(&cursor);
            g = read_number(&cursor);
            b = read_number(&cursor);
            logical.left = offset_x;
            logical.top = offset_y;
            logical.right = offset_x + 480;
            logical.bottom = offset_y + 272;
            brush = CreateSolidBrush(RGB(r, g, b));
            FillRect(dc, &logical, brush);
            DeleteObject(brush);
        } else if (line[0] == 'R') {
            x = read_number(&cursor);
            y = read_number(&cursor);
            w = read_number(&cursor);
            h = read_number(&cursor);
            r = read_number(&cursor);
            g = read_number(&cursor);
            b = read_number(&cursor);
            logical.left = offset_x + x;
            logical.top = offset_y + y;
            logical.right = logical.left + w;
            logical.bottom = logical.top + h;
            brush = CreateSolidBrush(RGB(r, g, b));
            FillRect(dc, &logical, brush);
            DeleteObject(brush);
        } else if (line[0] == 'T') {
            LOGFONT font_spec;
            HFONT font;
            HFONT previous_font;
            WCHAR text[256];

            x = read_number(&cursor);
            y = read_number(&cursor);
            size = read_number(&cursor);
            r = read_number(&cursor);
            g = read_number(&cursor);
            b = read_number(&cursor);
            if (*cursor == '|')
                cursor++;
            ascii_to_wide(text, 256, cursor);
            memset(&font_spec, 0, sizeof(font_spec));
            font_spec.lfHeight = -size;
            font_spec.lfWeight = size >= 14 ? FW_BOLD : FW_NORMAL;
            font = CreateFontIndirect(&font_spec);
            previous_font = (HFONT)SelectObject(dc, font);
            color = RGB(r, g, b);
            SetTextColor(dc, color);
            SetBkMode(dc, TRANSPARENT);
            TextOut(dc, offset_x + x, offset_y + y,
                    text, wide_length(text));
            SelectObject(dc, previous_font);
            DeleteObject(font);
        }
        *next = saved;
        line = saved ? next + 1 : next;
    }
}

static LRESULT CALLBACK CardsWindowProc(HWND window, UINT message,
                                        WPARAM wparam, LPARAM lparam)
{
    switch (message) {
    case WM_PAINT:
        {
            PAINTSTRUCT paint;
            HDC dc = BeginPaint(window, &paint);
            paint_cards(window, dc);
            EndPaint(window, &paint);
        }
        return 0;
    case WM_KEYDOWN:
        if (wparam == VK_ESCAPE) {
            DestroyWindow(window);
            return 0;
        }
        break;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(window, message, wparam, lparam);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show)
{
    static const char snapshot[] = "__wm6DrawList()";
    static const WCHAR class_name[] = L"PocketJSWM6Cards";
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
    WCHAR create_error[256];
    WCHAR *message;
    WNDCLASS window_class;
    HWND window;
    MSG message_loop;
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
        ascii_to_wide(create_error, 256, result);
        FreeLibrary(module);
        MessageBox(NULL, create_error, L"QuickJS create failed", MB_OK);
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

    if (status != 0) {
        ascii_to_wide(message, 8192, result);
        MessageBox(NULL, message, L"PocketJS QuickJS DLL failure", MB_OK);
        LocalFree(snapshot_text);
        LocalFree(message);
        return 5;
    }
    g_draw_list = snapshot_text;
    memset(&window_class, 0, sizeof(window_class));
    window_class.lpfnWndProc = CardsWindowProc;
    window_class.hInstance = instance;
    window_class.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    window_class.lpszClassName = class_name;
    if (!RegisterClass(&window_class)) {
        LocalFree(snapshot_text);
        LocalFree(message);
        return 6;
    }
    window = CreateWindow(class_name, L"PocketJS Feature Cards",
                          WS_VISIBLE, 0, 0,
                          GetSystemMetrics(SM_CXSCREEN),
                          GetSystemMetrics(SM_CYSCREEN),
                          NULL, NULL, instance, NULL);
    if (!window) {
        LocalFree(snapshot_text);
        LocalFree(message);
        return 7;
    }
    ShowWindow(window, show);
    UpdateWindow(window);
    while (GetMessage(&message_loop, NULL, 0, 0)) {
        TranslateMessage(&message_loop);
        DispatchMessage(&message_loop);
    }
    LocalFree(snapshot_text);
    LocalFree(message);
    return 0;
}
