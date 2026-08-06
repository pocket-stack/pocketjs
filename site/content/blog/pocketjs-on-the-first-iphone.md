<img class="rounded-xl border border-line" width="320" src="/assets/blog/iphone2g-hero-320.png" alt="The PocketJS Hero demo at 320 by 480: a PocketJS header with FPS, NODES and DRAWS counters reading 30, 42 and 9, the headline 'JSX on ARMv6.', a gradient underline, body text reading 'Flexbox, springs and baked type — running on a 2007 touchscreen', a blue 'Tap Hero' button, 'Count: 5', and the line 'Reactive on real hardware.'" />

<p class="text-sm text-slate-500 -mt-4">The Hero demo at the original iPhone's native 320×480, after five taps. This frame is the real iPhone guest bundle — resolved against the <code>iphone2g-dev</code> build profile, booted at the device's exact viewport, rasterized by the same wasm core our byte-exact pixel goldens run on. The <code>30</code> in the corner is the presentation rate the app is told it has.</p>

Xcode 26.6 still compiles ARMv6. Its `ld-classic` still links against a 2008 `UIKit`. What the current toolchain will *not* do is hand its own Objective-C output to a loader from 2008 — so the host that puts [PocketJS](/blog/introducing-pocketjs/) on the original iPhone contains no Objective-C at all. It is C, and it registers its `UIView` and app delegate through `objc_allocateClassPair` at runtime.

