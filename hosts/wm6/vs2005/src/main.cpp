// PocketJS Windows Mobile 6 hardware probe.
//
// Keep this translation unit compatible with the Visual C++ 2005 compiler:
// no C++11, no desktop-only Win32 calls, and no dependency on MFC or ATL.

#include <windows.h>
#include <aygshell.h>
#include <tchar.h>

namespace {

const TCHAR kWindowClass[] = _T("PocketJS.WM6.Probe");
const UINT_PTR kFrameTimer = 1;
const UINT kFramePeriodMs = 33;

struct ProbeState {
    DWORD startedAt;
    DWORD frames;
    DWORD lastFrameAt;
    DWORD framePeriod;
    DWORD lastKey;
    POINT pointer;
    BOOL pointerDown;
    int width;
    int height;
    HDC backBuffer;
    HBITMAP backBitmap;
    HBITMAP backPreviousBitmap;
    int backWidth;
    int backHeight;
};

ProbeState g_state;

int Clamp(int value, int minimum, int maximum)
{
    if (value < minimum) return minimum;
    if (value > maximum) return maximum;
    return value;
}

void FillRectColor(HDC dc, int left, int top, int right, int bottom, COLORREF color)
{
    RECT rect;
    HBRUSH brush;
    rect.left = left;
    rect.top = top;
    rect.right = right;
    rect.bottom = bottom;
    brush = CreateSolidBrush(color);
    if (brush != NULL) {
        FillRect(dc, &rect, brush);
        DeleteObject(brush);
    }
}

void ReleaseBackBuffer()
{
    if (g_state.backBuffer != NULL && g_state.backPreviousBitmap != NULL) {
        SelectObject(g_state.backBuffer, g_state.backPreviousBitmap);
    }
    if (g_state.backBitmap != NULL) DeleteObject(g_state.backBitmap);
    if (g_state.backBuffer != NULL) DeleteDC(g_state.backBuffer);
    g_state.backBuffer = NULL;
    g_state.backBitmap = NULL;
    g_state.backPreviousBitmap = NULL;
    g_state.backWidth = 0;
    g_state.backHeight = 0;
}

BOOL EnsureBackBuffer(HDC target, int width, int height)
{
    HDC nextBuffer;
    HBITMAP nextBitmap;
    HBITMAP nextPreviousBitmap;

    if (
        g_state.backBuffer != NULL &&
        g_state.backWidth == width &&
        g_state.backHeight == height
    ) {
        return TRUE;
    }

    ReleaseBackBuffer();
    nextBuffer = CreateCompatibleDC(target);
    nextBitmap = CreateCompatibleBitmap(target, width, height);
    if (nextBuffer == NULL || nextBitmap == NULL) {
        if (nextBitmap != NULL) DeleteObject(nextBitmap);
        if (nextBuffer != NULL) DeleteDC(nextBuffer);
        return FALSE;
    }
    nextPreviousBitmap = static_cast<HBITMAP>(SelectObject(nextBuffer, nextBitmap));
    if (nextPreviousBitmap == NULL) {
        DeleteObject(nextBitmap);
        DeleteDC(nextBuffer);
        return FALSE;
    }

    g_state.backBuffer = nextBuffer;
    g_state.backBitmap = nextBitmap;
    g_state.backPreviousBitmap = nextPreviousBitmap;
    g_state.backWidth = width;
    g_state.backHeight = height;
    return TRUE;
}

HFONT CreateProbeFont()
{
    const TCHAR faceName[] = _T("Tahoma");
    LOGFONT description;
    int index;
    ZeroMemory(&description, sizeof(description));
    description.lfHeight = -16;
    description.lfWeight = FW_NORMAL;
    description.lfCharSet = DEFAULT_CHARSET;
    description.lfOutPrecision = OUT_DEFAULT_PRECIS;
    description.lfClipPrecision = CLIP_DEFAULT_PRECIS;
    description.lfQuality = DEFAULT_QUALITY;
    description.lfPitchAndFamily = DEFAULT_PITCH | FF_DONTCARE;
    for (
        index = 0;
        index < LF_FACESIZE - 1 && faceName[index] != _T('\0');
        ++index
    ) {
        description.lfFaceName[index] = faceName[index];
    }
    description.lfFaceName[index] = _T('\0');
    return CreateFontIndirect(&description);
}

void DrawProbe(HWND window, HDC target)
{
    RECT client;
    HDC back;
    HFONT font;
    HFONT previousFont;
    MEMORYSTATUS memory;
    TCHAR line[256];
    DWORD elapsed;
    int width;
    int height;
    int stripe;

    GetClientRect(window, &client);
    width = client.right - client.left;
    height = client.bottom - client.top;
    if (width <= 0 || height <= 0) return;

    if (!EnsureBackBuffer(target, width, height)) return;
    back = g_state.backBuffer;

    FillRectColor(back, 0, 0, width, height, RGB(12, 16, 24));
    for (stripe = 0; stripe < 6; ++stripe) {
        const int left = (width * stripe) / 6;
        const int right = (width * (stripe + 1)) / 6;
        FillRectColor(
            back,
            left,
            0,
            right,
            12,
            RGB(30 + stripe * 24, 170 - stripe * 12, 210 - stripe * 18)
        );
    }

    font = CreateProbeFont();
    previousFont = NULL;
    if (font != NULL) {
        previousFont = static_cast<HFONT>(SelectObject(back, font));
    }
    SetBkMode(back, TRANSPARENT);
    SetTextColor(back, RGB(238, 243, 250));

    RECT textRect;
    textRect.left = 18;
    textRect.top = 28;
    textRect.right = width - 18;
    textRect.bottom = height - 18;
    DrawText(
        back,
        _T("PocketJS / WM6 hardware probe\r\n")
        _T("VS2005 + ARMV4I + native Win32"),
        -1,
        &textRect,
        DT_LEFT | DT_TOP | DT_NOPREFIX
    );

    ZeroMemory(&memory, sizeof(memory));
    memory.dwLength = sizeof(memory);
    GlobalMemoryStatus(&memory);
    elapsed = GetTickCount() - g_state.startedAt;

    wsprintf(
        line,
        _T("screen: %d x %d\r\n")
        _T("client: %d x %d\r\n")
        _T("RAM free: %lu / %lu KB\r\n")
        _T("frames: %lu  last: %lu ms\r\n")
        _T("key: 0x%02lX\r\n")
        _T("touch: %ld, %ld  %s\r\n")
        _T("uptime: %lu ms"),
        GetSystemMetrics(SM_CXSCREEN),
        GetSystemMetrics(SM_CYSCREEN),
        width,
        height,
        memory.dwAvailPhys / 1024,
        memory.dwTotalPhys / 1024,
        g_state.frames,
        g_state.framePeriod,
        g_state.lastKey,
        g_state.pointer.x,
        g_state.pointer.y,
        g_state.pointerDown ? _T("DOWN") : _T("up"),
        elapsed
    );
    textRect.top = 92;
    DrawText(back, line, -1, &textRect, DT_LEFT | DT_TOP | DT_NOPREFIX);

    const int markerX = Clamp(g_state.pointer.x, 0, width - 1);
    const int markerY = Clamp(g_state.pointer.y, 0, height - 1);
    const COLORREF markerColor =
        g_state.pointerDown ? RGB(255, 194, 74) : RGB(90, 210, 255);
    HPEN pen = CreatePen(PS_SOLID, 3, markerColor);
    if (pen != NULL) {
        HPEN previousPen = static_cast<HPEN>(SelectObject(back, pen));
        MoveToEx(back, markerX - 12, markerY, NULL);
        LineTo(back, markerX + 13, markerY);
        MoveToEx(back, markerX, markerY - 12, NULL);
        LineTo(back, markerX, markerY + 13);
        SelectObject(back, previousPen);
        DeleteObject(pen);
    }

    BitBlt(target, 0, 0, width, height, back, 0, 0, SRCCOPY);

    if (previousFont != NULL) SelectObject(back, previousFont);
    if (font != NULL) DeleteObject(font);
}

void UpdatePointer(LPARAM parameter, BOOL down)
{
    g_state.pointer.x = static_cast<short>(LOWORD(parameter));
    g_state.pointer.y = static_cast<short>(HIWORD(parameter));
    g_state.pointerDown = down;
}

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message) {
    case WM_CREATE:
        g_state.startedAt = GetTickCount();
        g_state.lastFrameAt = g_state.startedAt;
        g_state.pointer.x = GetSystemMetrics(SM_CXSCREEN) / 2;
        g_state.pointer.y = GetSystemMetrics(SM_CYSCREEN) / 2;
        SetTimer(window, kFrameTimer, kFramePeriodMs, NULL);
        return 0;

    case WM_SIZE:
        g_state.width = LOWORD(lParam);
        g_state.height = HIWORD(lParam);
        InvalidateRect(window, NULL, FALSE);
        return 0;

    case WM_TIMER:
        if (wParam == kFrameTimer) {
            const DWORD now = GetTickCount();
            g_state.framePeriod = now - g_state.lastFrameAt;
            g_state.lastFrameAt = now;
            ++g_state.frames;
            InvalidateRect(window, NULL, FALSE);
        }
        return 0;

    case WM_KEYDOWN:
        g_state.lastKey = static_cast<DWORD>(wParam);
        if (wParam == VK_ESCAPE) {
            DestroyWindow(window);
        } else {
            InvalidateRect(window, NULL, FALSE);
        }
        return 0;

    case WM_LBUTTONDOWN:
        SetCapture(window);
        UpdatePointer(lParam, TRUE);
        InvalidateRect(window, NULL, FALSE);
        return 0;

    case WM_MOUSEMOVE:
        if ((wParam & MK_LBUTTON) != 0) {
            UpdatePointer(lParam, TRUE);
            InvalidateRect(window, NULL, FALSE);
        }
        return 0;

    case WM_LBUTTONUP:
        ReleaseCapture();
        UpdatePointer(lParam, FALSE);
        InvalidateRect(window, NULL, FALSE);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_PAINT:
        {
            PAINTSTRUCT paint;
            HDC dc = BeginPaint(window, &paint);
            DrawProbe(window, dc);
            EndPaint(window, &paint);
        }
        return 0;

    case WM_DESTROY:
        KillTimer(window, kFrameTimer);
        ReleaseBackBuffer();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(window, message, wParam, lParam);
}

} // namespace

int WINAPI WinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int showCommand)
{
    WNDCLASS windowClass;
    HWND window;
    MSG message;
    BOOL messageResult;

    ZeroMemory(&g_state, sizeof(g_state));
    ZeroMemory(&windowClass, sizeof(windowClass));
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = WindowProcedure;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursor(NULL, IDC_ARROW);
    windowClass.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    windowClass.lpszClassName = kWindowClass;

    if (!RegisterClass(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return 1;
    }

    SHInitExtraControls();
    window = CreateWindow(
        kWindowClass,
        _T("PocketJS WM6 Probe"),
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

    SHFullScreen(window, SHFS_HIDETASKBAR | SHFS_HIDESIPBUTTON | SHFS_HIDESTARTICON);
    ShowWindow(window, showCommand);
    UpdateWindow(window);

    while ((messageResult = GetMessage(&message, NULL, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessage(&message);
    }
    if (messageResult < 0) return 3;
    return static_cast<int>(message.wParam);
}
