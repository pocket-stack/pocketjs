/*
 * PocketJS Nintendo 3DS host: libctru/citro3d boot, then fixed-rate virtual
 * frames while QuickJS runs the guest, the Rust core ticks animations and
 * layout, and the PICA200 backend draws the DrawList.
 *
 * Frame order (docs/DESIGN.md, the shape hosts/psp/src/main.rs drives):
 * hidScanInput -> globalThis.frame(buttons, analog) -> drain jobs ->
 * ui_tick (fixed 1/60) -> ui_draw -> C3D_FrameBegin/Clear/FrameDrawOn/
 * SetViewport -> gfx_render -> C3D_FrameEnd.
 *
 * The app owns the whole 400x240 top screen (form "takeover"). The render
 * target is created ROTATED — 240 wide by 400 tall — and Mtx_OrthoTilt in
 * gfx.c keeps the guest's coordinates landscape.
 *
 * Building with -DPOCKETJS_CAPTURE turns this into the deterministic e2e
 * binary: input comes from a baked tape instead of the hardware, the listed
 * frames are read back off the render target into sdmc:/fNNNN.raw, and the
 * process parks instead of exiting so the emulator stays alive for the driver
 * to kill.
 */

#include <3ds.h>
#include <citro3d.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "gfx.h"
#include "input.h"
#include "pocket_core.h"
#include "qjs.h"

/* The guest viewport comes from the resolved build plan, never a literal. */
#ifndef POCKETJS_VIEW_W
#error "POCKETJS_VIEW_W must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_VIEW_H
#error "POCKETJS_VIEW_H must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_RASTER_DENSITY
#error "POCKETJS_RASTER_DENSITY must come from the verified ResolvedBuildPlan"
#endif
#define VIEW_W POCKETJS_VIEW_W
#define VIEW_H POCKETJS_VIEW_H
#define CAPTURE_BYTES ((size_t)VIEW_W * VIEW_H * 4)

/* contracts/spec/spec.ts ANALOG_CENTER. */
#define ANALOG_CENTER 0x8080

/*
 * devkitPro's 3dsx crt0 gives the main thread 32 KiB of stack. QuickJS's
 * interpreter recurses, and so does the Solid render pass it runs, so the
 * default is far too small — a bundle that mounts fine everywhere else
 * corrupts the stack here. libctru reads this symbol at startup.
 */
unsigned int __stacksize__ = 1024 * 1024;

static C3D_RenderTarget *target;

static const u32 DISPLAY_TRANSFER_FLAGS =
  GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
  GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
  GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
  GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO);

// ---------------------------------------------------------------------------
// romfs assets
// ---------------------------------------------------------------------------

/* Read a whole romfs file, NUL-terminating it: JS_Eval requires
 * `source[length] == '\0'`, and one extra byte costs nothing for the pak. */
static uint8_t *read_file(const char *path, size_t *length) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  uint8_t *bytes = malloc((size_t)size + 1);
  if (bytes == NULL) {
    fclose(file);
    return NULL;
  }
  size_t read = fread(bytes, 1, (size_t)size, file);
  fclose(file);
  if (read != (size_t)size) {
    free(bytes);
    return NULL;
  }
  bytes[size] = '\0';
  *length = (size_t)size;
  return bytes;
}

// ---------------------------------------------------------------------------
// capture build (tests/e2e/azahar.ts)
// ---------------------------------------------------------------------------

#ifdef POCKETJS_CAPTURE

#ifndef POCKETJS_CAPTURE_INPUT
#define POCKETJS_CAPTURE_INPUT ""
#endif
#ifndef POCKETJS_CAP_START
#define POCKETJS_CAP_START 0
#endif
#ifndef POCKETJS_CAP_N
#define POCKETJS_CAP_N 1
#endif

/* Everything the driver reads lives in one directory, so a run's frames can
 * never be confused with a previous run's (tests/e2e/azahar.ts). */
#define CAPTURE_DIR "sdmc:/pocketjs-captures"

/* The PPF's own RGB8 staging buffer, and the A,B,G,R buffer the file holds. */
#define CAPTURE_RGB_BYTES ((size_t)VIEW_W * VIEW_H * 3)

static u32 *capture_buffer;
static u8 *capture_rgb;
static const char CAPTURE_INPUT[] = POCKETJS_CAPTURE_INPUT;