If you have not met PocketJS: it runs real [Solid](https://www.solidjs.com/), Vue Vapor and [Octane](/blog/octane-on-psp/) components — JSX, reactivity, flexbox, Tailwind classes, springs — on hardware with no browser and no JIT. It started on a 2004 Sony PSP at 333 MHz and has since reached a [PS Vita](/blog/pocketjs-on-ps-vita/), a [Nokia E7](/blog/pocketjs-on-symbian/), an ESP32-P4 and an e-reader. The runtime is a Rust core plus [QuickJS](https://bellard.org/quickjs/); applications are ordinary TypeScript.

The iPhone is the newest target and the **oldest touchscreen**: `iPhone1,1`, June 2007, a single ARM1176JZF-S, 128 MB of RAM, 320×480, and — for our purposes — no usable GPU. It is also the first PocketJS target that made us pay a hardware price to get there. Before any of the code below ran, we permanently destroyed the operating system that shipped on the phone. That is in here too, with the mechanism, because the failure is more useful than the success.

## The machine

<svg viewBox="0 0 760 236" width="100%" role="img" aria-label="Comparison of four PocketJS targets. Sony PSP-1000 from 2004: 333 megahertz MIPS single core, 32 megabytes RAM, 480 by 272 screen, fixed-function GE graphics. PS Vita from 2011: four-core ARM Cortex-A9, 512 megabytes, 960 by 544, GXM. Nokia E7 from 2011: 680 megahertz ARM11, 256 megabytes, 640 by 360, OpenGL ES 2. Original iPhone from 2007, highlighted: ARM1176JZF-S single core, 128 megabytes, 320 by 480, software raster blitted through CoreGraphics with no GPU in the path." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
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
  <text x="576" y="140" fill="#38bdf8" font-size="12">CGImage into drawRect:</text>
  <line x1="14" y1="170" x2="746" y2="170" stroke="#1e293b"/>
  <text x="14" y="192" fill="#94a3b8" font-size="11">Every other target has a pipeline to submit to. Here there is a rectangle of bytes and a 2D compositor —</text>
  <text x="14" y="210" fill="#94a3b8" font-size="11">the Rust core rasterizes ARGB32 in software, and UIKit draws it as one image, thirty times a second.</text>
  <text x="14" y="230" fill="#22d3ee" font-size="11">It is also the first target where the OS owns app identity: a signed bundle that SpringBoard launches.</text>
</svg>

The MBX Lite in there is real, and it is not in the path. Reaching it on this OS means private headers and a driver stack from an era we cannot pin by hash, for a fixed-function pipeline that would buy us nothing the software rasterizer does not already do at this resolution. So the iPhone host is the purest expression of the PocketJS core's actual contract: **give me a viewport, take back packed ARGB32 pixels.**

## Before any of that: we killed 1.1.4

The phone arrived running iPhone OS **1.1.4** (`4A102`), unjailbroken. The plan was ordinary: image the flash, jailbreak, install SSH, deploy. The route to a shell on a pre-2.0 iPhone is a temporary SSH ramdisk booted entirely in RAM — it does not flash the OS, does not touch the baseband, and every guide describes it as a read-only step.

[Legacy-iOS-Kit's](https://github.com/LukeZGD/Legacy-iOS-Kit) only SSH ramdisk for `iPhone1,1` is built from iPhone OS **3.1.3**. Booting it on a 1.1.4 phone opens the flash translation layer with 3.1.3's WMR/FTL driver. That driver **raised the NAND format signature — the "epoch" — from the `C003` 1.1.4 expects to `C005`.** It happens before any volume is mounted, below the partition table, and it is one-way. Afterwards, native 1.1.4 iBoot says this on every boot, forever:

```text
no signature or no production format
root filesystem mount failed
```

Three consequences are worth stating plainly, because each one cost us hours:

**Restoring the file data does not undo it.** We wrote the entire 8,120,172,544-byte disk image back — every allocated block of both volumes verified by SHA-256 against the backup, the MBR byte-identical, and an era-matched `fsck_hfs -q` reporting `FILESYSTEM CLEAN` on both. 1.1.4 still refused to boot. The rejection is *underneath* the filesystem you just proved correct.

**"Flashes no OS and no baseband" is not the same claim as "the OS still boots afterwards."** Both sentences were true at once. The documentation was accurate and we drew the wrong conclusion from it.

**A hand-built rollback wedged the phone.** We built a chain that booted 1.1.4's own restore kernel with no reformat flags plus a minimal helper that opened `AppleNANDFTL` and called the epoch selector exactly once. The result was a plain white screen and zero USB enumeration. The original iPhone implements Home + Power force-restart in iBoot and kernel *software*; there is no PMU-level reset combo, so holding the buttons for 30 seconds is precisely as effective as holding them for three. The only exit was **complete battery depletion** — disconnect everything, wait for the backlight to die, wait longer, then reconnect. The bootrom is mask ROM, so the device was never bricked; it was simply unreachable for several hours.

The repair that worked was a full 3.1.3 erase restore, which reformats the NAND as part of its normal operation. Legacy-iOS-Kit's `restore.sh` states outright that its 1.x path will not work for this model, so there was no route back.

That is why this project has a strange split identity that shows up everywhere in the code:

> **The build sysroot is 1.1.4 because that is what the phone had. The installed-system target is 3.1.3 because the phone can never run 1.1.4 again.**

### The other lesson: classify by product ID, never by name

Getting back into the bootrom's DFU mode on an S5L8900 goes Recovery → **WTF** (`0x1222`) → pwned DFU (`0x1227`), and WTF is what the ramdisk chain needs. We wrote a USB watcher to tell us which mode the phone was in. It matched devices whose product name contained `Apple Mobile` or `iPhone`.

The iPhone 2G's WTF mode enumerates as **`USB DFU Device`**.

So the watcher logged every *successful* WTF entry as `<gone>`, and we concluded the phone had powered off — repeatedly, while it sat in exactly the state we were trying to reach. We also decided the 18-year-old battery could only hold about eleven minutes, until two clean Recovery cycles came in **15m01s and 15m00s** apart, one second from each other, which is a fixed iBoot Recovery timeout and not a dying cell. Both mistakes were the same mistake: inferring device state from a signal that was never a state indicator. The watcher now keys on `idProduct` and nothing else.

There is deliberately **no command in this repository that enters DFU, restores an IPSW, or reformats NAND.** Those operations need an operator-reviewed plan, a byte-verified image, an explicit erase authorization and a separately verified exit route — not a subcommand.

## Part 1: the toolchain nobody removed

With a working 3.1.3 phone, the actual port starts. The first question is whether a 2026 Mac can produce a binary a 2007 loader will accept, and the answer is more or less yes, because **Apple has never removed the ARMv6 back end or the classic linker.** Both are one flag away in Xcode 26.6:

```sh
$ xcrun clang -target armv6-apple-darwin8 -miphoneos-version-min=1.1.4 \
    -march=armv6 -Os -c probe.c -o probe.o
$ file probe.o
probe.o: Mach-O object arm_v6
$ xcrun -f ld-classic
…/XcodeDefault.xctoolchain/usr/bin/ld-classic
```

Apple clang 21 emits `cputype 12, cpusubtype 6`. What is gone is everything *around* the compiler: there is no iPhone OS 1.x SDK, no `crt1.o` for this target, and the modern linker will not produce a Mach-O the old loader can read. So each of those is supplied explicitly.

**The sysroot is a decrypted stock root filesystem, pinned file by file.** `-syslibroot` points at the extracted 1.1.4 root image with `-L/usr/lib -F/System/Library/Frameworks`, and `doctor` hashes each of the six binaries the host and the device helper actually link — `libSystem.B.dylib`, `libgcc_s.1.dylib`, `libobjc.A.dylib`, `UIKit`, `Foundation`, `CoreGraphics`. Their provenance is the raw image (SHA-256 `14fbd220…`), which comes from Apple's own `iPhone1,1_1.1.4_4A102_Restore.ipsw` (SHA-256 `25fa72bc…`). Deliberately *not* files copied off a phone we had already modified.

**The C runtime startup is built from Apple's open source.** There is no `crt1.o` to link, so the build compiles [`Csu-76`](https://github.com/apple-oss-distributions/Csu)'s `start.s` and `dyld_glue.s` from a hash-pinned checkout and links with `-e start`.

**The link line is a list of Mach-O features to switch off.** Every one of these is something the 2008 dyld has never heard of:

```text
-no_pie  -no_uuid  -no_function_starts  -no_data_in_code_info
-no_source_version  -no_compact_unwind  -no_adhoc_codesign  -no_encryption
```

and then `ldid -S` applies the pseudo-signature a jailbroken 3.1.3 kernel wants.

**Version-min 1.1.4 is the ABI floor, not the target.** The executable carries `LC_VERSION_MIN_IPHONEOS` of 1.1.4 while the bundle declares `MinimumOSVersion 3.1.3`. Linking against the oldest ABI in the family and resolving the newer selectors at runtime gets us one binary that loads on both — which matters more than it sounds, since the sysroot we can verify and the OS we can boot are different releases.

<svg viewBox="0 0 760 320" width="100%" role="img" aria-label="Build pipeline for the iPhone 2G bundle. Pinned inputs on the left: the decrypted 1.1.4 sysroot with six hashed libraries, Apple Csu-76, pinned QuickJS, and Rust nightly 2026-07-02. In the middle, six build steps: the two-pass PocketJS app build producing app JavaScript and a pak; cargo build-std for the custom armv6-apple-ios target producing a no-std static library; clang at ARMv6 compiling the C UIKit host, the QuickJS translation units and a compatibility shim; ld-classic linking everything with all modern Mach-O features disabled and the guest embedded as two DATA sections; ldid signing; and the app bundle assembly. On the right, the output: PocketJSDemo.app containing an arm_v6 executable, Info.plist, PkgInfo and a 59 by 60 icon, plus a build receipt recording every input hash and a per-build identifier." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
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

A successful build proves the compiler, the linker and the packager. It proves **nothing** about the phone. Those are separate gates, and keeping them separate turned out to be the most important design decision in the whole port — more on that in Part 6.

## Part 2: the host is C because the linker cannot read Objective-C

A UIKit application needs at least two classes: a view that draws, and an application delegate. The obvious way to write them is Objective-C, and that is where the toolchain stops.

Modern Clang, asked for ARMv6 with a 1.1.4 deployment target, will happily compile an `@implementation`. `ld-classic` then **crashes** while translating the ObjC1 class-reference relocations Clang emitted for it. Not a diagnostic — a crash. The old ABI and the new compiler's metadata are far enough apart that the bridge inside the classic linker gives up.

There is no flag for this. There is, however, a way to need zero Objective-C metadata in the object file at all — and the API for it is right there in the phone's own runtime. The `libobjc.A.dylib` in our 1.1.4 sysroot is dated **11 February 2008**, and its 185 exported symbols include `_objc_allocateClassPair`, `_objc_registerClassPair`, `_class_addMethod` and `_objc_msgSend_stret`:

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

Two classes, built at startup, from a translation unit the classic linker sees as ordinary C. `UIApplicationMain` is then handed the class *names* as strings, and never knows the difference.

The cost is that you write the type encodings yourself — `"v@:{CGRect={CGPoint=ff}{CGSize=ff}}"` is `-(void)drawRect:(CGRect)` spelled out for the runtime — and that every message send is an explicit cast of `objc_msgSend`:

```c
static id send_id_rect(id receiver, const char *selector, CGRect rect) {
  return ((id (*)(id, SEL, CGRect))objc_msgSend)(receiver, sel_registerName(selector), rect);
}
```

**The trap here is struct returns.** On ARMv6, a method returning a `CGRect` does not use the same calling convention as one returning an `id`; it uses the struct-return variant, and the caller passes a hidden pointer to the result. Send `bounds` through plain `objc_msgSend` and you get a plausible-looking rectangle full of garbage, no crash, and a layout that is subtly wrong forever. So geometry goes through a separate helper:

```c
static CGRect send_rect(id receiver, const char *selector) {
  CGRect rect;
  ((void (*)(CGRect *, id, SEL))objc_msgSend_stret)(&rect, receiver, sel_registerName(selector));
  return rect;
}
```

None of this is clever. It is just the shape the constraint forces, and it is worth knowing that the shape exists: **you can write a complete UIKit application in C, with no Objective-C compiler involved, and the 2007 runtime supports it.**

## Part 3: one binary, two UIKits

The executable links against 1.1.4 and runs on 3.1.3. Those two UIKits disagree about nearly every lifecycle detail, so the host asks before it acts — `respondsToSelector:` for methods, `dlsym` for functions:

<svg viewBox="0 0 760 288" width="100%" role="img" aria-label="Table of six UIKit differences the host resolves at runtime. Status bar: iPhone OS 1.x uses UIHardware underscore setStatusBarHeight zero plus setStatusBarMode colon orientation colon duration colon fenceID colon, while 3.1.3 uses setStatusBarHidden colon. Window creation: 1.x uses initWithContentRect colon, 3.1.3 uses initWithFrame colon. View attachment: 1.x uses setContentView colon then orderFront colon, makeKey colon and underscore setHidden colon; 3.1.3 uses addSubview colon then makeKeyAndVisible. Graphics context: 1.x exports UICurrentContext, 3.1.3 exports UIGraphicsGetCurrentContext. Touch: 1.x delivers GSEvents through mouseDown, mouseDragged and mouseUp; 3.1.3 delivers UITouch objects through touchesBegan withEvent and friends. Launch callback: 1.x calls applicationDidFinishLaunching colon, 3.1.3 calls application colon didFinishLaunchingWithOptions colon. Methods are probed with respondsToSelector and functions with dlsym, which is also why the 3.1.3 binary carries no load command for GraphicsServices." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
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

That last line is the non-obvious one. The 1.x touch path needs `GSEventGetLocationInWindow`, which lived in a public `GraphicsServices.framework` in 1.1.4 and does not in 3.1.3. Declaring it `extern` and letting the linker record the dependency produces a binary that links fine on your Mac and is **rejected by dyld on the phone**. Resolving it through `dlsym` keeps the fallback available without putting the obsolete install name in the load commands — so the same executable that would use GSEvents on a 1.x phone loads cleanly on a 3.x one. A test asserts the `extern` declaration is absent, because that is exactly the kind of thing a well-meaning cleanup reintroduces.

The status bar is the other detail with a visible consequence. 1.1.4 reserves 20 pixels for it and reports a 320×460 content rect unless you take it away; 3.1.3 has `setStatusBarHidden:`. The app owns all 320×480 in both cases — and the C never guesses the number, because `POCKET_LOGICAL_WIDTH` and `POCKET_LOGICAL_HEIGHT` arrive as `-D` defines derived from the resolved build plan, with an `#error` if they are missing.

## Part 4: no GPU, so the frame is a `CGImage`

The core is a `no_std` Rust crate that rasterizes the retained UI tree into packed ARGB32. Getting it onto this target needed a custom target JSON, because Rust has never heard of `armv6-apple-ios`:

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

plus a pinned nightly and `-Z build-std=core,alloc,compiler_builtins`, since no prebuilt `core` exists.

**The crate we reused is the Symbian one.** `engine/symbian` already had exactly the right shape — `no_std`, a global allocator forwarding to C `malloc`, `abort` on panic, a flat `extern "C"` surface. Its switch for all of that was `cfg(target_os = "none")`, and this target's `target_os` is `ios`. So it gained a `bare-platform` Cargo feature and every one of those attributes became `any(target_os = "none", feature = "bare-platform")`. Nothing else changed. That is the ordinary lesson about target checks: **the first consumer makes a `cfg`, the second consumer turns it into a feature**, and you find out which conditions were really about "bare metal" versus really about "Symbian".

Two symbols were missing, and both are the kind of thing you only learn at link time:

- **`clock_gettime`** postdates iPhone OS 1.1.4. QuickJS references it only for `Atomics`, so it forwards to `gettimeofday`.
- **`memset_pattern16`** is a Darwin-specific libc entry point LLVM emits as an optimization for the Rust core, and which this libc does not have.

Both together are `compat.c`, which is **23 lines including the includes**. That is the entire platform shim.

**The guest ships inside the executable as Mach-O sections.** `-sectcreate __DATA __pocket_js` and `-sectcreate __DATA __pocket_pak` embed the compiled JavaScript (118 KB) and the asset pack (465 KB); the host reads them with `getsectdata` at boot. No file I/O, no bundle resource lookup, nothing to get out of sync with the executable — the guest and the native code are literally the same file, which is also why the build receipt can bind one identifier to all of it.

Then the frame loop, which is almost embarrassingly short:

```c
g_timer = /* NSTimer scheduledTimerWithTimeInterval:target:selector:userInfo:repeats: */
  send_id_timer((id)objc_getClass("NSTimer"), …, 1.0 / 30.0, g_view,
                sel_registerName("pocketJSTick:"), NULL, YES);
```

Each tick calls `frame()` in QuickJS, ticks the core, takes the framebuffer pointer, and asks for a redraw. `drawRect:` wraps that pointer in a `CGImage` and draws it once. Two details in there are easy to get wrong and produce output that *almost* looks right:

**Byte order.** The core exposes ARGB32 *words*. On little-endian ARMv6 those words are `B,G,R,A` bytes in memory, so the image is created with `kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little`. Get it wrong and you get a red/blue swap that survives every automated check a human is not looking at.

**Orientation.** `CGImage` rows are top-down; the 1.x Quartz draw context is y-up. The draw flips the CTM rather than flipping the pixels, so the rasterizer never learns about the platform.

The app is told the truth about all of this. `__simHz` is 30, so PocketJS's [virtual clock](/blog/ui-runtime-that-cant-flake/) advances at the rate the frames actually arrive, and the demo's own header reads `30` instead of a number it inherited from a handheld:

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
      presentationHz={30}
      runtimeLabel="RUST + QUICKJS + UIKIT"
    />
  );
}
```

That is the whole iPhone application. It is the *shared* Hero component — the same file the PSP, the Vita and the E7 render — with four props and one receipt hook.

## Part 5: getting it onto the phone is a transaction

`scp` would work. It would also, on any interrupted copy, leave a half-written application bundle in `/Applications` and no way to tell that from a good one.

Deployment therefore has a device side: a small signed ARMv6 helper at `/usr/libexec/pocketjs-device`, built by the same toolchain as the app, that performs installs as a two-phase transaction. Upload to a staging directory, read every file back and compare bytes, move the existing bundle to a backup, commit, then clear the marker. The marker itself lives on the always-writable data volume and records the phase, whether a previous version existed, and the transaction id — so a power loss mid-install is a recoverable state rather than a mystery. The helper **refuses to delete a directory it cannot prove belongs to us**, which is the check that caught a leftover canary bundle from an earlier experiment instead of silently eating it.

The SSH bootstrap is the part that needed the most care, because the failure mode is losing your only channel to the phone. The jailbreak ships its own `sshd`, host key and launchd plist, and the install **preserves all three** — their hashes are identical before and after, which is asserted, not assumed. A dedicated client key is merged in; password authentication is disabled *only after* key authentication and the helper both verify; anything else rolls back. The three hashes still matched after a cold restart, which is the only interesting time to check.

There is one honest wart. `/sbin/reboot` on this installation stops services and then sits on its shutdown spinner indefinitely. Home + Power completes the restart, and the app bundle, the helper and the key-only policy all survived that — but the documentation records it as *forced-restart recovery*, not as "reboot works". They are different facts and only one of them is true.

## Part 6: what counts as proof

Here is the receipt the phone produced after the first successful end-to-end run:

```text
build_id=ba1c0b15af4fdb72c6a98334332a8954
state=running
guest_frames=118
touch_sequences=11
last_touch_hit=46
error=
```

A build that matches the local bundle, a running guest, 118 frames, 11 touch sequences, a hit. It reads like proof. A review pass then took it apart, and the two findings are the most transferable thing in this post.

**`last_touch_hit` is a geometry fact, not an application fact.** It was computed at touch-*down*, against any layout bounds under the finger, and the validator accepted records with `touch_down=1`. So a passing record could be written before the finger lifted, before `onPress` fired, and before the Solid signal changed. Everything it asserted was true; none of it was the claim we were making.

**A `state=running` file outlives the process that wrote it.** There was no PID, no timestamp, no heartbeat. If the app crashed or was `SIGKILL`ed, the termination callback never ran, the file stayed exactly as it was, and the next `device-status` happily re-read a successful record from a process that no longer existed.

The hardened protocol requires four things at once, and it is schema-versioned so old records are rejected rather than reinterpreted:

<svg viewBox="0 0 760 216" width="100%" role="img" aria-label="Diagram of the schema-2 acceptance record. Four requirements are listed: the recorded PID must still be alive; the heartbeat must have advanced since the previous read; a touch sequence must have completed, meaning the finger was released; and the application must report a changed hero_tap value. Below, a chain shows what the fourth requirement implies end to end: QuickJS evaluated the guest, the Rust core laid out and rasterized it, UIKit delivered a real touch, the framework routed it to onPress, Solid's reactive effect ran, and the host wrote the action into the record." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
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
  /* validate name and int32 range, then: */
  getOps().__reportAppAction?.(name, value);
}
```

