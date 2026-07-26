#include <windows.h>

/*
 * VS2005 needs a normal Smart Device output before it enables Deploy.
 * The debugger is configured to start the separately built CeGCC QuickJS
 * executable, so this tiny launcher is only a deployment anchor.
 */
int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show)
{
    (void)instance;
    (void)previous;
    (void)command;
    (void)show;
    MessageBox(NULL,
               L"Build the QuickJS probe with hosts/wm6/quickjs/build-probe.sh.",
               L"PocketJS QuickJS deploy helper",
               MB_OK);
    return 0;
}