/* Read one unsigned value, decimal or 0x-prefixed hex, from [start, end). */
static bool parse_uint(const char *text, size_t start, size_t end, uint32_t *out) {
  while (start < end && (text[start] == ' ' || text[start] == '\t')) start += 1;
  if (start >= end) return false;
  bool hex = start + 1 < end && text[start] == '0' &&
             (text[start + 1] == 'x' || text[start + 1] == 'X');
  if (hex) start += 2;
  uint32_t value = 0;
  bool any = false;
  for (; start < end; start += 1) {
    char c = text[start];
    uint32_t digit;
    if (c >= '0' && c <= '9') digit = (uint32_t)(c - '0');
    else if (hex && c >= 'a' && c <= 'f') digit = (uint32_t)(c - 'a' + 10);
    else if (hex && c >= 'A' && c <= 'F') digit = (uint32_t)(c - 'A' + 10);
    else if (c == ' ' || c == '\t') break;
    else return false;
    value = value * (hex ? 16u : 10u) + digit;
    any = true;
  }
  if (!any) return false;
  *out = value;
  return true;
}

static bool capture_wants(uint32_t frame) {
  return frame - (uint32_t)POCKETJS_CAP_START < (uint32_t)POCKETJS_CAP_N;
}

/*
 * Baked scripted input, `frame:mask,frame:mask` with decimal or hex masks —
 * the format hosts/psp/src/main.rs reads. The active mask is the last
 * threshold at or before `frame`, so `0:0,20:0x40,24:0` means idle, press
 * DOWN at frame 20, release at 24. Input is baked into the binary at build
 * time and never read from the emulator's filesystem at runtime.
 */
static int32_t scripted_buttons(uint32_t frame) {
  size_t length = sizeof CAPTURE_INPUT - 1;
  size_t index = 0;
  bool found = false;
  uint32_t best_frame = 0;
  uint32_t best_mask = 0;
  while (index < length) {
    while (index < length && (CAPTURE_INPUT[index] == ',' || CAPTURE_INPUT[index] == ';' ||
                              CAPTURE_INPUT[index] == ' ')) {
      index += 1;
    }
    size_t frame_start = index;
    while (index < length && CAPTURE_INPUT[index] != ':' && CAPTURE_INPUT[index] != ',') {
      index += 1;
    }
    if (index >= length || CAPTURE_INPUT[index] != ':') break;
    size_t frame_end = index;
    index += 1;
    size_t mask_start = index;
    while (index < length && CAPTURE_INPUT[index] != ',' && CAPTURE_INPUT[index] != ';') {
      index += 1;
    }
    uint32_t at = 0;
    uint32_t mask = 0;
    if (parse_uint(CAPTURE_INPUT, frame_start, frame_end, &at) &&
        parse_uint(CAPTURE_INPUT, mask_start, index, &mask) && at <= frame &&
        (!found || at >= best_frame)) {
      found = true;
      best_frame = at;
      best_mask = mask;
    }
  }
  return (int32_t)best_mask;
}

/*
 * Read the render target back.
 *
 * NOT gfxGetFramebuffer after C3D_FrameEnd: that buffer has already been
 * swapped and reads back black. An explicit display transfer untiles the
 * PICA200 colour buffer into linear CPU-readable memory.
 *
 * **The transfer's output format must be GX_TRANSFER_FMT_RGB8, not RGBA8.**
 * Asking the PPF for a 32-bit linear output out of this 240x400 tiled colour
 * buffer returns rows that are each individually correct and progressively
 * misregistered — every fourth output row slips a further 64 texels — which
 * reads as a shredded screen while the same frame presents perfectly. Azahar's
 * software rasterizer happens to answer the 32-bit request correctly, so the
 * bug only shows under a hardware renderer; measured against a known probe
 * rectangle in the Pocket Voxel host, RGBA8 out matched 74.6% of it and RGB8
 * out matched 100.0%. RGB8 is also the format citro3d's own presentation
 * transfer uses (DISPLAY_TRANSFER_FLAGS above), so the capture travels the
 * path the screen travels. The dropped alpha byte was never read: the decode
 * takes R, G and B only.
 *
 * The bytes stay in the rotated screen orientation — 240 wide by 400 tall,
 * column-major — and each capture word is byte order A, B, G, R. The e2e
 * driver decodes with src[(x * 240 + (239 - y)) * 4] -> dst[y * 400 + x].
 */