The sink is optional and double-underscored on purpose — it is diagnostic evidence, not an input mechanism, it sits outside the portable operation ABI, and on every host without a receipt collector it is a no-op. The application calls it from a `createEffect` on the count. **The evidence path runs through the reactive graph, which is the only way a receipt can testify about reactivity.**

Three more findings from the same review are worth listing because none of them are exotic:

- **Two sources of truth for a cross-layer contract.** The guest got its target id and host ABI from the resolved build plan; the native host had them hardcoded. A legitimate ABI bump would have produced a clean local build, a clean link, and a mismatch that only appears when the phone launches the app. Both sides now come from the plan.
- **A synchronous write per frame while a finger is down.** The status record was rewritten on every tick where a touch was delivered — about 30 `open`/`write`/`fsync`/`rename` per second on 2007 NAND during any drag. Now it is edge-triggered plus a heartbeat every 30 frames.
- **Four new test files that were not in CI.** `bun run test` runs the files enumerated in `tools/test.ts`, and the release workflow calls exactly that. The iPhone tests existed, passed locally, and were invisible to a green build. A test that is not in the runner's list is not a test.

## The icon, which took four tries

<p style="display:inline-block;background:#4b5563;padding:14px;border-radius:14px">
  <img width="236" height="240" src="/assets/blog/iphone2g-icon-4x.png" alt="The PocketJS SpringBoard icon at 4x: a black enamel rounded square with a bright chrome bevel, a curved glass highlight across the top half, and the silver PocketJS mark centered" />
