/* Pocket Vapor AOT host for Windows Mobile 6 / Visual C++ 2005.
 *
 * The application logic and paint effects live in generated/todo.gba.c.
 * This file owns the WM6 window, GDI presentation, and input mapping.
 */

#include <windows.h>
#include <aygshell.h>
#include <tchar.h>

#define VP_GRID_W 30
#define VP_GRID_H 20

#include "vapor.h"

#define VP_BUTTON_A 0
#define VP_BUTTON_B 1
#define VP_BUTTON_SELECT 2
#define VP_BUTTON_START 3
#define VP_BUTTON_RIGHT 4
#define VP_BUTTON_LEFT 5
#define VP_BUTTON_UP 6
#define VP_BUTTON_DOWN 7

u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static const TCHAR kWindowClass[] = _T("PocketJS.WM6.Vapor");
static HDC g_back_buffer;
static HBITMAP g_back_bitmap;
static HBITMAP g_back_previous_bitmap;
static int g_back_width;
static int g_back_height;

static COLORREF color_from_rgb555(u16 color)
{
    int red = (color & 31) * 255 / 31;
    int green = ((color >> 5) & 31) * 255 / 31;
    int blue = ((color >> 10) & 31) * 255 / 31;
    return RGB(red, green, blue);
}

static void release_back_buffer(void)
{
    if (g_back_buffer != NULL && g_back_previous_bitmap != NULL) {
        SelectObject(g_back_buffer, g_back_previous_bitmap);
    }
    if (g_back_bitmap != NULL) DeleteObject(g_back_bitmap);
    if (g_back_buffer != NULL) DeleteDC(g_back_buffer);
    g_back_buffer = NULL;
    g_back_bitmap = NULL;
    g_back_previous_bitmap = NULL;
    g_back_width = 0;
    g_back_height = 0;
}

static BOOL ensure_back_buffer(HDC target, int width, int height)
{
    HDC next_buffer;
    HBITMAP next_bitmap;
    HBITMAP next_previous_bitmap;

    if (
        g_back_buffer != NULL &&
        g_back_width == width &&
        g_back_height == height
    ) {
        return TRUE;
    }

    release_back_buffer();
    next_buffer = CreateCompatibleDC(target);
    next_bitmap = CreateCompatibleBitmap(target, width, height);
    if (next_buffer == NULL || next_bitmap == NULL) {
        if (next_bitmap != NULL) DeleteObject(next_bitmap);
        if (next_buffer != NULL) DeleteDC(next_buffer);
        return FALSE;
    }
    next_previous_bitmap = (HBITMAP)SelectObject(next_buffer, next_bitmap);
    if (next_previous_bitmap == NULL) {
        DeleteObject(next_bitmap);
        DeleteDC(next_buffer);
        return FALSE;
    }

    g_back_buffer = next_buffer;
    g_back_bitmap = next_bitmap;
    g_back_previous_bitmap = next_previous_bitmap;
    g_back_width = width;
    g_back_height = height;
    return TRUE;
}

static HFONT create_grid_font(int cell_height)
{
    const TCHAR face_name[] = _T("Courier New");
    LOGFONT description;
    int index;

    ZeroMemory(&description, sizeof(description));
    description.lfHeight = -(cell_height * 3 / 4);
    description.lfWeight = FW_BOLD;
    description.lfCharSet = ANSI_CHARSET;
    description.lfOutPrecision = OUT_DEFAULT_PRECIS;
    description.lfClipPrecision = CLIP_DEFAULT_PRECIS;
    description.lfQuality = DEFAULT_QUALITY;
    description.lfPitchAndFamily = FIXED_PITCH | FF_MODERN;
    for (
        index = 0;
        index < LF_FACESIZE - 1 && face_name[index] != _T('\0');
        ++index
    ) {
        description.lfFaceName[index] = face_name[index];
    }
    description.lfFaceName[index] = _T('\0');
    return CreateFontIndirect(&description);
}