static bool capture_write(uint32_t frame) {
  /* C3D_FrameEnd only queues the frame. The colour buffer is not finished
   * until the GPU is, so wait before transferring it out. */
  gspWaitForVBlank();
  C3D_SyncDisplayTransfer(
    (u32 *)target->frameBuf.colorBuf,
    GX_BUFFER_DIM(VIEW_H, VIEW_W),
    (u32 *)capture_rgb,
    GX_BUFFER_DIM(VIEW_H, VIEW_W),
    GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
      GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
      GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
      GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO)
  );
  GSPGPU_InvalidateDataCache(capture_rgb, (s32)CAPTURE_RGB_BYTES);

  /* Widen B, G, R back into the A, B, G, R word the golden format states, so
   * the on-device format change costs the driver nothing. */
  uint8_t *out = (uint8_t *)capture_buffer;
  for (size_t i = 0; i < (size_t)VIEW_W * VIEW_H; i += 1) {
    out[i * 4 + 0] = 0xff;
    out[i * 4 + 1] = capture_rgb[i * 3 + 0];
    out[i * 4 + 2] = capture_rgb[i * 3 + 1];
    out[i * 4 + 3] = capture_rgb[i * 3 + 2];
  }

  /* Named by the process-global frame counter, which is also what indexes the
   * baked input tape: input at frame N and file fN are the same frame. */
  char path[64];
  snprintf(path, sizeof path, CAPTURE_DIR "/f%04lu.raw", (unsigned long)frame);
  FILE *file = fopen(path, "wb");
  if (file == NULL) return false;
  size_t written = fwrite(capture_buffer, 1, CAPTURE_BYTES, file);
  return fclose(file) == 0 && written == CAPTURE_BYTES;
}

/* The sentinel the driver waits for. Written only after every requested frame
 * has been written AND closed, so a partial file can never be compared. */
static void capture_done(void) {
  FILE *file = fopen(CAPTURE_DIR "/done", "wb");
  if (file == NULL) return;
  fputs("ok\n", file);
  fclose(file);
}

#endif /* POCKETJS_CAPTURE */

/* Report a boot or runtime failure as itself rather than as a timeout, then
 * park. */