</p>

<p class="text-sm text-slate-500">The shipped <code>Icon.png</code> at 4× nearest-neighbour, on a neutral plate so the transparent corners read. It is 59×60, and a test pins its SHA-256 plus the alpha at all four corners and four specific interior pixels.</p>

A 59×60 PNG is not usually worth a section. This one is, because it failed three times in three different ways and each failure was a category error:

1. **The demo's in-app logo**, which is a player mark that belongs to the Hero screen, not an application identity.
2. **The white-plate brand asset**, which looks correct in a README and puts a white square on a phone home screen.
3. **The black-plate brand asset** — correct for the website, and functionally invisible against the black SpringBoard wallpaper it was about to sit on.

The fourth version is the one above: black enamel, a bright chrome bevel that gives it an outline against the wallpaper, a curved glass highlight in the 2007 idiom, and transparent rounded corners. It is *pre-baked*, generated once and then deterministically scaled and cropped, with pixel-level assertions so the next well-meaning asset sweep cannot quietly replace it.

The audit that followed found the same mistake in one more place — the site's `favicon.svg` was transparent, which meant it rendered as the white-plate version on every light background. Fixed at the source.

## What the port cost

<svg viewBox="0 0 760 264" width="100%" role="img" aria-label="Summary of the iPhone port. Commit 11245e0, the ARMv6 host, toolchain and the NAND epoch hazard record, plus 6319 lines. Commit 8a61b11, retargeting the device workflow from 1.1.4 to iPhone OS 3.1.3, plus 1549. Commit 1ab8d74, recording the live runtime acceptance, plus 79. Commit 655a8a3, the Hero demo and a tilt input, plus 846. Commit 0198a98, baking the classic icon and removing tilt again, plus 115. Then the review pass, hardening the bootstrap, the acceptance protocol, the single source of truth and CI, plus 1202. Total roughly 8600 lines added in one draft pull request, with the production target registry unchanged, zero pixel goldens updated and zero Hero tape hashes changed." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">THE WHOLE PORT · ONE DRAFT PR</text>
  <line x1="14" y1="28" x2="746" y2="28" stroke="#1e293b"/>
  <g font-size="11.5">
    <text x="14" y="52" fill="#38bdf8">11245e0</text><text x="110" y="52" fill="#e2e8f0">ARMv6 host · toolchain · demo · the NAND epoch record</text><text x="700" y="52" fill="#94a3b8" text-anchor="end">+6,319</text>
    <text x="14" y="76" fill="#38bdf8">8a61b11</text><text x="110" y="76" fill="#e2e8f0">retarget the device workflow 1.1.4 → 3.1.3 · signing · SSH</text><text x="700" y="76" fill="#94a3b8" text-anchor="end">+1,549</text>
    <text x="14" y="100" fill="#38bdf8">1ab8d74</text><text x="110" y="100" fill="#e2e8f0">record the first live runtime receipt</text><text x="700" y="100" fill="#94a3b8" text-anchor="end">+79</text>
    <text x="14" y="124" fill="#38bdf8">655a8a3</text><text x="110" y="124" fill="#e2e8f0">the shared Hero on the phone · <tspan fill="#eab308">a tilt input</tspan></text><text x="700" y="124" fill="#94a3b8" text-anchor="end">+846</text>
    <text x="14" y="148" fill="#38bdf8">0198a98</text><text x="110" y="148" fill="#e2e8f0">bake the classic icon · <tspan fill="#eab308">remove the tilt input again</tspan></text><text x="700" y="148" fill="#94a3b8" text-anchor="end">+115</text>
    <text x="14" y="172" fill="#a78bfa">review pass</text><text x="110" y="172" fill="#e2e8f0">bootstrap safety · acceptance protocol · one source of truth · CI</text><text x="700" y="172" fill="#94a3b8" text-anchor="end">+1,202</text>
  </g>
  <line x1="14" y1="188" x2="746" y2="188" stroke="#1e293b"/>
  <text x="14" y="210" fill="#22d3ee" font-size="11">≈8,600 lines · six changesets · one draft PR</text>
  <text x="14" y="228" fill="#22d3ee" font-size="11">production target registry unchanged · pixel goldens updated: 0 · Hero tape hashes changed: 0</text>
  <text x="14" y="250" fill="#64748b" font-size="11">Framework additions: one optional receipt sink and one core export. The rest is a host and a toolchain.</text>