static void draw_grid(HWND window, HDC target)
{
    RECT client;
    HDC back;
    HFONT font;
    HFONT previous_font;
    int width;
    int height;
    int cell_width;
    int cell_height;
    int row;

    GetClientRect(window, &client);
    width = client.right - client.left;
    height = client.bottom - client.top;
    if (width <= 0 || height <= 0) return;
    if (!ensure_back_buffer(target, width, height)) return;

    back = g_back_buffer;
    cell_width = width / VP_GRID_W;
    cell_height = height / VP_GRID_H;
    font = create_grid_font(cell_height);
    previous_font = NULL;
    if (font != NULL) previous_font = (HFONT)SelectObject(back, font);
    SetBkMode(back, OPAQUE);

    for (row = 0; row < VP_GRID_H; ++row) {
        TCHAR text[VP_GRID_W + 1];
        RECT row_rect;
        u8 palette = vp_grid_pal[row][0];
        COLORREF ink;
        COLORREF paper;
        int column;

        if (palette >= vp_palette_count) palette = 0;
        ink = color_from_rgb555(vp_palettes[(u16)palette * 16 + 1]);
        paper = color_from_rgb555(vp_palettes[(u16)palette * 16 + 2]);
        for (column = 0; column < VP_GRID_W; ++column) {
            u8 ch = vp_grid_ch[row][column];
            text[column] = (TCHAR)((ch >= 0x20 && ch <= 0x7e) ? ch : ' ');
        }
        text[VP_GRID_W] = _T('\0');

        row_rect.left = 0;
        row_rect.top = row * cell_height;
        row_rect.right = width;
        row_rect.bottom =
            row == VP_GRID_H - 1 ? height : (row + 1) * cell_height;
        SetTextColor(back, ink);
        SetBkColor(back, paper);
        ExtTextOut(
            back,
            cell_width / 2,
            row_rect.top + (cell_height / 8),
            ETO_OPAQUE | ETO_CLIPPED,
            &row_rect,
            text,
            VP_GRID_W,
            NULL
        );
    }

    BitBlt(target, 0, 0, width, height, back, 0, 0, SRCCOPY);
    if (previous_font != NULL) SelectObject(back, previous_font);
    if (font != NULL) DeleteObject(font);
    vp_rows_dirty = 0;
}

static int button_for_key(WPARAM key)
{
    switch (key) {
    case VK_RETURN:
    case 0x1c:
        return VP_BUTTON_A;
    case VK_BACK:
        return VP_BUTTON_B;
    case VK_UP:
        return VP_BUTTON_UP;
    case VK_DOWN:
        return VP_BUTTON_DOWN;
    case VK_LEFT:
        return VP_BUTTON_LEFT;
    case VK_RIGHT:
        return VP_BUTTON_RIGHT;
    case VK_F1:
        return VP_BUTTON_SELECT;
    case VK_F2:
        return VP_BUTTON_START;
    }
    return -1;
}

static void press_button(HWND window, u8 button)
{
    app_on_button(button);
    if (app_flush()) InvalidateRect(window, NULL, FALSE);
}

static LRESULT CALLBACK window_procedure(
    HWND window,
    UINT message,
    WPARAM w_param,
    LPARAM l_param
)
{
    switch (message) {
    case WM_CREATE:
        vp_row_clear(0, VP_GRID_H);
        app_init();
        app_flush();
        InvalidateRect(window, NULL, FALSE);
        return 0;

    case WM_KEYDOWN:
        {
            int button = button_for_key(w_param);
            if (button >= 0) {
                press_button(window, (u8)button);
            } else if (w_param == VK_ESCAPE) {
                DestroyWindow(window);
            }
        }
        return 0;

    case WM_LBUTTONUP:
        {
            RECT client;
            int x = (short)LOWORD(l_param);
            int y = (short)HIWORD(l_param);
            GetClientRect(window, &client);
            if (y < client.bottom / 3) {
                press_button(window, VP_BUTTON_UP);
            } else if (y < (client.bottom * 2) / 3) {
                press_button(window, VP_BUTTON_DOWN);
            } else if (x < client.right / 2) {
                press_button(window, VP_BUTTON_A);
            } else {
                press_button(window, VP_BUTTON_B);
            }
        }
        return 0;

    case WM_SIZE:
        release_back_buffer();
        InvalidateRect(window, NULL, FALSE);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_PAINT:
        {
            PAINTSTRUCT paint;
            HDC dc = BeginPaint(window, &paint);
            draw_grid(window, dc);
            EndPaint(window, &paint);
        }
        return 0;

    case WM_DESTROY:
        release_back_buffer();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(window, message, w_param, l_param);
}

int WINAPI WinMain(
    HINSTANCE instance,
    HINSTANCE previous_instance,
    LPWSTR command_line,
    int show_command
)
{
    WNDCLASS window_class;
    HWND window;
    MSG message;
    BOOL message_result;

    (void)previous_instance;
    (void)command_line;
    ZeroMemory(&window_class, sizeof(window_class));
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.lpfnWndProc = window_procedure;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
    window_class.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    window_class.lpszClassName = kWindowClass;

    if (
        !RegisterClass(&window_class) &&
        GetLastError() != ERROR_CLASS_ALREADY_EXISTS
    ) {
        return 1;
    }

    SHInitExtraControls();
    window = CreateWindow(
        kWindowClass,
        _T("Pocket Vapor Todo"),
        WS_VISIBLE,
        0,
        0,
        GetSystemMetrics(SM_CXSCREEN),
        GetSystemMetrics(SM_CYSCREEN),
        NULL,
        NULL,
        instance,
        NULL
    );
    if (window == NULL) return 2;

    SHFullScreen(
        window,
        SHFS_HIDETASKBAR | SHFS_HIDESIPBUTTON | SHFS_HIDESTARTICON
    );
    ShowWindow(window, show_command);
    UpdateWindow(window);

    while ((message_result = GetMessage(&message, NULL, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessage(&message);
    }
    if (message_result < 0) return 3;
    return (int)message.wParam;
}
