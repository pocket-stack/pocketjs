<img class="rounded-xl border border-line" width="320" src="/assets/blog/iphone2g-hero-320.png" alt="The PocketJS Hero demo at 320 by 480: a PocketJS header with FPS, NODES and DRAWS counters reading 60, 42 and 9, the headline 'JSX on ARMv6.', a gradient underline, body text reading 'Flexbox, springs and baked type — running on a 2007 touchscreen', a blue 'Tap Hero' button, 'Count: 5', and the line 'Reactive on real hardware.'" />

<p class="text-sm text-slate-500 -mt-4">The Hero demo at the original iPhone's native 320×480, after five taps. This frame is the real iPhone guest bundle — resolved against the <code>iphone2g-dev</code> build profile, booted at the device's exact viewport, rasterized by the same wasm core our byte-exact pixel goldens run on. The <code>60</code> in the corner is the presentation rate the app is told it has, and the device now runs the loop off <code>CADisplayLink</code>.</p>

Xcode 26.6 still compiles ARMv6. Its `ld-classic` still links against a 2008 `UIKit`. What the current toolchain will *not* do is hand its own Objective-C output to a loader from 2008 — so the host that puts [PocketJS](/blog/introducing-pocketjs/) on the original iPhone contains no Objective-C at all. It is C, and it builds its `UIView` and app delegate at startup by calling `objc_allocateClassPair`.