</svg>

The two yellow rows are a feature that shipped and then was deleted. The accelerometer went in as a hardware-neutral `input.tilt` capability — a fifth frame argument, a DevTools tape version, a contract entry, and `UIAccelerometer` on the device — and on the Hero screen it moved the headline a few pixels. It was decorative, so it came out completely: the public API, the frame argument, the tape version, the native code, the acceptance field. Adding an input capability to a portable frame contract is cheap to write and expensive to keep, and "it works on the device" is not the same as "it earns a place in the contract."

What did not move is the argument. The 54 committed pixel goldens and the 180-frame Hero tape hashes are byte-identical, the framework did not gain a platform check, and `POCKET_TARGETS` did not gain an entry — there is a test that asserts `iphone2g-dev` stays out of it.

## The honest boundary

This is **not** a production PocketJS target, and the pull request is still a draft.

- The build profile lives in `tools/`, deliberately outside the production registry, and stays there until it earns its way out.
- Everything is verified on **one** device, one build: `iPhone1,1` running 3.1.3 (`7E18`). There are no iPhone pixel goldens.
- The recovery, transport, linker-ABI and package/deployment layers all have receipts. The runtime layer has real device receipts — hundreds of frames, dozens of touch sequences, across a cold restart — recorded under the *old* protocol. The hardened schema-2 gate is in the code and in the docs; **re-running it on the phone is what the draft still owes**, and until it does, the runbook labels the existing receipt historical rather than promoting it.
- `/sbin/reboot` stalls. Restart with Home + Power.
- No firmware, decrypted system file, ramdisk, pairing record, SSH key or historical package is in the repository. Reproducing this means supplying your own copies under their original terms; the toolchain verifies their hashes and does the rest.

