Windows CE is a message pump. Touch is `WM_LBUTTONDOWN`. Time is `WM_TIMER`. Permission to draw is `WM_PAINT`. If your program stops taking messages, the operating system stops believing it is alive.

That sounds almost disappointingly familiar after [Symbian's active objects](/blog/pocketjs-on-symbian/). It was not. Familiarity got us as far as compiling a Windows executable; a physical Meizu M8 then found the wrong framebuffer size, an input ABI that could not represent the bottom 208 rows of its screen, a window that trapped the Home key, and an icon cache with an excellent memory for our mistakes.

So [PocketJS](/blog/introducing-pocketjs/) now runs a real Solid application on a 2009 Windows CE 6 phone as one native ARM executable: QuickJS, a Rust layout and software-rendering core, the guest JavaScript bundle, and its assets all inside `PocketJS.exe`. The core rasterizes a native 480×720 BGRA framebuffer; GDI hands those pixels to the LCD without stretching.

<img class="mx-auto w-full max-w-sm rounded-xl border border-line" src="/assets/blog/meizu-m8-native-dialog.png" alt="A real Meizu M8 Windows CE desktop at 480 by 720. Over the phone's foliage wallpaper and Synchronizing panel is a classic native dialog titled PocketJS - Meizu M8, with a blue title bar, information icon, explanatory text, and OK button." />

<p class="text-sm text-slate-500 -mt-4">A <code>MessageBoxW</code> running on the connected M8, captured from the phone's desktop through GDI and RAPI. It is not a recreation. The “Synchronizing” window behind it is also part of the story: USB connected did not mean our pixels were on top.</p>

This is the field report for the port: the Windows CE programming model underneath that dialog, how PocketJS fits into it, how an ActiveSync USB function became a network and then a deployment channel on a 2026 Mac, and why “the executable launched” was only the fourth rung of an eleven-stage acceptance ladder.

The work landed in one pull request over roughly two days. The phone did most of the reviewing.

## The machine

<svg viewBox="0 0 760 286" width="100%" role="img" aria-label="Comparison of four PocketJS machines. The Sony PSP has a 480 by 272 display and fixed-function graphics. The Nokia E7 runs Symbian with a 640 by 360 OpenGL ES 2 display. The first iPhone runs iPhone OS with a 320 by 480 fixed-function OpenGL ES display. The highlighted Meizu M8 runs Windows CE 6 on ARMv6 with a portrait 480 by 720 display and a GDI software presentation path." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="22" fill="#64748b" font-size="11">MACHINE</text>
  <text x="198" y="22" fill="#64748b" font-size="11">OS / CPU FAMILY</text>
  <text x="414" y="22" fill="#64748b" font-size="11">SCREEN</text>
  <text x="554" y="22" fill="#64748b" font-size="11">POCKETJS PRESENTS THROUGH</text>
  <line x1="14" y1="32" x2="746" y2="32" stroke="#1e293b"/>
  <text x="14" y="60" fill="#e2e8f0" font-size="12.5">Sony PSP-1000 · 2004</text>
  <text x="198" y="60" fill="#94a3b8" font-size="12">PSP / MIPS</text>
  <text x="414" y="60" fill="#94a3b8" font-size="12">480×272</text>
  <text x="554" y="60" fill="#94a3b8" font-size="12">fixed-function GE</text>
  <text x="14" y="90" fill="#e2e8f0" font-size="12.5">Nokia E7 · 2011</text>
  <text x="198" y="90" fill="#94a3b8" font-size="12">Symbian / ARM11</text>
  <text x="414" y="90" fill="#94a3b8" font-size="12">640×360</text>
  <text x="554" y="90" fill="#94a3b8" font-size="12">OpenGL ES 2</text>
  <text x="14" y="120" fill="#e2e8f0" font-size="12.5">Apple iPhone · 2007</text>
  <text x="198" y="120" fill="#94a3b8" font-size="12">iPhone OS / ARMv6</text>
  <text x="414" y="120" fill="#94a3b8" font-size="12">320×480</text>
  <text x="554" y="120" fill="#94a3b8" font-size="12">OpenGL ES 1.1</text>
  <rect x="8" y="136" width="744" height="42" rx="7" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.2"/>
  <text x="14" y="162" fill="#f1f5f9" font-size="12.5" font-weight="700">Meizu M8 / M8SE · 2009</text>
  <text x="198" y="162" fill="#22d3ee" font-size="12">Windows CE 6 / ARMv6</text>
  <text x="414" y="162" fill="#22d3ee" font-size="12">480×720 portrait</text>
  <text x="554" y="162" fill="#22d3ee" font-size="12">GDI · software BGRA</text>
  <line x1="14" y1="196" x2="746" y2="196" stroke="#1e293b"/>
  <text x="14" y="220" fill="#94a3b8" font-size="11.5">The M8 has the tallest PocketJS viewport here, but no renderer-specific UI code. The same retained tree is rasterized in Rust.</text>
  <text x="14" y="242" fill="#94a3b8" font-size="11.5">The platform seam is narrower: a Win32-style host supplies time and touch, then GDI copies one complete pixel buffer.</text>
  <text x="14" y="272" fill="#64748b" font-size="11">Target profile: private meizu-m8-dev · host ABI 8 · arm1136jf-s · 480×720 BGRA · 60 Hz fixed UI tick</text>
</svg>

The M8 is the first PocketJS target where the display path is boring in the most useful sense. There is no GPU backend in this port. PocketJS already has a deterministic software renderer, so the host asks it for a finished 32-bit framebuffer and calls `SetDIBitsToDevice`. One memory buffer, one GDI call, one LCD.

The operating system around that call is less boring. Meizu shipped its own full-screen shell, application registry, USB synchronization stack and conventions on top of Windows CE 6. A program can be valid WinCE and still be a bad M8 citizen — as our first fullscreen window demonstrated.

## Interlude: how Windows CE programs actually work

Windows CE inherited the recognizable Win32 shape, then cut it for a small embedded machine. An application is a PE/COFF executable. Its entry point is `WinMain`. Most of the user-facing operating-system API is imported from `COREDLL.dll`: windows, files, processes, GDI, input, the registry. There is no browser process, no DOM, and no compositor contract resembling the modern web.

The key abstraction is the **window**. It is not a rectangle of pixels so much as an address for messages. You register a window class with a callback, create an `HWND`, and then spend the life of the UI thread removing messages from its queue and dispatching them into that callback.

```c
static LRESULT CALLBACK WindowProc(
    HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam
) {
    switch (message) {
        case WM_TIMER:       render_frame(hwnd); return 0;
        case WM_PAINT:       paint_frame(hwnd);  return 0;
        case WM_LBUTTONDOWN: touch_down(lparam); return 0;
        case WM_LBUTTONUP:   touch_up(lparam);   return 0;
        case WM_KEYDOWN:
            if (wparam == VK_ESCAPE || wparam == VK_HOME)
                PostMessage(hwnd, WM_CLOSE, 0, 0);
            return 0;
        case WM_DESTROY:     PostQuitMessage(0); return 0;
    }
    return DefWindowProc(hwnd, message, wparam, lparam);
}

int WINAPI WinMain(HINSTANCE app, HINSTANCE previous,
                   LPWSTR command_line, int show) {
    RegisterClass(&window_class);
    HWND hwnd = CreateWindow(/* class, title, WS_POPUP, 480×720 … */);
    SetTimer(hwnd, 1, 17, NULL);

    MSG message;
    while (GetMessage(&message, NULL, 0, 0)) {
        TranslateMessage(&message);
        DispatchMessage(&message);
    }
    return (int)message.wParam;
}
```

`GetMessage` sleeps when the queue is empty. `DispatchMessage` calls the `WindowProc` registered for the destination window. A timer does not run your callback on a timer thread: it places `WM_TIMER` into this same queue. Paint is also negotiated. When some part of a window is invalid, the system sends `WM_PAINT`; the application brackets its drawing with `BeginPaint` and `EndPaint`, validating the damaged region as it goes.

This is why a stuck UI and a stuck message loop are the same bug. If `WindowProc` spends five seconds evaluating JavaScript, no timer, paint, touch, close, or shell transition on that thread can be dispatched during those five seconds.

<svg viewBox="0 0 760 386" width="100%" role="img" aria-label="Windows CE message pump diagram. The operating system places timer, paint, touch and key messages into one UI thread queue. GetMessage removes one message, DispatchMessage calls WindowProc, and WindowProc must return before the next message. A second panel shows MessageBoxW creating a window and running its own nested modal message loop until OK is pressed, while PocketJS uses the explicit outer loop and a 17 millisecond timer." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE UI THREAD · ONE ORDERED QUEUE · CALLBACKS RUN TO COMPLETION</text>
  <rect x="14" y="34" width="732" height="184" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g font-size="11">
    <rect x="28" y="56" width="118" height="38" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="87" y="79" fill="#e2e8f0" text-anchor="middle">WM_TIMER · 17 ms</text>
    <rect x="154" y="56" width="102" height="38" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="205" y="79" fill="#e2e8f0" text-anchor="middle">WM_PAINT</text>
    <rect x="264" y="56" width="142" height="38" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="335" y="79" fill="#e2e8f0" text-anchor="middle">WM_LBUTTONDOWN</text>
    <rect x="414" y="56" width="116" height="38" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="472" y="79" fill="#e2e8f0" text-anchor="middle">WM_KEYDOWN</text>
    <rect x="538" y="56" width="194" height="38" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="635" y="79" fill="#e2e8f0" text-anchor="middle">shell / system messages</text>
  </g>
  <path d="M87 98 V118 H210" stroke="#475569" fill="none"/><path d="M205 98 V118" stroke="#475569"/><path d="M335 98 V118 H210" stroke="#475569" fill="none"/><path d="M472 98 V118 H210" stroke="#475569" fill="none"/><path d="M635 98 V118 H210" stroke="#475569" fill="none"/>
  <rect x="112" y="118" width="196" height="42" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="210" y="136" fill="#f1f5f9" text-anchor="middle" font-size="12">GetMessage()</text><text x="210" y="152" fill="#22d3ee" text-anchor="middle" font-size="10">sleep → remove one</text>
  <path d="M312 139 H366" stroke="#475569"/><path d="M366 139 l-8 -5 M366 139 l-8 5" stroke="#475569" fill="none"/>
  <rect x="370" y="118" width="174" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/><text x="457" y="136" fill="#f1f5f9" text-anchor="middle" font-size="12">DispatchMessage()</text><text x="457" y="152" fill="#64748b" text-anchor="middle" font-size="10">route by HWND</text>
  <path d="M548 139 H598" stroke="#475569"/><path d="M598 139 l-8 -5 M598 139 l-8 5" stroke="#475569" fill="none"/>
  <rect x="602" y="118" width="130" height="42" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="667" y="136" fill="#f1f5f9" text-anchor="middle" font-size="12">WindowProc()</text><text x="667" y="152" fill="#22d3ee" text-anchor="middle" font-size="10">handle → return</text>
  <path d="M667 164 V190 H210 V164" stroke="#475569" fill="none"/><path d="M210 164 l-5 8 M210 164 l5 8" stroke="#475569" fill="none"/>
  <text x="382" y="204" fill="#94a3b8" text-anchor="middle" font-size="10.5">Nothing else in this queue runs until WindowProc returns.</text>
  <rect x="14" y="236" width="352" height="136" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.2"/>
  <text x="28" y="260" fill="#f1f5f9" font-size="12.5" font-weight="700">MessageBoxW — native modal UI</text>
  <text x="28" y="282" fill="#94a3b8" font-size="11">creates its own HWND and controls, then enters a</text>
  <text x="28" y="301" fill="#94a3b8" font-size="11">nested message loop. The call returns after OK.</text>
  <text x="28" y="328" fill="#22d3ee" font-size="11">The dialog screenshot above is this path.</text>
  <text x="28" y="350" fill="#64748b" font-size="10.5">OS owns title bar · font · button · focus · modality</text>
  <rect x="394" y="236" width="352" height="136" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="408" y="260" fill="#f1f5f9" font-size="12.5" font-weight="700">PocketJS — explicit frame host</text>
  <text x="408" y="282" fill="#94a3b8" font-size="11">WM_TIMER evaluates one guest frame. WM_PAINT</text>
  <text x="408" y="301" fill="#94a3b8" font-size="11">copies the most recent complete BGRA buffer.</text>
  <text x="408" y="328" fill="#22d3ee" font-size="11">JS, layout and raster all return to the pump.</text>
  <text x="408" y="350" fill="#64748b" font-size="10.5">app owns every pixel inside its popup window</text>
</svg>

`MessageBoxW` is interesting because it hides the machinery. The call looks synchronous, but the implementation creates native windows and runs a **nested modal message loop** until the user presses OK. The outer `WinMain` has not returned, yet the dialog can paint and react to touch because another pump is temporarily running inside the call.

That is the classic Windows programming model in miniature: handles name kernel or UI objects, messages serialize interaction on a thread, callbacks update state, and GDI draws into a device context. Windows CE kept the model because it let an OEM ship a recognizable shell and let applications remain small native executables. It also means a PocketJS host does not need to impersonate an OS. It only needs to be a well-behaved window.

## What “porting PocketJS” means here

The dialog is native Windows CE UI. The PocketJS application is not.

A Solid component runs inside QuickJS and mutates a retained UI tree through PocketJS host operations. The Rust core owns style resolution, flex layout, text, animation, focus, hit testing and rasterization. On the M8, the platform host owns exactly four things: creating the window, turning messages into host input, scheduling frames, and presenting the finished buffer with GDI.

<svg viewBox="0 0 760 412" width="100%" role="img" aria-label="PocketJS on Meizu M8 architecture. TypeScript and Solid compile to app JavaScript and an asset pack embedded in PocketJS.exe. QuickJS evaluates the app. HostOps mutate the Rust retained UI tree, whose layout and software rasterizer produce a 480 by 720 BGRA framebuffer. The WinCE host presents it with SetDIBitsToDevice to the LCD. In the reverse direction, Windows messages become buttons and wide touch coordinates, then enter the guest frame function once per timer tick." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE POCKETJS.EXE · ONE PROCESS · NO WEBVIEW · NO DEVICE-SPECIFIC APP CODE</text>
  <rect x="14" y="34" width="732" height="240" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="28" y="54" width="128" height="54" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="92" y="75" fill="#e2e8f0" font-size="12" text-anchor="middle">Solid + TSX</text>
  <text x="92" y="94" fill="#64748b" font-size="10" text-anchor="middle">app.js · app.pak</text>
  <path d="M160 81 H194" stroke="#475569"/><path d="M194 81 l-8 -5 M194 81 l-8 5" stroke="#475569" fill="none"/>
  <rect x="198" y="54" width="118" height="54" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="257" y="75" fill="#e2e8f0" font-size="12" text-anchor="middle">QuickJS</text>
  <text x="257" y="94" fill="#64748b" font-size="10" text-anchor="middle">global frame()</text>
  <path d="M320 81 H354" stroke="#475569"/><path d="M354 81 l-8 -5 M354 81 l-8 5" stroke="#475569" fill="none"/>
  <rect x="358" y="54" width="130" height="54" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="423" y="75" fill="#e2e8f0" font-size="12" text-anchor="middle">HostOps</text>
  <text x="423" y="94" fill="#22d3ee" font-size="10" text-anchor="middle">tree mutations</text>
  <path d="M492 81 H526" stroke="#475569"/><path d="M526 81 l-8 -5 M526 81 l-8 5" stroke="#475569" fill="none"/>
  <rect x="530" y="54" width="202" height="54" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="631" y="75" fill="#e2e8f0" font-size="12" text-anchor="middle">Rust retained UI core</text>
  <text x="631" y="94" fill="#64748b" font-size="10" text-anchor="middle">layout · animate · hit-test</text>
  <path d="M631 112 V136" stroke="#475569"/><path d="M631 136 l-5 -8 M631 136 l5 -8" stroke="#475569" fill="none"/>
  <rect x="530" y="140" width="202" height="48" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="631" y="161" fill="#e2e8f0" font-size="12" text-anchor="middle">software rasterizer</text>
  <text x="631" y="178" fill="#64748b" font-size="10" text-anchor="middle">480×720 BGRA</text>
  <path d="M526 164 H480" stroke="#475569"/><path d="M480 164 l8 -5 M480 164 l8 5" stroke="#475569" fill="none"/>
  <rect x="298" y="140" width="178" height="48" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="387" y="161" fill="#e2e8f0" font-size="12" text-anchor="middle">SetDIBitsToDevice</text>
  <text x="387" y="178" fill="#22d3ee" font-size="10" text-anchor="middle">no scaling · one copy</text>
  <path d="M294 164 H248" stroke="#475569"/><path d="M248 164 l8 -5 M248 164 l8 5" stroke="#475569" fill="none"/>
  <rect x="28" y="140" width="216" height="48" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="136" y="161" fill="#e2e8f0" font-size="12" text-anchor="middle">M8 LCD</text>
  <text x="136" y="178" fill="#64748b" font-size="10" text-anchor="middle">physical 480×720 pixels</text>
  <line x1="28" y1="210" x2="732" y2="210" stroke="#1e293b"/>
  <text x="28" y="232" fill="#64748b" font-size="10.5">INPUT RETURNS THE OTHER WAY</text>
  <rect x="28" y="242" width="174" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/><text x="115" y="260" fill="#94a3b8" text-anchor="middle" font-size="10.5">WM_LBUTTON* / KEYDOWN</text>
  <path d="M206 255 H242" stroke="#475569"/><path d="M242 255 l-8 -5 M242 255 l-8 5" stroke="#475569" fill="none"/>
  <rect x="246" y="242" width="210" height="26" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="351" y="260" fill="#22d3ee" text-anchor="middle" font-size="10.5">held state + one-frame latch</text>
  <path d="M460 255 H496" stroke="#475569"/><path d="M496 255 l-8 -5 M496 255 l-8 5" stroke="#475569" fill="none"/>
  <rect x="500" y="242" width="232" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/><text x="616" y="260" fill="#94a3b8" text-anchor="middle" font-size="10.5">frame(buttons, analog, touches)</text>
  <rect x="14" y="292" width="360" height="104" rx="10" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="28" y="316" fill="#f1f5f9" font-size="12" font-weight="700">PocketJS owns</text>
  <text x="28" y="338" fill="#94a3b8" font-size="11">the guest lifecycle, layout, animation, text,</text>
  <text x="28" y="357" fill="#94a3b8" font-size="11">hit testing, rasterization and every app pixel.</text>
  <text x="28" y="382" fill="#22d3ee" font-size="10.5">unchanged framework and application model</text>
  <rect x="386" y="292" width="360" height="104" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="400" y="316" fill="#f1f5f9" font-size="12" font-weight="700">Windows CE host owns</text>
  <text x="400" y="338" fill="#94a3b8" font-size="11">the HWND, message pump, timer, physical input,</text>
  <text x="400" y="357" fill="#94a3b8" font-size="11">GDI presentation, process exit and shell entry.</text>
  <text x="400" y="382" fill="#64748b" font-size="10.5">one target-specific C boundary</text>
</svg>

Boot makes the ownership concrete. The native host creates a QuickJS runtime and context, installs the `ui` host object, mounts the embedded `__pak`, evaluates the embedded JavaScript, and retains `globalThis.frame`. Every timer tick packs the current input, calls that function once, drains pending promise jobs, advances one fixed 60 Hz UI tick, and asks the core for the current framebuffer.

This is not Electron made smaller. There is no HTML parser, CSS engine, browser layout, JavaScriptCore port, or off-device renderer. Solid's reactive graph runs in QuickJS; PocketJS's Rust core is the UI engine; WinCE only sees a popup window with pixels and messages.

## Building a WinCE executable without a Windows PC

Modern Rust does not have a `windows-ce-armv6` target. CeGCC does not know how to compile Rust. QuickJS has never heard of this OEM shell. The build works because none of those facts needs to be changed.

The core is compiled with a small custom `armv6-none-eabi` target to **assembly**, not to a final object. A sanitizer removes directives the old GNU assembler does not understand. CeGCC then assembles that output alongside the C host, compatibility layer, patched QuickJS objects, generated embedded JavaScript and asset-pack objects, and links a WinCE PE executable against `COREDLL.dll`.

<svg viewBox="0 0 760 350" width="100%" role="img" aria-label="Build pipeline for PocketJS on Meizu M8. Bun compiles the Solid app to JavaScript and creates an asset pack. Rust compiles the no-standard-library core for a custom ARMv6 target to assembly, which is sanitized. A pinned Linux amd64 CeGCC container assembles the Rust output and compiles the C host, compatibility code and QuickJS. The linker combines those objects and embedded guest bytes into PocketJS.exe. Objdump verifies an ARM little-endian WinCE PE importing COREDLL.dll, and an eleven-stage receipt records the result." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE TWO COMPILERS MEET AT ASSEMBLY, THEN ONE OLD LINKER OWNS THE PE</text>
  <rect x="14" y="34" width="732" height="224" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="28" y="56" width="150" height="54" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="103" y="77" fill="#e2e8f0" font-size="12" text-anchor="middle">Solid app + assets</text>
  <text x="103" y="96" fill="#64748b" font-size="10" text-anchor="middle">Bun → JS + PAK</text>
  <rect x="28" y="132" width="150" height="54" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="103" y="153" fill="#e2e8f0" font-size="12" text-anchor="middle">pocketjs-core</text>
  <text x="103" y="172" fill="#64748b" font-size="10" text-anchor="middle">Rust → ARMv6 .s</text>
  <path d="M182 159 H218" stroke="#475569"/><path d="M218 159 l-8 -5 M218 159 l-8 5" stroke="#475569" fill="none"/>
  <rect x="222" y="132" width="128" height="54" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="286" y="153" fill="#e2e8f0" font-size="12" text-anchor="middle">sanitize .s</text>
  <text x="286" y="172" fill="#22d3ee" font-size="10" text-anchor="middle">old GAS dialect</text>
  <path d="M354 159 H390" stroke="#475569"/><path d="M390 159 l-8 -5 M390 159 l-8 5" stroke="#475569" fill="none"/>
  <rect x="394" y="56" width="160" height="130" rx="8" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="474" y="78" fill="#f1f5f9" font-size="12" text-anchor="middle" font-weight="700">CeGCC container</text>
  <text x="474" y="101" fill="#94a3b8" font-size="10.5" text-anchor="middle">assemble Rust</text>
  <text x="474" y="120" fill="#94a3b8" font-size="10.5" text-anchor="middle">compile C host</text>
  <text x="474" y="139" fill="#94a3b8" font-size="10.5" text-anchor="middle">compile QuickJS</text>
  <text x="474" y="158" fill="#94a3b8" font-size="10.5" text-anchor="middle">embed JS + PAK</text>
  <text x="474" y="177" fill="#22d3ee" font-size="10.5" text-anchor="middle">link against COREDLL</text>
  <path d="M182 83 H390" stroke="#475569"/><path d="M390 83 l-8 -5 M390 83 l-8 5" stroke="#475569" fill="none"/>
  <path d="M558 121 H594" stroke="#475569"/><path d="M594 121 l-8 -5 M594 121 l-8 5" stroke="#475569" fill="none"/>
  <rect x="598" y="92" width="134" height="58" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="665" y="115" fill="#e2e8f0" font-size="12" text-anchor="middle">PocketJS.exe</text>
  <text x="665" y="135" fill="#64748b" font-size="10">PE · ARM · WinCE</text>
  <rect x="28" y="206" width="704" height="34" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="228" fill="#94a3b8" text-anchor="middle" font-size="10.5">objdump → pei-arm-wince-little · imports COREDLL.dll · no host-native object may enter</text>
  <rect x="14" y="276" width="732" height="60" rx="9" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="28" y="300" fill="#f1f5f9" font-size="12" font-weight="700">receipt, not folklore</text>
  <text x="28" y="321" fill="#94a3b8" font-size="11">tool image digest · source hashes · guest profile · viewport · PE identity · all 11 validation stages</text>
</svg>

That assembly handoff is deliberately narrow. Rust still checks and optimizes the renderer; the old toolchain still owns the ABI, object format, import library and final link it understands. The container is Linux/amd64 and digest-pinned, which matters on an Apple Silicon development machine: a mutable tag is not a toolchain receipt.

The output is intentionally monolithic. On a disconnected phone, `PocketJS.exe` already contains the guest and its resources. Deployment is one file plus one icon, not a directory of runtime dependencies whose load order the 2009 shell gets to reinterpret.

## The USB cable is a network

The M8 appears as USB vendor/product `0547:2720`, named `MEIZU M8SE USB Serial`. It does not present a filesystem, an Android Debug Bridge, or a modern network interface. It exposes the Windows CE `WceUsbSh` ActiveSync serial function.

On the Mac, the development session claims that USB interface with libusb and presents it as a pseudoterminal. The phone sends the literal ActiveSync greeting `CLIENT`; the host answers `CLIENTSERVER`; `pppd` negotiates `192.168.131.1` on the Mac and `192.168.131.129` on the phone. An isolated D-Bus plus SynCE's `dccm` discovers the device over that link. RAPI finally supplies the verbs we wanted all along: make a directory, copy a file, launch a process, read a status file, edit the OEM shell registry.

<svg viewBox="0 0 760 404" width="100%" role="img" aria-label="Protocol ladder from a 2026 Mac to the Meizu M8. At the bottom, USB 0547 colon 2720 carries the WceUsbSh serial function. A libusb bridge turns it into a pseudoterminal. The phone says CLIENT and the Mac says CLIENTSERVER. PPP assigns 192.168.131.1 and 192.168.131.129. An isolated D-Bus and SynCE dccm discover the Windows CE device. RAPI tools pcp, prun and registry operations deploy, launch and inspect PocketJS. The diagram emphasizes that no firmware or partition is flashed." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE MINI-USB CABLE · SIX LAYERS · ZERO FIRMWARE WRITES</text>
  <rect x="14" y="34" width="732" height="340" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g font-size="11.5">
    <rect x="34" y="54" width="692" height="42" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="52" y="79" fill="#22d3ee" font-weight="700">6 · RAPI</text><text x="176" y="79" fill="#e2e8f0">pmkdir · pcp · prun · registry · status and framebuffer receipts</text>
    <rect x="54" y="104" width="652" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="72" y="129" fill="#38bdf8" font-weight="700">5 · discovery</text><text x="196" y="129" fill="#94a3b8">isolated D-Bus → SynCE dccm → connected device</text>
    <rect x="74" y="154" width="612" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="92" y="179" fill="#38bdf8" font-weight="700">4 · PPP</text><text x="196" y="179" fill="#94a3b8">Mac 192.168.131.1 ⇄ phone 192.168.131.129</text>
    <rect x="94" y="204" width="572" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="112" y="229" fill="#38bdf8" font-weight="700">3 · handshake</text><text x="236" y="229" fill="#94a3b8">CLIENT ⇄ CLIENTSERVER</text>
    <rect x="114" y="254" width="532" height="42" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="132" y="279" fill="#38bdf8" font-weight="700">2 · bridge</text><text x="236" y="279" fill="#94a3b8">libusb bulk endpoints ⇄ PTY ⇄ macOS pppd</text>
    <rect x="134" y="304" width="492" height="42" rx="7" fill="#0e1626" stroke="#38bdf8"/>
    <text x="152" y="329" fill="#38bdf8" font-weight="700">1 · USB</text><text x="236" y="329" fill="#94a3b8">0547:2720 · WceUsbSh ActiveSync serial</text>
  </g>
  <text x="380" y="366" fill="#64748b" text-anchor="middle" font-size="10.5">The phone is deployed over an IP session hiding inside a USB serial function.</text>
</svg>

Calling this “USB deployment” is correct at the cable and misleading at every useful layer above it. The file copy is a remote API call over a session discovered over PPP over a serial protocol over USB.

It is also fragile in historically specific ways. A stale privileged `pppd` can keep an old PTY open. The phone can reconnect with a new USB handle while the higher layers still believe they own the last one. The handshake can be fragmented across reads. The bridge therefore treats reconnect and handshake replay as ordinary states, discovers the PPP interface dynamically, and keeps its own D-Bus session away from the Mac's normal desktop services.

Then we launched the app, asked the phone for a screenshot, and received this:

<img class="mx-auto w-full max-w-sm rounded-xl border border-line" src="/assets/blog/meizu-m8-sync-shell.png" alt="The Meizu M8 desktop at 480 by 720 showing the phone's Synchronizing panel over a foliage wallpaper, with no PocketJS application visible." />

<p class="text-sm text-slate-500 text-center -mt-4">A successful RAPI connection and a live PocketJS process, yet the OEM synchronizing shell was the visible window. Transport truth is not display truth.</p>

The native dialog at the start of this post was still alive underneath. For the capture, a tiny helper temporarily raised that existing dialog to the top and GDI read the desktop back. We did not make the shipping PocketJS window topmost to win the screenshot — that exact policy had already caused one of the port's real bugs.

## Three screens that all said “it works”

The first executable launched. The first guest advanced frames. The first framebuffer capture contained the PocketJS demo. Every sentence there is true, and none says the UI was acceptable.

<div class="grid grid-cols-1 gap-5 sm:grid-cols-3">
  <figure>
    <img class="w-full rounded-xl border border-line" src="/assets/blog/meizu-m8-first-frame-320.png" alt="The first PocketJS demo frame on Meizu M8 at 320 by 480. The headline is clipped, the UI is small, and the output does not fill the phone's native 480 by 720 coordinate space correctly." />
    <figcaption class="mt-2 text-sm text-slate-500"><strong class="text-slate-300">1 · real pixels, wrong surface.</strong> The inherited 320×480 assumption clipped the headline and made the phone scale the result.</figcaption>
  </figure>
  <figure>
    <img class="w-full rounded-xl border border-line" src="/assets/blog/meizu-m8-native-frame-480.png" alt="PocketJS JSX on M8 demo at native 480 by 720, with a crisp but very small headline, body text and touch button in the upper half of the portrait screen." />
    <figcaption class="mt-2 text-sm text-slate-500"><strong class="text-slate-300">2 · native pixels, wrong scale.</strong> The framebuffer now matched the LCD exactly. The layout still carried phone-sized assumptions from a smaller viewport.</figcaption>
  </figure>
  <figure>
    <img class="w-full rounded-xl border border-line" src="/assets/blog/meizu-m8-readable-frame-480.png" alt="The final PocketJS JSX on M8 demo at native 480 by 720 with a large readable headline, larger explanatory text, status chips and a comfortably sized blue Tap Here button." />
    <figcaption class="mt-2 text-sm text-slate-500"><strong class="text-slate-300">3 · native and readable.</strong> Type, spacing and the touch target scale by 1.5× while the framebuffer remains one device pixel per output pixel.</figcaption>
  </figure>
</div>

These were not three static mockups. They were three builds photographed by the runtime's own on-device capture path. The decisive review still came from looking at the physical panel: the first title was visibly cut off; the second was crisp but too small; the third made the button usable under a finger.

This distinction matters on high-density old hardware. “Retina” is not an asset property and native resolution is not a usability metric. The correct outcome required both: **a 480×720 physical framebuffer with no stretch, and a layout whose logical sizes fit the density of the actual panel.**

## Touch is not a mouse until one frame sees it

Windows CE gives the host pointer coordinates in `lParam`. That part is easy. Preserving the event through PocketJS's device-neutral input ABI was not.

An older packed touch word had nine bits per axis. Nine bits can represent 0 through 511. The M8's `y` coordinate reaches 719. Touches in the lower 208 rows therefore could not be represented faithfully even though GDI could draw those rows perfectly. Host ABI 8 added the wide touch-word form, and the M8 profile requires it.

The second failure was temporal. The guest samples input once per 60 Hz frame, while WinCE sends down and up messages whenever they occur. A quick tap can begin and end between two samples. If the host only reports “currently held”, the guest observes nothing. A press latch preserves the down edge for one frame even if the release has already arrived.

<svg viewBox="0 0 760 342" width="100%" role="img" aria-label="Touch sampling timeline. In the broken path, a touch down at 7 milliseconds and touch up at 12 milliseconds both occur between frame zero and frame one at 16.7 milliseconds, so held state is false at both samples and the tap disappears. In the fixed path, touch down sets a one-frame latch. Touch up clears held state but not the latch, so frame one receives a touch hit with a full wide coordinate and then clears the latch." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">A 5 ms TAP BETWEEN TWO 60 Hz SAMPLES</text>
  <rect x="14" y="34" width="732" height="132" rx="10" fill="#1a0e12" stroke="#7f1d1d"/>
  <text x="28" y="58" fill="#fca5a5" font-size="12" font-weight="700">broken · report held state only</text>
  <line x1="72" y1="108" x2="704" y2="108" stroke="#475569" stroke-width="1.5"/>
  <line x1="72" y1="88" x2="72" y2="128" stroke="#94a3b8"/><text x="72" y="146" fill="#94a3b8" text-anchor="middle" font-size="10">frame 0 · false</text>
  <line x1="704" y1="88" x2="704" y2="128" stroke="#94a3b8"/><text x="704" y="146" fill="#94a3b8" text-anchor="middle" font-size="10">frame 1 · false</text>
  <circle cx="337" cy="108" r="6" fill="#f87171"/><text x="337" y="90" fill="#fca5a5" text-anchor="middle" font-size="10.5">DOWN · 7 ms</text>
  <circle cx="526" cy="108" r="6" fill="#f87171"/><text x="526" y="90" fill="#fca5a5" text-anchor="middle" font-size="10.5">UP · 12 ms</text>
  <text x="388" y="160" fill="#f87171" text-anchor="middle" font-size="10.5">the guest never sees the tap</text>
  <rect x="14" y="184" width="732" height="144" rx="10" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="28" y="208" fill="#f1f5f9" font-size="12" font-weight="700">fixed · held state plus a one-frame press latch</text>
  <line x1="72" y1="258" x2="704" y2="258" stroke="#475569" stroke-width="1.5"/>
  <line x1="72" y1="238" x2="72" y2="278" stroke="#94a3b8"/><text x="72" y="298" fill="#94a3b8" text-anchor="middle" font-size="10">frame 0</text>
  <circle cx="337" cy="258" r="6" fill="#22d3ee"/><text x="337" y="240" fill="#22d3ee" text-anchor="middle" font-size="10.5">DOWN · latch = 1</text>
  <circle cx="526" cy="258" r="6" fill="#38bdf8"/><text x="526" y="240" fill="#38bdf8" text-anchor="middle" font-size="10.5">UP · held = 0</text>
  <line x1="704" y1="238" x2="704" y2="278" stroke="#22d3ee" stroke-width="1.5"/><text x="704" y="298" fill="#22d3ee" text-anchor="middle" font-size="10">frame 1 · hit = 1</text>
  <path d="M343 270 C430 318 620 318 697 273" stroke="#22d3ee" fill="none" stroke-dasharray="4 4"/>
  <text x="388" y="322" fill="#94a3b8" text-anchor="middle" font-size="10.5">wide x/y survive · hit test consumes the down edge · latch clears after the frame</text>
</svg>

The same fix serves every pointer-shaped device without leaking `WM_LBUTTONDOWN` into app code. The host deals in OS messages. PocketJS deals in a hardware-neutral frame containing touches and hits. The application only sees its ordinary `onPress` handler.

## Home, topmost, and the icon that would not forget

Our first fullscreen window was system-topmost. That made the demo impressively difficult to leave. The M8 shell could receive Home, but it could not visibly reclaim the screen from an application insisting it belonged above the system.

The correct host is a borderless 480×720 popup, **not** a system-topmost window. Home or Escape posts `WM_CLOSE`; destruction posts `WM_QUIT`; the pump exits; the process returns. Being full-screen is a geometry choice, not a claim to outrank the shell.

The application menu needed another OEM-specific bridge. Meizu's `MiniOneShell` discovers entries under `HKLM\SOFTWARE\Meizu\MiniOneShell\Main`. Deployment writes the PocketJS title, executable and icon values there. The icon file is build-ID-qualified because the shell cached the first path so aggressively that overwriting the bytes could still show the old picture.

<div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
  <figure class="rounded-xl border border-line bg-slate-950 p-6 text-center">
    <img class="mx-auto h-20 w-20" src="/assets/blog/meizu-m8-icon-player.png" alt="The first incorrect M8 shell icon, an 80 by 80 purple rounded-square media player symbol." />
    <figcaption class="mt-3 text-sm text-slate-500"><strong class="text-slate-300">First registration.</strong> A generic purple player icon — technically valid, visibly wrong.</figcaption>
  </figure>
  <figure class="rounded-xl border border-line bg-slate-950 p-6 text-center">
    <img class="mx-auto h-20 w-20" src="/assets/blog/meizu-m8-icon-pocketjs.png" alt="The corrected M8 PocketJS shell icon, an 80 by 80 black and silver handheld device mark." />
    <figcaption class="mt-3 text-sm text-slate-500"><strong class="text-slate-300">Build-qualified replacement.</strong> The PocketJS handheld mark, derived from the first-iPhone port's shipped icon.</figcaption>
  </figure>
</div>

This is where “support the device” expands beyond compiling for its CPU. A native citizen needs an exit path, a shell identity, an icon that survives caching, and a deployment tool that can repair only its own previous processes and registry values.

## Evidence is a ladder

During the port, a successful command was repeatedly mistaken for a successful layer above it. USB enumeration does not prove PPP. PPP does not prove RAPI. RAPI does not prove the PE loader accepted the binary. A process does not prove the guest booted. Frames do not prove GDI composited. A framebuffer does not prove the user can touch the button or return Home.

So the device workflow makes the ladder explicit.

<svg viewBox="0 0 760 496" width="100%" role="img" aria-label="Eleven-stage evidence ladder for the Meizu M8 port. The stages are USB identity, ActiveSync handshake, PPP peer, RAPI discovery, file copy and ARM PE launch, guest boot, advancing guest frames, successful GDI composites, native 480 by 720 logical and physical viewport, device-generated framebuffer capture, and physical touch Home-key and shell-icon acceptance. Automated receipts cover the first ten while direct physical observation covers the final behavior." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">EACH RUNG PROVES ITSELF · NO LOWER RUNG MAY STAND IN FOR A HIGHER ONE</text>
  <rect x="14" y="34" width="732" height="440" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g font-size="11">
    <rect x="34" y="424" width="394" height="32" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="48" y="445" fill="#e2e8f0">1 · USB 0547:2720 enumerates</text><text x="414" y="445" fill="#38bdf8" text-anchor="end">host receipt</text>
    <rect x="54" y="386" width="414" height="32" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="68" y="407" fill="#e2e8f0">2 · CLIENT / CLIENTSERVER completes</text><text x="454" y="407" fill="#38bdf8" text-anchor="end">bridge receipt</text>
    <rect x="74" y="348" width="434" height="32" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="88" y="369" fill="#e2e8f0">3 · PPP peer is 192.168.131.129</text><text x="494" y="369" fill="#38bdf8" text-anchor="end">network receipt</text>
    <rect x="94" y="310" width="454" height="32" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="108" y="331" fill="#e2e8f0">4 · RAPI discovers this device</text><text x="534" y="331" fill="#38bdf8" text-anchor="end">device identity</text>
    <rect x="114" y="272" width="474" height="32" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="128" y="293" fill="#e2e8f0">5 · build-qualified ARM PE launches</text><text x="574" y="293" fill="#38bdf8" text-anchor="end">process receipt</text>
    <rect x="134" y="234" width="494" height="32" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="148" y="255" fill="#e2e8f0">6 · QuickJS evaluates the embedded guest</text><text x="614" y="255" fill="#22d3ee" text-anchor="end">boot receipt</text>
    <rect x="154" y="196" width="514" height="32" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="168" y="217" fill="#e2e8f0">7 · guest frame counter advances</text><text x="654" y="217" fill="#22d3ee" text-anchor="end">runtime receipt</text>
    <rect x="174" y="158" width="534" height="32" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="188" y="179" fill="#e2e8f0">8 · GDI composite count advances</text><text x="694" y="179" fill="#22d3ee" text-anchor="end">display receipt</text>
    <rect x="194" y="120" width="532" height="32" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="208" y="141" fill="#e2e8f0">9 · logical = physical = 480×720</text><text x="712" y="141" fill="#22d3ee" text-anchor="end">viewport receipt</text>
    <rect x="214" y="82" width="512" height="32" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="228" y="103" fill="#e2e8f0">10 · phone writes the framebuffer BMP</text><text x="712" y="103" fill="#22d3ee" text-anchor="end">pixel artifact</text>
    <rect x="234" y="44" width="492" height="32" rx="6" fill="#172015" stroke="#65a30d" stroke-width="1.3"/><text x="248" y="65" fill="#ecfccb">11 · touch · readability · Home · shell icon</text><text x="712" y="65" fill="#a3e635" text-anchor="end">physical device</text>
  </g>
  <text x="474" y="448" fill="#64748b" font-size="10.5">transport</text>
  <text x="594" y="296" fill="#64748b" font-size="10.5">loader</text>
  <text x="674" y="220" fill="#64748b" font-size="10.5">runtime</text>
  <text x="714" y="468" fill="#64748b" font-size="10.5" text-anchor="end">automated → pixels → human behavior</text>
</svg>

The status and framebuffer paths contain the build ID. That prevents a stale process from writing convincing evidence into the current build's filenames. Captures are written to a temporary path and renamed only when complete. The verifier rejects the wrong dimensions, a non-advancing frame counter, no successful GDI composite, or a logical and physical viewport that disagree.

The top rung remains irreducibly physical. A bitmap can prove that a button exists. It cannot prove that a thumb can comfortably hit it, that the Home key returns to Meizu's shell, or that the icon looks right beside the phone's native applications.

## What the port cost

<svg viewBox="0 0 760 270" width="100%" role="img" aria-label="Port summary for PocketJS pull request 279. It changed 34 files with 2967 additions and 50 deletions across 7 commits. Post-implementation review found and fixed 9 issues. The final build passed 11 of 11 stages. One physical Meizu M8 was used over about two days. The production target registry received zero entries." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE WINDOWS CE PORT · POCKETJS #279</text>
  <rect x="14" y="34" width="732" height="184" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g text-anchor="middle">
    <text x="98" y="84" fill="#22d3ee" font-size="30" font-weight="700">34</text><text x="98" y="106" fill="#94a3b8" font-size="11">files</text>
    <text x="210" y="84" fill="#22d3ee" font-size="30" font-weight="700">+2,967</text><text x="210" y="106" fill="#94a3b8" font-size="11">lines added</text>
    <text x="322" y="84" fill="#22d3ee" font-size="30" font-weight="700">7</text><text x="322" y="106" fill="#94a3b8" font-size="11">commits</text>
    <text x="434" y="84" fill="#22d3ee" font-size="30" font-weight="700">9</text><text x="434" y="106" fill="#94a3b8" font-size="11">review fixes</text>
    <text x="546" y="84" fill="#22d3ee" font-size="30" font-weight="700">11/11</text><text x="546" y="106" fill="#94a3b8" font-size="11">build stages</text>
    <text x="658" y="84" fill="#22d3ee" font-size="30" font-weight="700">1</text><text x="658" y="106" fill="#94a3b8" font-size="11">physical M8</text>
  </g>
  <line x1="34" y1="128" x2="726" y2="128" stroke="#1e293b"/>
  <text x="34" y="152" fill="#e2e8f0" font-size="11.5">new: WinCE host · custom Rust target · CeGCC build · USB bridge · PPP/RAPI session · deploy/status/capture · demo</text>
  <text x="34" y="177" fill="#94a3b8" font-size="11.5">fixed after hardware review: bounded status · fragmented handshake · 60 Hz tick · wide touch · atomic capture · dynamic PPP</text>
  <text x="34" y="202" fill="#22d3ee" font-size="11.5">~2 days · one merged PR · production targets added: 0 · firmware partitions modified: 0</text>
  <text x="14" y="248" fill="#64748b" font-size="11">The large surface is the toolchain and transport. The app remains ordinary Solid, and the framework has no Meizu branch.</text>
</svg>

The nine review findings matter more than the count. They were the places where a successful happy path had concealed an unreliable contract: an unbounded status write, a handshake parser that assumed USB read boundaries were protocol boundaries, a 60 Hz UI receiving the wrong number of ticks, a touch edge that could vanish, a framebuffer that could be observed half-written, a QuickJS build that depended on an already-dirty checkout, and a PPP interface name treated as permanent.

Those are not Windows CE curiosities. They are the usual difference between a demo and a port: define which boundary owns each piece of state, then make every transition observable and retryable.

## The honest boundary

Windows CE is **not** a production PocketJS target. The profile is named `meizu-m8-dev` and deliberately lives outside the production target registry.

- Build, deploy, launch, native 480×720 output, touch interaction, Home/Escape exit and MiniOneShell registration were accepted on **one** physical M8/M8SE.
- Presentation is software BGRA through GDI. There is no M8 GPU backend, hardware acceleration claim, emulator matrix or device farm.
- Deployment depends on a historically fragile ActiveSync serial → PPP → RAPI chain and host-side compatibility tools. It does not flash firmware or modify a partition.
- The final post-review tree passed all eleven build and host validation stages. The last merge build was not redeployed after the phone stopped enumerating in that session; the real-device UI, touch, Home and icon passes had been completed on the preceding build. The connected phone in the opening screenshot freshly proves the native WinCE dialog and transport path, not a new end-to-end PocketJS acceptance run.
- The screenshots in this post are device artifacts from that porting session or from the currently connected phone. None is a browser mockup.

That penultimate distinction is deliberately awkward. A current native dialog proves that our compiler can still produce an ARM WinCE binary, RAPI can still launch it, and GDI can still capture it. It does not silently upgrade historical PocketJS evidence into a current final-build hardware pass. Evidence should get more specific when it is incomplete, not more confident.

## Why bother

The Symbian port tested whether PocketJS could live inside an operating system with an alien scheduler, window server, capability model and application identity. Windows CE tests the opposite danger: an API shape familiar enough that you assume you already understand the device.

The M8 has `WinMain`, `HWND`, `WM_PAINT`, GDI and a registry. Then the actual phone adds a portrait density the inherited profile did not fit, a shell that a topmost window can trap, a touch range wider than the host ABI, an icon cache coupled to file paths, and an ActiveSync function that becomes useful only after six protocol layers. The broad nouns were familiar. The failure modes were physical.

The architectural result is the same one the E7 gave us from the other direction. The application did not learn Windows messages. Solid did not learn about Meizu. The retained tree did not gain a GDI condition. A target-specific host turned messages into one frame input and one complete framebuffer into a GDI call; a target-specific toolchain made that host deployable; the rest stayed put.

That is what a platform boundary is for. Not to make a new machine easy, exactly. To make it obvious where the hard parts belong.

And there is something perfect about using a 2026 Mac, a USB protocol from the ActiveSync era, a Rust renderer, and a JavaScript component to put one blue button on a 2009 phone — then asking Windows CE itself to pop a dialog over the whole thing and explain what just happened.

---

*PocketJS is open source at [pocket-stack/pocketjs](https://github.com/pocket-stack/pocketjs). The M8 workflow is documented in [`docs/MEIZU_M8.md`](https://github.com/pocket-stack/pocketjs/blob/main/docs/MEIZU_M8.md), and the complete port is [PR #279](https://github.com/pocket-stack/pocketjs/pull/279). For the two neighboring operating-system models, read [A UI Runtime Walked Into an Active Object: PocketJS on Symbian](/blog/pocketjs-on-symbian/) and [No Shaders, No Objective-C: PocketJS on the First iPhone](/blog/pocketjs-on-the-first-iphone/).*