static void fail(const char *message) {
  const char *text = message == NULL || message[0] == '\0' ? "unknown failure" : message;
#ifdef POCKETJS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
  FILE *file = fopen(CAPTURE_DIR "/error.txt", "wb");
#else
  FILE *file = fopen("sdmc:/pocketjs-error.txt", "wb");
#endif
  if (file != NULL) {
    fputs(text, file);
    fputs("\n", file);
    fclose(file);
  }

#ifdef POCKETJS_CAPTURE
  /* Park: Azahar does not stop when the app returns from main, and a still
   * process is what the driver kills. */
  for (;;) gspWaitForVBlank();
#else
  /* On hardware the message has to be readable without pulling the card, and
   * HOME has to keep working: parking in a bare loop costs the user a forced
   * power-off, which is also the one way to lose the file just written. */
  consoleInit(GFX_BOTTOM, NULL);
  printf("PocketJS %s\nFAILED: %s\nPress HOME to exit.\n", POCKETJS_TARGET_ID, text);
  gfxFlushBuffers();
  gfxSwapBuffers();
  gspWaitForVBlank();
  while (aptMainLoop()) {
    gfxFlushBuffers();
    gfxSwapBuffers();
    gspWaitForVBlank();
  }
  gfxExit();
  exit(1);
#endif
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

int main(void) {
  gfxInitDefault();
  /* No-op on an Old 3DS; on a New 3DS it unlocks the faster clock and the
   * extra cache, which the QuickJS guest feels directly. */
  osSetSpeedupEnable(true);
  C3D_Init(C3D_DEFAULT_CMDBUF_SIZE);

  target = C3D_RenderTargetCreate(VIEW_H, VIEW_W, GPU_RB_RGBA8, GPU_RB_DEPTH24_STENCIL8);
  if (target == NULL) fail("C3D_RenderTargetCreate failed");
  C3D_RenderTargetSetOutput(target, GFX_TOP, GFX_LEFT, DISPLAY_TRANSFER_FLAGS);

  if (R_FAILED(romfsInit())) fail("romfsInit failed: the .3dsx has no romfs");

  size_t source_length = 0;
  uint8_t *source = read_file("romfs:/app.js", &source_length);
  if (source == NULL) fail("romfs:/app.js is missing or unreadable");
  size_t pack_length = 0;
  uint8_t *pack = read_file("romfs:/app.pak", &pack_length);

  /* The core is fed from the pak natively, before any JS runs: styles.bin,
   * font atlases and images never transit the QuickJS heap. */
  ui_init(POCKETJS_RASTER_DENSITY);
  ui_set_viewport((float)VIEW_W, (float)VIEW_H);
  if (pack != NULL) ui_feed_pak(pack, pack_length);

  if (!gfx_init(VIEW_W, VIEW_H)) fail("PICA200 backend failed to initialize");
  if (!qjs_boot((const char *)source, source_length, pack, pack_length)) fail(qjs_last_error());

#ifdef POCKETJS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
  capture_buffer = linearAlloc(CAPTURE_BYTES);
  capture_rgb = linearAlloc(CAPTURE_RGB_BYTES);
  if (capture_buffer == NULL || capture_rgb == NULL) fail("capture buffer allocation failed");
  uint32_t frame = 0;
#endif
#ifndef POCKETJS_CAPTURE
  uint32_t run_frame = 0;
#endif

  while (aptMainLoop()) {
    hidScanInput();
#ifdef POCKETJS_CAPTURE
    /* The tape has no analog track: pin the stick to centre so scripted runs
     * stay deterministic. */
    int32_t buttons = scripted_buttons(frame);
    int32_t analog = ANALOG_CENTER;
#else
    int32_t buttons = input_buttons();
    int32_t analog = input_analog();
#endif

    if (!qjs_frame(buttons, analog)) fail(qjs_last_error());
    /* Animations always advance at the fixed 1/60 timestep; this host
     * presents at the same rate, so it is one tick per frame. */
    ui_tick();
    size_t words = ui_draw();

#ifdef POCKETJS_CAPTURE
    C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
#else
    /*
     * Watchdog in place of C3D_FRAME_SYNCDRAW's unbounded wait: SYNCDRAW never
     * returns when the GPU hangs on the previous frame's command list, which
     * reads as a dead console — HOME included — and ends in a forced power-off.
     * Poll instead, and after three seconds report the hang as itself, with
     * HOME kept alive by fail()'s park loop.
     */
    gspWaitForVBlank();
    uint32_t waited = 0;
    while (!C3D_FrameBegin(C3D_FRAME_NONBLOCK)) {
      gspWaitForVBlank();
      waited += 1;
      if (waited == 180) {
        char verdict[96];
        snprintf(
          verdict,
          sizeof verdict,
          "GPU HUNG executing frame %lu (%lu cmds, %lu verts)",
          (unsigned long)(run_frame == 0 ? 0 : run_frame - 1),
          (unsigned long)gfx_frame_commands(),
          (unsigned long)gfx_frame_vertices()
        );
        fail(verdict);
      }
    }
#endif
    C3D_RenderTargetClear(target, C3D_CLEAR_ALL, 0x000000ff, 0);
    C3D_FrameDrawOn(target);
    /* C3D_FrameDrawOn resets the viewport, so this comes after it. */
    C3D_SetViewport(0, 0, VIEW_H, VIEW_W);
    gfx_render(ui_draw_list_ptr(), words);
    C3D_FrameEnd(0);
#ifndef POCKETJS_CAPTURE
    run_frame += 1;
#endif

#ifdef POCKETJS_CAPTURE
    if (capture_wants(frame)) {
      /* A frame that overflowed the vertex arena is missing geometry, which
       * must never become a golden. */
      if (gfx_dropped_vertices() > 0) fail("vertex arena overflowed during capture");
      if (!capture_write(frame)) fail("capture write failed");
      if (frame + 1 >= (uint32_t)POCKETJS_CAP_START + POCKETJS_CAP_N) {
        capture_done();
        /* Park: Azahar does not stop when the app returns from main, and a
         * still process is what the driver kills. */
        for (;;) gspWaitForVBlank();
      }
    }
    frame += 1;
#endif
  }

  qjs_shutdown();
  gfx_shutdown();
  ui_shutdown();
  C3D_Fini();
  gfxExit();
  return 0;
}