## Why bother

There is no market here. Nobody is shipping an app for a 2007 iPhone, and this port will never have users.

It is a test, and it tests something the other targets cannot. The PSP, the Vita and the ESP32 are machines you own outright: you boot your own code and negotiate with nothing. [Symbian](/blog/pocketjs-on-symbian/) was the first target with an operating system that owns the screen and the scheduler and expects to be asked. The iPhone is the first one that owns **identity** — a bundle, a signature, an installer, a home screen, a launch protocol — and the first where the graphics path is not a graphics path at all, just a rectangle of bytes handed to a 2D compositor thirty times a second.

The runtime went onto it without a fork. The parts that changed were a toolchain, a host, and one optional diagnostic sink. The parts that did not change — the core, the framework, the goldens, the target registry — are the evidence, and they are the same parts that did not change for Symbian and for the Vita.

The other thing this port taught us has nothing to do with UI runtimes. **Every hour we lost was lost to a signal we trusted for something it never measured**: a ramdisk documented as read-only that rewrote NAND metadata anyway, a USB watcher that read product names instead of product IDs, a battery blamed for a fixed bootloader timeout, and a receipt that proved geometry when we thought it proved reactivity. The phone survived all four. The last one is the only one we could fix in code, and it is the only one that will still matter next year.

---

*PocketJS is open source at [pocket-stack/pocketjs](https://github.com/pocket-stack/pocketjs). The iPhone workflow, the acceptance layers and the full NAND epoch incident record are in [`docs/IPHONE2G.md`](https://github.com/pocket-stack/pocketjs/blob/main/docs/IPHONE2G.md); the port is draft PR [#219](https://github.com/pocket-stack/pocketjs/pull/219). The recovery tooling is [Legacy-iOS-Kit](https://github.com/LukeZGD/Legacy-iOS-Kit), the C runtime startup is Apple's [Csu](https://github.com/apple-oss-distributions/Csu), and the historical map of this toolchain territory is still [saurik's](https://www.saurik.com/toolchain.html).*