If you have not met PocketJS: it runs real [Solid](https://www.solidjs.com/), Vue Vapor and [Octane](/blog/octane-on-psp/) components — JSX, reactivity, flexbox, Tailwind classes, springs — on hardware with no browser and no JIT. It started on a 2004 Sony PSP at 333 MHz and has since reached a [PS Vita](/blog/pocketjs-on-ps-vita/), a [Nokia E7](/blog/pocketjs-on-symbian/), an ESP32-P4 and an e-reader. The runtime is a Rust core plus [QuickJS](https://bellard.org/quickjs/); applications are ordinary TypeScript.

The iPhone is the newest target and the **oldest touchscreen**: `iPhone1,1`, June 2007, one ARM1176JZF-S, 128 MB of RAM, 320×480, and a GPU that predates programmable shading. This post is what a port looks like when the machine is old enough that every convenience is missing and none of the capability is: a compiler back end that survived, a linker that cannot read its own compiler's output, and two mutually incompatible UIKits inside one executable.

Then, at the end, the part I did not expect to write. We built the fixed-function OpenGL ES 1.1 backend this GPU needs, got it running on the device, and measured it against the software rasterizer it was supposed to replace. **The CPU won by a factor of 2.4**, and the reason turns out to be a property of the UI rather than of the hardware.

Along the way our first "it runs on hardware" proof turned out to be measuring the wrong thing, which is the other part I would most want someone else to steal.

## The machine

<svg viewBox="0 0 760 236" width="100%" role="img" aria-label="Comparison of four PocketJS targets. Sony PSP-1000 from 2004: 333 megahertz MIPS single core, 32 megabytes RAM, 480 by 272 screen, fixed-function GE graphics. PS Vita from 2011: four-core ARM Cortex-A9, 512 megabytes, 960 by 544, SceGxm. Nokia E7 from 2011: 680 megahertz ARM11, 256 megabytes, 640 by 360, OpenGL ES 2. Original iPhone from 2007, highlighted: ARM1176JZF-S single core, 128 megabytes, 320 by 480, reached either through an OpenGL ES 1.1 fixed-function pipeline or a CGImage blit." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">MACHINE</text>
  <text x="212" y="20" fill="#64748b" font-size="11">CPU</text>
  <text x="392" y="20" fill="#64748b" font-size="11">RAM</text>
  <text x="466" y="20" fill="#64748b" font-size="11">SCREEN</text>
  <text x="576" y="20" fill="#64748b" font-size="11">TO THE PANEL VIA</text>
  <line x1="14" y1="30" x2="746" y2="30" stroke="#1e293b"/>
  <text x="14" y="56" fill="#e2e8f0" font-size="12.5">Sony PSP-1000 · 2004</text>
  <text x="212" y="56" fill="#94a3b8" font-size="12">333 MHz MIPS, 1 core</text>
  <text x="392" y="56" fill="#94a3b8" font-size="12">32 MB</text>
  <text x="466" y="56" fill="#94a3b8" font-size="12">480×272</text>
  <text x="576" y="56" fill="#94a3b8" font-size="12">fixed-function GE</text>
  <text x="14" y="82" fill="#e2e8f0" font-size="12.5">Sony PS Vita · 2011</text>
  <text x="212" y="82" fill="#94a3b8" font-size="12">4× ARM Cortex-A9</text>
  <text x="392" y="82" fill="#94a3b8" font-size="12">512 MB</text>
  <text x="466" y="82" fill="#94a3b8" font-size="12">960×544</text>
  <text x="576" y="82" fill="#94a3b8" font-size="12">SceGxm</text>
  <text x="14" y="108" fill="#e2e8f0" font-size="12.5">Nokia E7 · 2011</text>
  <text x="212" y="108" fill="#94a3b8" font-size="12">680 MHz ARM11</text>
  <text x="392" y="108" fill="#94a3b8" font-size="12">256 MB</text>
  <text x="466" y="108" fill="#94a3b8" font-size="12">640×360</text>
  <text x="576" y="108" fill="#94a3b8" font-size="12">OpenGL ES 2</text>
  <rect x="8" y="118" width="738" height="34" rx="7" fill="#0e1626" stroke="#38bdf8" stroke-width="1.2"/>
  <text x="14" y="140" fill="#f1f5f9" font-size="12.5" font-weight="700">Apple iPhone · 2007</text>
  <text x="212" y="140" fill="#38bdf8" font-size="12">ARM1176JZF-S, 1 core</text>
  <text x="392" y="140" fill="#38bdf8" font-size="12">128 MB</text>
  <text x="466" y="140" fill="#38bdf8" font-size="12">320×480</text>
  <text x="576" y="140" fill="#38bdf8" font-size="12">GL ES 1.1 or CGImage</text>
  <line x1="14" y1="170" x2="746" y2="170" stroke="#1e293b"/>
  <text x="14" y="192" fill="#94a3b8" font-size="11">Every other target submits to a shader pipeline. This GPU has none, so it gets a fixed-function backend —</text>
  <text x="14" y="210" fill="#94a3b8" font-size="11">and a software rasterizer as the fallback. The build ships both, and the last section measures them.</text>
  <text x="14" y="230" fill="#22d3ee" font-size="11">It is also the first target where the OS owns app identity: a signed bundle that SpringBoard launches.</text>
</svg>

The GPU in there is a PowerVR MBX Lite, and what it can and cannot do is very specific. `OpenGLES.framework` is right there in the sysroot — ARMv6, 189 exported symbols — exporting `glTexImage2D`, `glVertexPointer`, `glEnableClientState` and `glOrthof`. What it does not export is `glCreateShader`, `glShaderSource`, `glCompileShader` or `glUseProgram`. **MBX Lite is OpenGL ES 1.1: fixed-function, no programmable pipeline.** PocketJS's existing GL backend was 1,431 lines of ES 2 with GLSL in it, so it could not run here at all.

Asking the device rather than the SDK settles it. A small ARMv6 probe that creates a context the same way the host does reports:

```text
GL_VENDOR      Imagination Technologies
GL_RENDERER    PowerVR MBXLite with VGPLite
GL_VERSION     OpenGL ES-CM 1.1 (48)
MAX_TEXTURE    1024
GL_EXTENSIONS  … GL_OES_framebuffer_object GL_OES_draw_texture
               GL_IMG_texture_format_BGRA8888 …
```

Everything in this post follows from four constraints, in the order we hit them.

## Constraint 1: the compiler survived, the scaffolding did not

The first question is whether a 2026 Mac can produce a binary a 2007 loader accepts. The encouraging answer is that **Apple never removed the ARMv6 back end or the classic linker.** Both are one flag away in Xcode 26.6:

```sh
$ xcrun clang -target armv6-apple-darwin8 -miphoneos-version-min=1.1.4 \
    -march=armv6 -Os -c probe.c -o probe.o
$ file probe.o
probe.o: Mach-O object arm_v6
$ xcrun -f ld-classic
…/XcodeDefault.xctoolchain/usr/bin/ld-classic
```

Apple clang 21 emits `cputype 12, cpusubtype 6`. What is gone is everything *around* the compiler: no SDK, no `crt1.o` for this target, and a default linker that produces a Mach-O the old loader will not read. Each of those is supplied by hand.

**The sysroot is a stock root filesystem, pinned file by file.** `-syslibroot` points at an extracted iPhone OS root image with `-L/usr/lib -F/System/Library/Frameworks`, and `doctor` hashes each of the six binaries the build actually links — `libSystem.B.dylib`, `libgcc_s.1.dylib`, `libobjc.A.dylib`, `UIKit`, `Foundation`, `CoreGraphics` — plus the SHA-256 of the raw image they came out of. Not files copied off a running phone, where anything installed later could have replaced them.

**The C runtime startup is compiled from Apple's own open source.** There is no `crt1.o` to link against, so the build takes [`Csu-76`](https://github.com/apple-oss-distributions/Csu)'s `start.s` and `dyld_glue.s` from a hash-pinned checkout, assembles them, and links with `-e start`.

**The link line is mostly a list of Mach-O features to switch off.** Every one of these is something the 2008 dyld has never heard of, and any one of them left on produces a binary that is perfectly valid and will not load:

```text
-no_pie  -no_uuid  -no_function_starts  -no_data_in_code_info
-no_source_version  -no_compact_unwind  -no_adhoc_codesign  -no_encryption
```

Then `ldid -S` applies a pseudo-signature, which a jailbroken device accepts in place of a real one. That is the first of exactly two places the jailbreak matters, and it is the whole extent of it: **the device must accept an unsigned binary and must offer SSH over USB.** How it got that way is somebody else's article.

### Why link against an SDK older than the target

One choice here looks like a mistake and is not. The executable carries `LC_VERSION_MIN_IPHONEOS` of **1.1.4** while the bundle declares `MinimumOSVersion 3.1.3` and the device runs 3.1.3.

The reason is that on this device family the *oldest* ABI is the portable one. Symbols and selectors were added over 1.x → 3.x, not removed, so a binary linked against the earliest root filesystem resolves on every later one; a binary linked against 3.1.3 would not run on anything before it. Linking low and probing high gets one executable that loads across the family, and it means the bytes we verify by hash can be the oldest and best-pinned image available rather than whatever is on the phone in front of us.

The cost is that the *running* OS then disagrees with the *linked* OS about how to start an application, which is Constraint 3.

<svg viewBox="0 0 760 320" width="100%" role="img" aria-label="Build pipeline for the iPhone bundle. Pinned inputs on the left: a hash-verified 1.1.4 sysroot with six libraries, Apple Csu-76 from source, pinned QuickJS, a pinned Rust nightly, and Xcode's clang with ld-classic. In the middle, six build steps run by bun iphone2g build: resolve pocket.json into a build plan at 320 by 480; the two-pass app build producing app.js and app.pak; cargo build-std for the custom armv6-apple-ios target; clang at ARMv6 compiling the C host, QuickJS and the compatibility shim; ld-classic linking to an arm_v6 executable with the guest embedded as DATA sections; and ldid signing. Target id, host ABI and viewport reach the C as minus D defines from the resolved plan, and the C files refuse to compile without them. On the right, the output bundle contains the arm_v6 executable, Info.plist, PkgInfo and a 59 by 60 icon, plus a build receipt recording every input hash and a per-build identifier, and the link result is verified with file, otool-classic and plutil." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="14" y="14" width="172" height="176" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="26" y="36" fill="#f1f5f9" font-size="12" font-weight="700">pinned inputs</text>
  <text x="26" y="58" fill="#94a3b8" font-size="10.5">1.1.4 sysroot · 6 libs</text>
  <text x="26" y="76" fill="#94a3b8" font-size="10.5">Apple Csu-76 (source)</text>
  <text x="26" y="94" fill="#94a3b8" font-size="10.5">QuickJS @ ba5bdd0d</text>
  <text x="26" y="112" fill="#94a3b8" font-size="10.5">rust nightly-2026-07-02</text>
  <text x="26" y="130" fill="#94a3b8" font-size="10.5">clang + ld-classic</text>
  <text x="26" y="152" fill="#38bdf8" font-size="10.5">all SHA-256 verified</text>
  <text x="26" y="174" fill="#64748b" font-size="10">outside the repo, always</text>
  <path d="M188 100 L200 100" stroke="#475569" stroke-width="1.5"/>
  <path d="M200 100 l-7 -5 M200 100 l-7 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="204" y="14" width="340" height="262" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.4"/>
  <text x="374" y="36" fill="#f1f5f9" font-size="12.5" font-weight="700" text-anchor="middle">bun iphone2g build</text>
  <text x="218" y="62" fill="#94a3b8" font-size="11">1 · resolve pocket.json → build plan (320×480)</text>
  <text x="218" y="84" fill="#94a3b8" font-size="11">2 · two-pass app build → app.js + app.pak</text>
  <text x="218" y="106" fill="#94a3b8" font-size="11">3 · cargo build-std → armv6-apple-ios .a</text>
  <text x="218" y="128" fill="#94a3b8" font-size="11">4 · clang -march=armv6 → host + QuickJS + shim</text>
  <text x="218" y="150" fill="#94a3b8" font-size="11">5 · ld-classic → arm_v6, guest in __DATA</text>
  <text x="218" y="172" fill="#94a3b8" font-size="11">6 · ldid -S → pseudo-signature</text>
  <line x1="218" y1="190" x2="530" y2="190" stroke="#1e293b"/>
  <text x="218" y="212" fill="#22d3ee" font-size="10.5">target id, host ABI and viewport reach the C as</text>
  <text x="218" y="228" fill="#22d3ee" font-size="10.5">-D defines from the resolved plan — the .c files</text>
  <text x="218" y="244" fill="#22d3ee" font-size="10.5">#error out if they are missing.</text>
  <text x="218" y="266" fill="#64748b" font-size="10.5">Rust target dir cached outside the repo</text>
  <path d="M544 100 L564 100" stroke="#475569" stroke-width="1.5"/>
  <path d="M564 100 l-8 -5 M564 100 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="570" y="14" width="176" height="140" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.4"/>
  <text x="582" y="36" fill="#f1f5f9" font-size="12" font-weight="700">PocketJSDemo.app</text>
  <text x="582" y="58" fill="#22d3ee" font-size="10.5">PocketJSDemo · arm_v6</text>
  <text x="582" y="76" fill="#94a3b8" font-size="10.5">Info.plist · PkgInfo</text>
  <text x="582" y="94" fill="#94a3b8" font-size="10.5">Icon.png · 59×60 RGBA</text>
  <text x="582" y="116" fill="#94a3b8" font-size="10.5">build-receipt.json —</text>
  <text x="582" y="132" fill="#94a3b8" font-size="10.5">all input hashes + id</text>
  <rect x="570" y="166" width="176" height="110" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="582" y="188" fill="#f1f5f9" font-size="12" font-weight="700">verified after link</text>
  <text x="582" y="210" fill="#94a3b8" font-size="10.5">file → Mach-O arm_v6</text>
  <text x="582" y="228" fill="#94a3b8" font-size="10.5">otool-classic -L → the</text>
  <text x="582" y="244" fill="#94a3b8" font-size="10.5">exact 6 install names</text>
  <text x="582" y="266" fill="#94a3b8" font-size="10.5">plutil -lint the plist</text>
</svg>

A successful build proves the compiler, the linker and the packager. It proves **nothing** about the phone. Keeping those two claims apart turned out to be the most load-bearing decision in the port, and Constraint 5 is where it pays off.

## Constraint 2: the linker cannot read its own compiler's Objective-C

A UIKit application needs at least two classes: a view that draws and an application delegate. The obvious way to write them is Objective-C, and that is where the toolchain stops.

Modern Clang, asked for ARMv6 with a 1.1.4 deployment target, will happily compile an `@implementation`. `ld-classic` then **crashes** translating the ObjC1 class-reference relocations Clang emitted for it. Not a diagnostic — a crash. The old ABI and the new compiler's metadata are far enough apart that the compatibility path inside the classic linker gives up.

There is no flag for this. There is, however, a way to need zero Objective-C metadata in the object file at all, and the API for it is already in the phone's own runtime. The `libobjc.A.dylib` in the sysroot is dated **11 February 2008**, and among its 185 exported symbols are `_objc_allocateClassPair`, `_objc_registerClassPair`, `_class_addMethod` and `_objc_msgSend_stret`. So the host declares them `extern` and builds its classes at startup:

```c
static Class register_view_class(void) {
  Class cls = objc_allocateClassPair(objc_getClass("UIView"), "PocketJSRuntimeView", 0);
  BOOL methods_added =
    class_addMethod(cls, sel_registerName("drawRect:"),
      (void (*)(void))pocket_draw_rect,
      "v@:{CGRect={CGPoint=ff}{CGSize=ff}}") &&
    class_addMethod(cls, sel_registerName("touchesBegan:withEvent:"),
      (void (*)(void))pocket_touches_began, "v@:@@") &&
    /* … touchesMoved/Ended/Cancelled, the 1.x mouse* path, and the tick … */
    class_addMethod(cls, sel_registerName("pocketJSTick:"),
      (void (*)(void))pocket_tick, "v@:@");
  if (!methods_added) return NULL;
  objc_registerClassPair(cls);
  return cls;
}
```

Two classes, registered at startup, from a translation unit the classic linker sees as ordinary C. `UIApplicationMain` is then handed the class *names* as strings and never knows the difference.

The costs are real but bounded. You write the type encodings yourself — `"v@:{CGRect={CGPoint=ff}{CGSize=ff}}"` is `-(void)drawRect:(CGRect)` spelled out for the runtime — and every message send is an explicit cast of `objc_msgSend`:

```c
static id send_id_rect(id receiver, const char *selector, CGRect rect) {
  return ((id (*)(id, SEL, CGRect))objc_msgSend)(receiver, sel_registerName(selector), rect);
}
```

**The trap is struct returns.** On ARMv6, a method returning a `CGRect` does not use the same calling convention as one returning an `id`; it uses the struct-return variant, where the caller passes a hidden pointer to the result. Send `bounds` through plain `objc_msgSend` and you get a plausible-looking rectangle full of garbage — no crash, no warning, and a layout that is quietly wrong forever. Geometry therefore goes through its own helper:

```c
static CGRect send_rect(id receiver, const char *selector) {
  CGRect rect;
  ((void (*)(CGRect *, id, SEL))objc_msgSend_stret)(&rect, receiver, sel_registerName(selector));
  return rect;
}
```

None of this is clever; it is the shape the constraint forces. But the shape is worth knowing exists: **you can write a complete UIKit application in C, with no Objective-C compiler involved anywhere, and a 2008 runtime supports it.**

## Constraint 3: one executable, two incompatible UIKits

Linking low and running high means the two UIKits disagree about nearly every lifecycle detail. The host therefore asks before it acts — `respondsToSelector:` for methods, `dlsym` for functions:

<svg viewBox="0 0 760 288" width="100%" role="img" aria-label="Table of six UIKit differences the host resolves at runtime. Status bar: iPhone OS 1.x uses UIHardware underscore setStatusBarHeight zero plus setStatusBarMode colon orientation colon duration colon fenceID colon, while 3.1.3 uses setStatusBarHidden colon. Window creation: 1.x uses initWithContentRect colon, 3.1.3 uses initWithFrame colon. View attachment: 1.x uses setContentView colon then orderFront colon, makeKey colon and underscore setHidden colon; 3.1.3 uses addSubview colon then makeKeyAndVisible. Graphics context: 1.x exports UICurrentContext, 3.1.3 exports UIGraphicsGetCurrentContext. Touch: 1.x delivers GSEvents through mouseDown, mouseDragged and mouseUp; 3.1.3 delivers UITouch objects through touchesBegan withEvent. Launch callback: 1.x calls applicationDidFinishLaunching colon, 3.1.3 calls application colon didFinishLaunchingWithOptions colon. Methods are probed with respondsToSelector and functions with dlsym, which is also why the 3.1.3 binary carries no load command for GraphicsServices." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">CONCERN</text>
  <text x="150" y="20" fill="#64748b" font-size="11">iPHONE OS 1.x — THE LINKED ABI</text>
  <text x="466" y="20" fill="#64748b" font-size="11">3.1.3 — THE RUNNING OS</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="10.5">
    <text x="14" y="50" fill="#e2e8f0">status bar</text>
    <text x="150" y="50" fill="#94a3b8">UIHardware _setStatusBarHeight: 0</text>
    <text x="150" y="66" fill="#94a3b8">+ setStatusBarMode:orientation:duration:fenceID:</text>
    <text x="466" y="50" fill="#38bdf8">setStatusBarHidden:</text>
    <text x="14" y="92" fill="#e2e8f0">window</text>
    <text x="150" y="92" fill="#94a3b8">initWithContentRect:</text>
    <text x="466" y="92" fill="#38bdf8">initWithFrame:</text>
    <text x="14" y="118" fill="#e2e8f0">attach view</text>
    <text x="150" y="118" fill="#94a3b8">setContentView:</text>
    <text x="150" y="134" fill="#94a3b8">then orderFront: · makeKey: · _setHidden:</text>
    <text x="466" y="118" fill="#38bdf8">addSubview:</text>
    <text x="466" y="134" fill="#38bdf8">then makeKeyAndVisible</text>
    <text x="14" y="160" fill="#e2e8f0">draw context</text>
    <text x="150" y="160" fill="#94a3b8">UICurrentContext()</text>
    <text x="466" y="160" fill="#38bdf8">UIGraphicsGetCurrentContext()</text>
    <text x="14" y="184" fill="#e2e8f0">touch</text>
    <text x="150" y="184" fill="#94a3b8">GSEvent via mouseDown:/Dragged:/Up:</text>
    <text x="466" y="184" fill="#38bdf8">UITouch via touchesBegan:withEvent:</text>
    <text x="14" y="208" fill="#e2e8f0">launch</text>
    <text x="150" y="208" fill="#94a3b8">applicationDidFinishLaunching:</text>
    <text x="466" y="208" fill="#38bdf8">application:didFinishLaunchingWithOptions:</text>
  </g>
  <line x1="14" y1="226" x2="746" y2="226" stroke="#1e293b"/>
  <text x="14" y="248" fill="#94a3b8" font-size="11">Methods are probed with respondsToSelector:, functions with dlsym against RTLD_DEFAULT.</text>
  <text x="14" y="266" fill="#22d3ee" font-size="11">That is also why the 3.1.3 binary carries no load command for GraphicsServices —</text>
  <text x="14" y="282" fill="#22d3ee" font-size="11">an install name that moved out of the public Frameworks directory after 1.x.</text>
</svg>

That last line is the non-obvious one, and it is the trap that makes the whole "link low" strategy nearly not work. The 1.x touch path needs `GSEventGetLocationInWindow`, which lived in a public `GraphicsServices.framework` in 1.1.4 and does not in 3.1.3. Declare it `extern`, let the linker record the dependency, and you get a binary that links perfectly on your Mac and is **rejected by dyld on the phone** — because the executable now demands a library that is no longer there. Resolving it through `dlsym` instead keeps the older path available without putting the obsolete install name in the load commands, so the same executable that would use GSEvents on a 1.x device loads cleanly on a 3.x one. A test asserts the `extern` declaration is absent, because that is exactly the kind of line a well-meaning cleanup puts back.

The status bar is the other difference with a visible consequence: 1.1.4 reserves 20 pixels for it and hands you a 320×460 content rect unless you take it away, while 3.1.3 has `setStatusBarHidden:`. The app owns all 320×480 either way — and the C never hardcodes those numbers, because `POCKET_LOGICAL_WIDTH` and `POCKET_LOGICAL_HEIGHT` arrive as `-D` defines derived from the resolved build plan, with an `#error` if they are missing.

## Constraint 4: the GPU predates shaders

The core is a `no_std` Rust crate. It can rasterize the retained UI tree into packed ARGB32 on the CPU, or walk its DrawList into a GPU. Getting either onto this target needed a custom target JSON, because Rust has never heard of `armv6-apple-ios`:

```json
{
  "llvm-target": "armv6-apple-ios",
  "cpu": "arm1176jzf-s",
  "features": "+v6,+soft-float,+vfp2,-neon,+strict-align",
  "binary-format": "mach-o",
  "archive-format": "darwin",
  "panic-strategy": "abort",
  "is-like-darwin": true
}
```

plus a pinned nightly and `-Z build-std=core,alloc,compiler_builtins`, since no prebuilt `core` exists for a target that does not exist.

**The crate we reused is the Symbian one.** `engine/symbian` already had exactly the right shape — `no_std`, a global allocator forwarding to C `malloc`, `abort` on panic, a flat `extern "C"` surface. Its switch for all of that was `cfg(target_os = "none")`, and this target's `target_os` is `ios`. So it gained a `bare-platform` Cargo feature and every one of those attributes became `any(target_os = "none", feature = "bare-platform")`. That is the ordinary lesson about target checks: **the first consumer writes a `cfg`, the second consumer turns it into a feature**, and only then do you find out which conditions were about "bare metal" and which were about Symbian.

We then hit the identical trap a second time, in the same file, and it is worth naming because it fails silently. Eight more `#[cfg(target_os = "none")]` gates guarded the *GL* entry points, plus three fallback arms that returned zero for everyone else. The build succeeded, the archive linked, and `nm` showed no GL symbols at all, because the whole GL module had been compiled out of existence for a target whose `target_os` is `ios`. A `cfg` that names one platform is a bug with a delay on it.

### The shaders were fixed-function all along

The interesting part of writing an ES 1.1 backend is discovering how little of it is new. Here is the entire ES 2 pipeline PocketJS used on Symbian:

```glsl
// vertex
vec2 ndc = vec2(a_position.x * 2.0 / u_viewport.x - 1.0,
                1.0 - a_position.y * 2.0 / u_viewport.y);
gl_Position = vec4(ndc, 0.0, 1.0);
// fragment
gl_FragColor = texture2D(u_texture, v_uv) * v_color;
```

Both lines have exact fixed-function equivalents, and they are one-liners:

- The vertex transform — pixel coordinates to NDC, including the Y flip that puts the origin at the top left — is `glOrthof(0, w, h, 0, -1, 1)` on the projection matrix. Left, right, bottom, top, in that order.
- `texture2D(...) * v_color` is `GL_MODULATE`, the *default* texture environment, over a per-vertex color array.
- The three shader attributes become `glVertexPointer` / `glTexCoordPointer` / `glColorPointer` reading the **same interleaved buffer at the same offsets** — 0, 8, 16, stride 20. The vertex struct did not change by a byte.

So the port was not a rewrite. `gles2.rs` became `gl/mod.rs` — the DrawList walk, the image and font-atlas caches, batching by texture and scissor, the physical clip arithmetic, all generation-independent — plus `gl/es2.rs` and `gl/es1.rs` holding the ~90 lines that actually differ. Both satisfy one six-method interface, one is compiled in, and the ten existing unit tests pass on either.

One real capability gap: MBX Lite has no `GL_OES_blend_func_separate`, so the ES 1.1 path cannot give destination alpha its own blend factors the way the ES 2 path does. It does not matter here, because the drawable is opaque and nothing ever reads its alpha back — but that is an argument, not an assumption, and it belongs in a comment next to the `glBlendFunc` call.

### Getting a drawable without linking QuartzCore

The 2008 `OpenGLES.framework` has the core ES 1.1 entry points and **not** the two things you need to put them on screen: no EAGL, no `GL_OES_framebuffer_object`. Both exist on 3.1.3.

This is the GraphicsServices lesson again, and this time it is load-bearing in the other direction. `EAGLContext` and `CAEAGLLayer` are fetched with `objc_getClass`, and all nine framebuffer-object functions with `dlsym` — which is not a workaround but the only correct option, since a link-time reference to any of them would produce a binary dyld rejects. The build now fails if one ever becomes a link-time reference, next to the check that does the same for GraphicsServices.

The piece that makes UIKit hand over a GL-capable layer is a class method:

```c
/* +layerClass, added to the metaclass before the pair is registered. */
static Class pocket_layer_class(id self, SEL command) {
  return objc_getClass("CAEAGLLayer");
}
```

It is only added when that class exists, so on iPhone OS 1.x the view stays an ordinary software-drawn `UIView` and nothing else has to know. Then `renderbufferStorage:fromDrawable:` on the layer, `glFramebufferRenderbufferOES` to attach it, and `presentRenderbuffer:` to swap.

Two symbols were missing, and both are the kind you meet at link time:

- **`clock_gettime`** postdates this libc. QuickJS references it only for `Atomics`, so it forwards to `gettimeofday`.
- **`memset_pattern16`** is a Darwin-specific libc entry point LLVM emits as an optimization for the Rust core, and which this libc does not have.

Together they are `compat.c`, **23 lines including the includes.** That is the entire platform shim.

**The guest ships inside the executable as Mach-O sections.** `-sectcreate __DATA __pocket_js` and `-sectcreate __DATA __pocket_pak` embed the compiled JavaScript (118 KB) and the asset pack (465 KB); the host reads them back with `getsectdata` at boot. No file I/O, no bundle resource lookup, and nothing that can drift out of sync with the executable — the guest and the native code are literally the same file, which is also why one build identifier can cover all of it.

### What one tick does

The loop runs off `CADisplayLink`, which arrived in iPhone OS 3.1 and fires with the display instead of approximately near it. It is resolved by name, with `NSTimer` at 1/60 s as the fallback for anything older, and the run-loop mode string is built with `stringWithUTF8String:` rather than linked, because `NSDefaultRunLoopMode` is a Foundation constant symbol and this is one more install name we do not want in the load commands.

On the first tick the host boots QuickJS — five translation units compiled for ARMv6, a 256 KB max stack, the pak handed in as an `ArrayBuffer`, `__simHz` set to 60 — evaluates the embedded bundle, and grabs `globalThis.frame`. Every tick after that calls `frame()` with the current touch state, ticks the core, and then either submits a DrawList to GL and presents, or takes a framebuffer pointer and schedules `drawRect:`.

Two details on the software path are easy to get wrong in ways that *almost* look right:

**Byte order.** The core exposes ARGB32 *words*. On little-endian ARMv6 those words are `B,G,R,A` bytes in memory, so the image is created with `kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little`. Get it wrong and you get a red/blue swap that no automated check notices. (The GPU path sidesteps this entirely: MBX Lite advertises `GL_IMG_texture_format_BGRA8888`, so those words upload with no swizzle at all.)

**Orientation.** `CGImage` rows are top-down; the 1.x Quartz draw context is y-up. The draw flips the CTM rather than flipping pixels, so the rasterizer never learns the platform has an opinion.

Because `__simHz` is 60, PocketJS's [virtual clock](/blog/ui-runtime-that-cant-flake/) advances at the rate frames actually arrive, and the demo reports the rate it really has rather than one inherited from a handheld. Which is the entire iPhone application:

```tsx
import Hero from "../hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

export default function IPhone2GHero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on a 2007 touchscreen."
      headline="JSX on ARMv6."
      onAction={(count) => reportAppAction("hero_tap", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + UIKIT"
    />
  );
}
```

That is the *shared* Hero component — the same file the PSP, the Vita and the E7 render — with four props and one receipt hook.

## Installing it is a transaction, not a copy

`scp` would work. It would also, on any interrupted transfer, leave a half-written application bundle in `/Applications` with no way to tell it from a good one.

So deployment has a device side: a small signed ARMv6 helper at `/usr/libexec/pocketjs-device`, built by the same toolchain as the app, that installs in two phases. Upload into a staging directory, read every file back and compare bytes, move any existing bundle aside, commit, clear the marker. The marker lives on the always-writable data volume and records the phase, whether a previous version existed, and the transaction id — so an interruption is a recoverable state rather than a mystery. The package carries its own magic (`PJS2G003`) and a five-file allowlist with per-file size and mode limits, and the helper **refuses to delete a directory it cannot prove belongs to us** — the check that caught a leftover bundle from an earlier experiment instead of silently eating it.

That is the second and last place the jailbreak matters: it provides the `sshd` we reach over USB. The bootstrap's job is to make that channel *ours* without breaking it, which is the interesting part, because the failure mode is losing your only way in. The device's existing `sshd`, host key and launchd plist are **preserved** — their hashes are asserted identical before and after, not assumed. A dedicated client key is merged in. Password authentication is disabled *only after* key authentication and the helper both verify, and anything else rolls back. Those three hashes still matched after a cold restart, which is the only interesting time to check.

## The receipt that measured the wrong thing

Here is what the phone reported after the first successful end-to-end run:

```text
build_id=ba1c0b15af4fdb72c6a98334332a8954
state=running
guest_frames=118
touch_sequences=11
last_touch_hit=46
error=
```

A build matching the local bundle, a running guest, 118 frames, 11 touch sequences, a hit. It reads like proof. A review pass took it apart, and these two findings are the part of this port I would most want to hand to someone else.

**`last_touch_hit` was a geometry fact wearing an application fact's clothes.** It was computed at touch-*down*, against any layout bounds under the finger, and the validator accepted records with `touch_down=1` still set. So a passing record could be written before the finger lifted, before `onPress` fired, and before the Solid signal changed. Every number in it was true. None of it supported the claim we were making with it.

**A `state=running` file outlives the process that wrote it.** There was no PID, no timestamp, no heartbeat. If the app crashed or was `SIGKILL`ed, the termination callback never ran, the file stayed exactly as it was, and the next status check happily re-read a success record written by a process that no longer existed.

The hardened protocol requires four things at once, and it is schema-versioned so older records are rejected rather than reinterpreted:

<svg viewBox="0 0 760 216" width="100%" role="img" aria-label="Diagram of the schema-2 acceptance record. Four requirements must all hold: the recorded PID is still alive on the phone; the heartbeat advanced between two reads; a touch sequence completed, meaning the finger came off; and the application reported a changed action value. Below, a chain shows what the fourth requirement implies end to end: QuickJS ran the guest, the core laid out and rasterized it, UIKit delivered a real finger, the framework routed onPress, Solid's effect fired, and the host wrote hero_tap into the record." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">A SCHEMA-2 RECORD IS ACCEPTED ONLY IF ALL FOUR HOLD</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="11.5">
    <text x="14" y="52" fill="#38bdf8">pid</text><text x="120" y="52" fill="#e2e8f0">the recorded process is still alive on the phone</text>
    <text x="14" y="76" fill="#38bdf8">heartbeat</text><text x="120" y="76" fill="#e2e8f0">it advanced between two reads — the loop is still turning</text>
    <text x="14" y="100" fill="#38bdf8">release</text><text x="120" y="100" fill="#e2e8f0">a touch sequence <tspan fill="#22d3ee">completed</tspan> — the finger came off</text>
    <text x="14" y="124" fill="#38bdf8">hero_tap</text><text x="120" y="124" fill="#e2e8f0">the application reported a changed action value</text>
  </g>
  <line x1="14" y1="140" x2="746" y2="140" stroke="#1e293b"/>
  <text x="14" y="162" fill="#94a3b8" font-size="11">The fourth one is the whole gate, because nothing else can produce it:</text>
  <text x="14" y="186" fill="#e2e8f0" font-size="11">QuickJS ran the guest → the core laid out and rasterized it → UIKit delivered a real finger →</text>
  <text x="14" y="204" fill="#e2e8f0" font-size="11">the framework routed onPress → Solid's effect fired → the host wrote <tspan fill="#22d3ee">hero_tap</tspan> into the record.</text>
</svg>

That last requirement needed one new piece of framework surface, and it is deliberately small:

```ts
export function reportAppAction(name: string, value: number): void {
  /* validate the name and the int32 range, then: */
  getOps().__reportAppAction?.(name, value);
}
```

The sink is optional and double-underscored on purpose: it is diagnostic evidence rather than an input mechanism, it sits outside the portable operation ABI, and on every host with no receipt collector it is a no-op. The application calls it from a `createEffect` on the count. **The evidence path runs through the reactive graph, which is the only way a receipt can testify about reactivity.**

Three further findings from the same review are worth listing because none of them are exotic:

- **Two sources of truth for a cross-layer contract.** The guest read its target id and host ABI from the resolved build plan; the native host had them hardcoded. A legitimate ABI bump would have produced a clean local build, a clean link, and a mismatch that only appears when the phone launches the app. Both sides now come from the plan, and the `.c` files refuse to compile without the defines.
- **A synchronous write per frame while a finger is down.** The status record was rewritten on every tick that delivered a touch — roughly 30 `open`/`write`/`fsync`/`rename` per second on 2007 flash during any drag. It is now edge-triggered plus a heartbeat every 30 frames.
- **Four new test files that were not in CI.** `bun run test` runs the files enumerated in `tools/test.ts`, and the release workflow calls exactly that. The iPhone tests existed, passed locally, and were invisible to a green build. A test that is not in the runner's list is not a test.

## And then the GPU lost

With the ES 1.1 backend running, the obvious thing to do is claim a win. Instead, two fields went into the record first, for exactly the reason the previous section is about:

```text
renderer=gles1
clock=displaylink
```

**Both are recorded, not inferred.** A GL failure falls back to the software rasterizer silently and by design, which means a hardware receipt and a software one are otherwise byte-identical — "it runs on the GPU" would have been an assumption wearing a receipt's clothes. The same applies to the clock: `NSTimer` and `CADisplayLink` produce identical-looking frame counts.

Then three timers, and one more thing that mattered more than any of them: **a marker file on the device that forces the software path.** Both renderers are measured from *one* binary, so the comparison cannot be contaminated by anything else that differs between two builds.

<svg viewBox="0 0 760 290" width="100%" role="img" aria-label="Benchmark comparing the two render paths on the same binary. The software rasterizer spends 1.13 milliseconds in JavaScript plus core and 5.5 to 6.1 milliseconds drawing, totalling about 6.6 milliseconds and leaving 10 milliseconds of headroom in a 16.67 millisecond frame. The OpenGL ES 1.1 path spends 2.1 milliseconds in JavaScript plus core and 12.4 to 15.5 milliseconds submitting to the GPU, plus a 1.7 millisecond vsync wait, totalling about 17.6 milliseconds and exceeding the frame budget. The CPU path is roughly 2.4 times faster at the draw stage." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE BINARY · ONE DISPLAY LINK · SCREEN ON · MEAN µs PER FRAME</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <text x="14" y="52" fill="#64748b" font-size="11">PATH</text>
  <text x="190" y="52" fill="#64748b" font-size="11">JS + CORE</text>
  <text x="330" y="52" fill="#64748b" font-size="11">DRAW</text>
  <text x="500" y="52" fill="#64748b" font-size="11">TOTAL</text>
  <text x="628" y="52" fill="#64748b" font-size="11">OF 16.67 ms</text>
  <rect x="8" y="62" width="738" height="30" rx="7" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.2"/>
  <text x="14" y="82" fill="#f1f5f9" font-size="12" font-weight="700">software raster</text>
  <text x="190" y="82" fill="#22d3ee" font-size="12">1.13 ms</text>
  <text x="330" y="82" fill="#22d3ee" font-size="12">5.5 – 6.1 ms</text>
  <text x="500" y="82" fill="#22d3ee" font-size="12">~6.6 ms</text>
  <text x="628" y="82" fill="#22d3ee" font-size="12">10 ms spare</text>
  <text x="14" y="116" fill="#e2e8f0" font-size="12" font-weight="700">OpenGL ES 1.1</text>
  <text x="190" y="116" fill="#94a3b8" font-size="12">2.10 ms</text>
  <text x="330" y="116" fill="#eab308" font-size="12">12.4 – 15.5 ms</text>
  <text x="500" y="116" fill="#eab308" font-size="12">~17.6 ms</text>
  <text x="628" y="116" fill="#eab308" font-size="12">over budget</text>
  <line x1="14" y1="134" x2="746" y2="134" stroke="#1e293b"/>
  <text x="14" y="156" fill="#e2e8f0" font-size="11">The draw stage is ~2.4× slower on the GPU. The vsync block inside presentRenderbuffer: is only ~1.7 ms,</text>
  <text x="14" y="174" fill="#e2e8f0" font-size="11">so that 15.5 ms is the MBX Lite actually working, not the loop waiting for the display.</text>
  <text x="14" y="200" fill="#64748b" font-size="11">Both paths measured 56–57 frames per second. Only one of them has the budget to hold 60.</text>
  <line x1="14" y1="216" x2="746" y2="216" stroke="#1e293b"/>
  <text x="14" y="238" fill="#38bdf8" font-size="11">WHY: the software path calls ui_render_incremental() and is damage-tracked — it redraws what changed.</text>
  <text x="14" y="256" fill="#38bdf8" font-size="11">The GL path re-submits and re-fills the ENTIRE DrawList every frame, and this screen is mostly large</text>
  <text x="14" y="274" fill="#38bdf8" font-size="11">alpha-blended gradient, which is the one thing a 2007 tile GPU is worst at.</text>
</svg>

The measurement that made this legible was splitting the GL timer in two. Lumped together, "present" was 14–16 ms and could plausibly have been the loop politely waiting for vsync. Timed separately, submitting the DrawList is 12.4–15.5 ms and the `presentRenderbuffer:` block is only ~1.7 ms. **The GPU is not waiting. It is working, slowly.**

And the reason is not really about the GPU. The software rasterizer goes through `ui_render_incremental()`, which is damage-tracked: it touches the pixels that changed. The GL path re-submits the whole DrawList and lets the hardware re-fill every pixel of a full-screen gradient, sixty times a second. We replaced an incremental renderer with a complete one and then measured the hardware, when the thing that changed was the algorithm.

So the honest state is: the fixed-function backend exists, it is correct, it is display-synced, and it is a **regression** for this UI. The fix is not a faster GPU path, it is a damage-aware one — scissor each frame to the rectangle the core already tracks — and because `gl/mod.rs` is shared with the hardware-verified Symbian ES 2 renderer, that is a decision about the shared backend rather than a patch to the iPhone.

Two smaller things fell out of the same work, both of them measurement bugs rather than code bugs:

- **`CADisplayLink` stops when the display sleeps.** To a heartbeat check that is indistinguishable from a hung application, and `NSTimer` did not behave that way. The acceptance protocol from the previous section has a new blind spot to close.
- **`ps ax` prints nothing on this OS.** So `ps ax | grep -c` reported the app dead while `kill -0` on the same PID reported it alive. That is the third time in this project that a check keyed on the wrong signal — after the `extern` that would have named a moved framework, and the receipt that measured geometry.

## The icon, which took four tries

<p style="display:inline-block;background:#4b5563;padding:14px;border-radius:14px">
  <img width="236" height="240" src="/assets/blog/iphone2g-icon-4x.png" alt="The PocketJS SpringBoard icon at 4x: a black enamel rounded square with a bright chrome bevel, a curved glass highlight across the top half, and the silver PocketJS mark centered" />
</p>

<p class="text-sm text-slate-500">The shipped <code>Icon.png</code> at 4× nearest-neighbour, on a neutral plate so the transparent corners read. It is 59×60, and a test pins its SHA-256 plus the alpha at all four corners and four specific interior pixels.</p>

A 59×60 PNG does not usually earn a section. This one does, because it was wrong three times in three different ways, and each was a category error rather than a taste disagreement:

1. **The demo's in-app logo** — a player mark that belongs to the Hero screen's header, not an application identity.
2. **The white-plate brand asset** — correct in a README, a white square on a phone home screen.
3. **The black-plate brand asset** — correct on this website, and functionally invisible against the black home-screen wallpaper it was about to sit on.

The fourth version is the one above: black enamel, a bright chrome bevel that gives it an outline against the wallpaper, a curved glass highlight in the 2007 idiom, transparent rounded corners. It is *pre-baked* — generated once, then deterministically scaled and cropped — with pixel-level assertions so the next well-meaning asset sweep cannot quietly replace it. The audit that followed found the same mistake one more place: the site's own `favicon.svg` was transparent, so it rendered as the white-plate version on every light background. Fixed at the source.

## What the port cost

<svg viewBox="0 0 760 288" width="100%" role="img" aria-label="Summary of the iPhone port. Commit 11245e0, the ARMv6 host, toolchain, demo and runbook, plus 6319 lines. Commit 8a61b11, the 3.1.3 device workflow with signing and key-only SSH, plus 1549. Commit 1ab8d74, recording the first live runtime receipt, plus 79. Commit 655a8a3, the shared Hero on the phone plus a tilt input, plus 846. Commit 0198a98, baking the classic icon and removing the tilt input again, plus 115. Then the review pass, hardening the bootstrap, the acceptance protocol, the single source of truth and CI, plus 1202. Then the GL work: splitting the shared backend into a generation-independent DrawList walker plus an ES 2 and an ES 1.1 pipeline, the EAGL drawable, CADisplayLink, and the benchmark instrumentation. Total roughly 8600 lines added in one draft pull request, with the production target registry unchanged, zero pixel goldens updated and zero Hero tape hashes changed." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE WHOLE PORT · ONE DRAFT PR</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="11.5">
    <text x="14" y="52" fill="#38bdf8">11245e0</text><text x="110" y="52" fill="#e2e8f0">ARMv6 UIKit host · toolchain · demo · runbook</text><text x="700" y="52" fill="#94a3b8" text-anchor="end">+6,319</text>
    <text x="14" y="76" fill="#38bdf8">8a61b11</text><text x="110" y="76" fill="#e2e8f0">3.1.3 device workflow · signing · key-only SSH</text><text x="700" y="76" fill="#94a3b8" text-anchor="end">+1,549</text>
    <text x="14" y="100" fill="#38bdf8">1ab8d74</text><text x="110" y="100" fill="#e2e8f0">record the first live runtime receipt</text><text x="700" y="100" fill="#94a3b8" text-anchor="end">+79</text>
    <text x="14" y="124" fill="#38bdf8">655a8a3</text><text x="110" y="124" fill="#e2e8f0">the shared Hero on the phone · <tspan fill="#eab308">a tilt input</tspan></text><text x="700" y="124" fill="#94a3b8" text-anchor="end">+846</text>
    <text x="14" y="148" fill="#38bdf8">0198a98</text><text x="110" y="148" fill="#e2e8f0">bake the classic icon · <tspan fill="#eab308">remove the tilt input again</tspan></text><text x="700" y="148" fill="#94a3b8" text-anchor="end">+115</text>
    <text x="14" y="172" fill="#a78bfa">review pass</text><text x="110" y="172" fill="#e2e8f0">bootstrap safety · acceptance protocol · one source of truth · CI</text><text x="700" y="172" fill="#94a3b8" text-anchor="end">+1,202</text>
    <text x="14" y="196" fill="#a78bfa">GL work</text><text x="110" y="196" fill="#e2e8f0">gl/{mod,es1,es2}.rs · EAGL drawable · CADisplayLink · <tspan fill="#22d3ee">benchmark</tspan></text><text x="700" y="196" fill="#94a3b8" text-anchor="end">shared</text>
  </g>
  <line x1="14" y1="212" x2="746" y2="212" stroke="#1e293b"/>
  <text x="14" y="234" fill="#22d3ee" font-size="11">≈8,600 lines · one draft PR · production target registry unchanged</text>
  <text x="14" y="252" fill="#22d3ee" font-size="11">pixel goldens updated: 0 · Hero tape hashes changed: 0 · GL backend tests passing on both pipelines: 10/10</text>
  <text x="14" y="274" fill="#64748b" font-size="11">Framework additions: one optional receipt sink and one core export. The rest is a host and a toolchain.</text>
</svg>

The two yellow rows are a feature that shipped and then was deleted. The accelerometer went in as a hardware-neutral `input.tilt` capability — a fifth frame argument, a DevTools tape version, a contract entry, `UIAccelerometer` on the device — and on the Hero screen it moved the headline a few pixels. It was decorative, so it came out completely: the public API, the frame argument, the tape version, the native code, the acceptance field. Adding an input capability to a portable frame contract is cheap to write and expensive to keep, and "it works on the device" is not the same as "it has earned a place in the contract."

What did not move is the argument. The 54 committed pixel goldens and the 180-frame Hero tape hashes are byte-identical, the framework gained no platform check, and `POCKET_TARGETS` gained no entry — there is a test asserting that `iphone2g-dev` stays out of it.

## The honest boundary

This is **not** a production PocketJS target, and the pull request is still a draft.

- The build profile lives in `tools/`, deliberately outside the production registry, and stays there until it earns its way out.
- Everything is verified on **one** device, one build: `iPhone1,1` running iPhone OS 3.1.3. There are no iPhone pixel goldens.
- The linker-ABI, packaging and deployment layers all have receipts. The runtime layer has real device receipts — hundreds of frames, dozens of touch sequences, across a cold restart — recorded under the *old* protocol. The hardened gate is in the code and the docs; **re-running it on the phone is what the draft still owes**, and until it does, the runbook labels the existing receipt historical instead of promoting it.
- **The GPU path is a measured regression and its default is unresolved.** The host currently prefers GL when it can get a context; the numbers above say it should not until the DrawList submission is damage-aware. Both paths ship, and a marker file on the device selects between them.
- The frame rate is **56–57 fps measured, not a locked 60.** The software path has the budget for 60 and does not consistently deliver it; where the remaining few frames go is not yet accounted for, and saying "60" before that is understood would be exactly the kind of claim this post is about.
- To reproduce any of this you need a jailbroken `iPhone1,1` on 3.1.3, because the host relies on an `ldid` pseudo-signature being accepted and on SSH over USB. Getting a device into that state is out of scope here and there is no repository command for it.
- No firmware, system file or extracted sysroot is in the repository. You supply your own copies of the historical inputs under their original terms; the toolchain verifies their hashes and does the rest.

## Why bother

There is no market here. Nobody is shipping an app for a 2007 iPhone, and this port will never have users.

It is a test, and it tests something the other targets cannot. The PSP, the Vita and the ESP32 are machines you own outright: you boot your own code and negotiate with nothing. [Symbian](/blog/pocketjs-on-symbian/) was the first target with an operating system that owns the screen and the scheduler and expects to be asked. The iPhone is the first that owns **identity** — a bundle, a signature, an installer, a home screen, a launch protocol — and the first where the fastest way to reach the panel turned out to be the one that does not use the GPU at all.

The runtime went onto it without a fork. What changed was a toolchain, a host, one optional diagnostic sink, and a GL backend that now serves two generations instead of one; what did not change was the core, the framework, the goldens and the target registry — the same parts that did not change for Symbian and for the Vita. That is the whole claim, and it is the only reason to keep collecting machines this strange.

The four constraints were, in the end, just work: read the linker's mind, stop emitting Objective-C, ask before you send, replace two lines of GLSL with a matrix and a texture environment. Neither of the two things that nearly shipped wrong was in that list.

The first was a status file with five true numbers in it that did not add up to the sentence we were putting underneath them. The second was a GPU backend that was correct, that worked, that we would have called an upgrade — and that a marker file and three timers showed to be 2.4× slower than the code it replaced, for a reason that had nothing to do with the GPU and everything to do with having quietly swapped an incremental renderer for a complete one.

Those are the same mistake twice. **A measurement can be completely accurate and still not be evidence for your claim**, and a change can be entirely correct and still be a regression. On hardware you can only touch one device at a time, the cheapest thing you can build is the switch that lets you measure both sides of your own assumption.

---

*PocketJS is open source at [pocket-stack/pocketjs](https://github.com/pocket-stack/pocketjs). The iPhone workflow and its acceptance layers are documented in [`docs/IPHONE2G.md`](https://github.com/pocket-stack/pocketjs/blob/main/docs/IPHONE2G.md); the port is draft PR [#219](https://github.com/pocket-stack/pocketjs/pull/219). The C runtime startup is Apple's [Csu](https://github.com/apple-oss-distributions/Csu), and the historical map of this toolchain territory is still [saurik's](https://www.saurik.com/toolchain.html).*
