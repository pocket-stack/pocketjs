/*
 * ge-probe — ArtInChip GE bring-up probe for PocketJS (spike, not shipped).
 *
 * Talks to /dev/ge directly through the vendor UAPI so the result is the same
 * whether or not the MPP wrapper is linked. Exercises the operations a
 * PocketJS GE backend would need, verifies pixel order and alpha parity
 * against the software rasterizer's integer blend, and times the ioctls.
 *
 * Build (Luban wrapper, pure C):
 *   riscv64-unknown-linux-gnu-gcc -O2 ge-probe.c -o ge-probe
 * Run on the device:
 *   ./ge-probe          # buffer tests + timings
 *   ./ge-probe --fb     # additionally draws a pattern into /dev/fb0
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/dma-heap.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <video/artinchip_fb.h>
#include <video/artinchip_ge.h>
#include <video/mpp_types.h>

#define GE_DEVICE "/dev/ge"
#define HEAP_DEVICE "/dev/dma_heap/reserved"
#define FB_DEVICE "/dev/fb0"

static int ge_fd = -1;
static int heap_fd = -1;

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static void fatal(const char *what) {
  fprintf(stderr, "ge-probe: %s: %s\n", what, strerror(errno));
  exit(1);
}

typedef struct {
  int fd;
  uint32_t stride;
  int width;
  int height;
  uint32_t *pixels;
  size_t map_length;
} GBuffer;

static GBuffer *buffer_allocate(int width, int height, enum mpp_pixel_format format) {
  GBuffer *buffer = calloc(1, sizeof(*buffer));
  if (buffer == 0) fatal("calloc");
  uint32_t bytes_per_pixel = 4;
  switch (format) {
    case MPP_FMT_RGB_565:
    case MPP_FMT_ARGB_1555:
    case MPP_FMT_ABGR_1555:
    case MPP_FMT_RGBA_5551:
    case MPP_FMT_BGRA_5551:
    case MPP_FMT_ARGB_4444:
    case MPP_FMT_ABGR_4444:
    case MPP_FMT_RGBA_4444:
    case MPP_FMT_BGRA_4444:
      bytes_per_pixel = 2;
      break;
    default:
      bytes_per_pixel = 4;
      break;
  }
  buffer->width = width;
  buffer->height = height;
  buffer->stride = ((uint32_t)width * bytes_per_pixel + 7u) & ~7u;

  struct dma_heap_allocation_data allocation;
  memset(&allocation, 0, sizeof(allocation));
  allocation.len = buffer->stride * (uint32_t)height;
  allocation.fd_flags = O_RDWR | O_CLOEXEC;
  if (ioctl(heap_fd, DMA_HEAP_IOCTL_ALLOC, &allocation) < 0) fatal("DMA_HEAP_IOCTL_ALLOC");
  buffer->fd = allocation.fd;
  buffer->map_length = allocation.len;
  buffer->pixels = mmap(NULL, allocation.len, PROT_READ | PROT_WRITE, MAP_SHARED, allocation.fd, 0);
  if (buffer->pixels == MAP_FAILED) fatal("mmap dma-buf");
  return buffer;
}

static void buffer_free(GBuffer *buffer) {
  if (buffer == 0) return;
  if (buffer->pixels != 0) munmap(buffer->pixels, buffer->map_length);
  if (buffer->fd >= 0) close(buffer->fd);
  free(buffer);
}

static void buffer_fill_cpu(GBuffer *buffer, uint32_t value) {
  for (int y = 0; y < buffer->height; y++) {
    uint32_t *row = buffer->pixels + (size_t)y * (buffer->stride / 4);
    for (int x = 0; x < buffer->width; x++) row[x] = value;
  }
}

static struct mpp_buf buffer_mpp(const GBuffer *buffer, enum mpp_pixel_format format) {
  struct mpp_buf buf;
  memset(&buf, 0, sizeof(buf));
  buf.buf_type = MPP_DMA_BUF_FD;
  buf.fd[0] = buffer->fd;
  buf.stride[0] = buffer->stride;
  buf.size.width = buffer->width;
  buf.size.height = buffer->height;
  buf.format = format;
  return buf;
}

static void ge_fillrect(GBuffer *dst, struct mpp_rect rect, enum ge_fillrect_type type,
                        uint32_t start_color, uint32_t end_color, struct ge_ctrl ctrl) {
  struct ge_fillrect fill;
  memset(&fill, 0, sizeof(fill));
  fill.type = type;
  fill.start_color = start_color;
  fill.end_color = end_color;
  fill.dst_buf = buffer_mpp(dst, MPP_FMT_ARGB_8888);
  fill.dst_buf.crop_en = 1;
  fill.dst_buf.crop = rect;
  fill.ctrl = ctrl;
  if (ioctl(ge_fd, IOC_GE_FILLRECT, &fill) < 0) fatal("IOC_GE_FILLRECT");
}

static void ge_bitblt(GBuffer *src, struct mpp_rect src_rect, GBuffer *dst,
                      struct mpp_rect dst_rect, enum mpp_pixel_format format,
                      struct ge_ctrl ctrl) {
  struct ge_bitblt blt;
  memset(&blt, 0, sizeof(blt));
  blt.src_buf = buffer_mpp(src, format);
  blt.src_buf.crop_en = 1;
  blt.src_buf.crop = src_rect;
  blt.dst_buf = buffer_mpp(dst, format);
  blt.dst_buf.crop_en = 1;
  blt.dst_buf.crop = dst_rect;
  blt.ctrl = ctrl;
  if (ioctl(ge_fd, IOC_GE_BITBLT, &blt) < 0) fatal("IOC_GE_BITBLT");
}

static uint32_t *pixel_at(GBuffer *buffer, int x, int y) {
  return buffer->pixels + (size_t)y * (buffer->stride / 4) + x;
}

static void report_pixel(const char *label, GBuffer *buffer, int x, int y) {
  uint32_t value = *pixel_at(buffer, x, y);
  printf("  %-28s (%3d,%3d) = 0x%08x  A=%02x R=%02x G=%02x B=%02x\n", label, x, y, value,
         (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

/* The software rasterizer's straight-alpha source-over, per channel. */
static uint32_t software_src_over(uint32_t src, uint32_t dst) {
  uint32_t sa = (src >> 24) & 0xff;
  uint32_t out = 0xff000000u;
  for (int shift = 0; shift < 24; shift += 8) {
    uint32_t s = (src >> shift) & 0xff;
    uint32_t d = (dst >> shift) & 0xff;
    out |= (((s * sa + d * (255 - sa) + 127) / 255) & 0xff) << shift;
  }
  return out;
}

static double time_fill(GBuffer *dst, struct mpp_rect rect, int iterations) {
  struct ge_ctrl ctrl;
  memset(&ctrl, 0, sizeof(ctrl));
  uint64_t start = now_ns();
  for (int i = 0; i < iterations; i++) {
    ge_fillrect(dst, rect, GE_NO_GRADIENT, 0xff204060, 0, ctrl);
  }
  return (double)(now_ns() - start) / iterations / 1000.0;
}

static double time_blit(GBuffer *src, GBuffer *dst, int iterations) {
  struct ge_ctrl ctrl;
  memset(&ctrl, 0, sizeof(ctrl));
  struct mpp_rect whole = {0, 0, src->width, src->height};
  struct mpp_rect target = {0, 0, src->width, src->height};
  uint64_t start = now_ns();
  for (int i = 0; i < iterations; i++) {
    ge_bitblt(src, whole, dst, target, MPP_FMT_ARGB_8888, ctrl);
  }
  return (double)(now_ns() - start) / iterations / 1000.0;
}

static double time_blit_scale(GBuffer *src, GBuffer *dst, int iterations) {
  struct ge_ctrl ctrl;
  memset(&ctrl, 0, sizeof(ctrl));
  struct mpp_rect whole = {0, 0, src->width, src->height};
  struct mpp_rect target = {128, 0, 128, 128};
  uint64_t start = now_ns();
  for (int i = 0; i < iterations; i++) {
    ge_bitblt(src, whole, dst, target, MPP_FMT_ARGB_8888, ctrl);
  }
  return (double)(now_ns() - start) / iterations / 1000.0;
}

int main(int argc, char **argv) {
  int framebuffer_test = argc > 1 && strcmp(argv[1], "--fb") == 0;

  ge_fd = open(GE_DEVICE, O_RDWR | O_CLOEXEC);
  if (ge_fd < 0) fatal("open /dev/ge");
  heap_fd = open(HEAP_DEVICE, O_RDWR | O_CLOEXEC);
  if (heap_fd < 0) fatal("open dma-heap");

  unsigned int version = 0;
  enum ge_mode mode = GE_MODE_NORMAL;
  if (ioctl(ge_fd, IOC_GE_VERSION, &version) < 0) fatal("IOC_GE_VERSION");
  if (ioctl(ge_fd, IOC_GE_MODE, &mode) < 0) fatal("IOC_GE_MODE");
  printf("ge-probe: version=0x%x (v%u.%u) mode=%s\n", version, (version >> 16) & 0xff,
         version & 0xff, mode == GE_MODE_NORMAL ? "normal" : "cmdq");

  GBuffer *dst = buffer_allocate(256, 256, MPP_FMT_ARGB_8888);
  GBuffer *src = buffer_allocate(64, 64, MPP_FMT_ARGB_8888);
  buffer_fill_cpu(dst, 0xff000000);
  for (int y = 0; y < src->height; y++) {
    uint32_t *row = src->pixels + (size_t)y * (src->stride / 4);
    for (int x = 0; x < src->width; x++) row[x] = 0xff000000u | ((uint32_t)y << 8) | (uint32_t)x;
  }

  struct ge_ctrl plain;
  memset(&plain, 0, sizeof(plain));

  printf("\n[fillrect solid]\n");
  ge_fillrect(dst, (struct mpp_rect){10, 20, 100, 50}, GE_NO_GRADIENT, 0x80112233, 0, plain);
  report_pixel("inside", dst, 60, 40);
  report_pixel("outside", dst, 5, 5);

  printf("\n[fillrect H gradient]\n");
  ge_fillrect(dst, (struct mpp_rect){0, 128, 256, 32}, GE_H_LINEAR_GRADIENT, 0xffff0000,
              0xff0000ff, plain);
  report_pixel("start", dst, 0, 144);
  report_pixel("middle", dst, 128, 144);
  report_pixel("end", dst, 255, 144);

  printf("\n[fillrect V gradient]\n");
  ge_fillrect(dst, (struct mpp_rect){0, 170, 64, 64}, GE_V_LINEAR_GRADIENT, 0xff00ff00,
              0xffffffff, plain);
  report_pixel("start", dst, 32, 170);
  report_pixel("end", dst, 32, 233);

  printf("\n[bitblt copy + scale]\n");
  ge_bitblt(src, (struct mpp_rect){0, 0, 64, 64}, dst, (struct mpp_rect){0, 0, 64, 64},
            MPP_FMT_ARGB_8888, plain);
  report_pixel("copy origin", dst, 0, 0);
  report_pixel("copy corner", dst, 63, 63);
  ge_bitblt(src, (struct mpp_rect){0, 0, 64, 64}, dst, (struct mpp_rect){128, 0, 128, 128},
            MPP_FMT_ARGB_8888, plain);
  report_pixel("scale origin", dst, 128, 0);
  report_pixel("scale middle", dst, 192, 64);
  report_pixel("scale corner", dst, 255, 127);

  printf("\n[alpha: global 128 src-over]\n");
  buffer_fill_cpu(dst, 0xff000000);
  GBuffer *flat = buffer_allocate(64, 64, MPP_FMT_ARGB_8888);
  buffer_fill_cpu(flat, 0xff808080);
  struct ge_ctrl alpha;
  memset(&alpha, 0, sizeof(alpha));
  alpha.alpha_en = 1;
  alpha.alpha_rules = GE_PD_SRC_OVER;
  alpha.src_alpha_mode = 1;
  alpha.src_global_alpha = 128;
  ge_bitblt(flat, (struct mpp_rect){0, 0, 64, 64}, dst, (struct mpp_rect){0, 0, 64, 64},
            MPP_FMT_ARGB_8888, alpha);
  uint32_t expected = software_src_over(0x80808080u, 0xff000000u);
  uint32_t actual = *pixel_at(dst, 32, 32);
  printf("  expected=0x%08x actual=0x%08x delta=%d\n", expected, actual,
         (int)((actual & 0xff) - (expected & 0xff)));

  printf("\n[alpha: pixel 128 src-over]\n");
  buffer_fill_cpu(dst, 0xffffffff);
  GBuffer *half = buffer_allocate(64, 64, MPP_FMT_ARGB_8888);
  buffer_fill_cpu(half, 0x80000000);
  memset(&alpha, 0, sizeof(alpha));
  alpha.alpha_en = 1;
  alpha.alpha_rules = GE_PD_SRC_OVER;
  alpha.src_alpha_mode = 0;
  ge_bitblt(half, (struct mpp_rect){0, 0, 64, 64}, dst, (struct mpp_rect){0, 0, 64, 64},
            MPP_FMT_ARGB_8888, alpha);
  expected = software_src_over(0x80000000u, 0xffffffffu);
  actual = *pixel_at(dst, 32, 32);
  printf("  expected=0x%08x actual=0x%08x delta=%d\n", expected, actual,
         (int)((actual >> 16 & 0xff) - (expected >> 16 & 0xff)));

  printf("\n[alpha matrix: bitblt 64x64 over opaque black]\n");
  struct AlphaCase {
    const char *name;
    unsigned int mode;
    unsigned int global;
    enum ge_pd_rules rules;
    uint32_t src;
    int alpha_en;
    unsigned int dst_global;
    int premultiply_src;
  } cases[] = {
    {"none pixel", 0, 0, GE_PD_NONE, 0x80402010u, 1, 0, 0},
    {"none pixel dstOpaque", 0, 0, GE_PD_NONE, 0x80402010u, 1, 255, 0},
    {"none global128", 1, 128, GE_PD_NONE, 0xff808080u, 1, 0, 0},
    {"none global128 dstOpaque", 1, 128, GE_PD_NONE, 0xff808080u, 1, 255, 0},
    {"mixed128", 2, 128, GE_PD_NONE, 0x80402010u, 1, 255, 0},
    {"srcover premul src", 0, 0, GE_PD_SRC_OVER, 0u, 1, 255, 1},
  };
  GBuffer *probe_src = buffer_allocate(64, 64, MPP_FMT_ARGB_8888);
  for (unsigned int c = 0; c < sizeof(cases) / sizeof(cases[0]); c++) {
    buffer_fill_cpu(dst, 0xff000000);
    uint32_t source = cases[c].src;
    uint32_t want_rgb;
    if (cases[c].premultiply_src) {
      uint32_t sa = (source >> 24) & 0xff;
      want_rgb = 0;
      source = 0xff000000u;
      for (int shift = 0; shift < 24; shift += 8) {
        uint32_t premultiplied = (((cases[c].src >> shift) & 0xff) * sa / 255) & 0xff;
        source |= premultiplied << shift;
        want_rgb |= premultiplied << shift;
      }
    } else {
      want_rgb = software_src_over(cases[c].src, 0xff000000u) & 0x00ffffffu;
    }
    buffer_fill_cpu(probe_src, source);
    struct ge_ctrl ctrl;
    memset(&ctrl, 0, sizeof(ctrl));
    ctrl.alpha_en = cases[c].alpha_en;
    ctrl.alpha_rules = cases[c].rules;
    ctrl.src_alpha_mode = cases[c].mode;
    ctrl.src_global_alpha = cases[c].global;
    if (cases[c].dst_global != 0) {
      ctrl.dst_alpha_mode = 1;
      ctrl.dst_global_alpha = cases[c].dst_global;
    }
    ge_bitblt(probe_src, (struct mpp_rect){0, 0, 64, 64}, dst, (struct mpp_rect){0, 0, 64, 64},
              MPP_FMT_ARGB_8888, ctrl);
    uint32_t got = *pixel_at(dst, 32, 32);
    int rgb_match = (want_rgb & 0x00ffffffu) == (got & 0x00ffffffu);
    printf("  %-24s wantRGB=0x%06x got=0x%08x %s\n", cases[c].name, want_rgb, got,
           rgb_match ? "rgb-exact" : "RGB-DIFF");
  }

  printf("\n[fillrect alpha]\n");
  buffer_fill_cpu(dst, 0xff000000);
  struct ge_ctrl fill_alpha;
  memset(&fill_alpha, 0, sizeof(fill_alpha));
  fill_alpha.alpha_en = 1;
  fill_alpha.alpha_rules = GE_PD_NONE;
  fill_alpha.src_alpha_mode = 0;
  ge_fillrect(dst, (struct mpp_rect){0, 0, 64, 64}, GE_NO_GRADIENT, 0x80402010u, 0, fill_alpha);
  actual = *pixel_at(dst, 32, 32);
  printf("  none pixel         expected=0xff201008 actual=0x%08x %s\n", actual,
         (actual & 0x00ffffffu) == 0x00201008u ? "rgb-exact" : "RGB-DIFF");
  buffer_fill_cpu(dst, 0xff000000);
  memset(&fill_alpha, 0, sizeof(fill_alpha));
  ge_fillrect(dst, (struct mpp_rect){0, 0, 64, 64}, GE_NO_GRADIENT, 0x80402010u, 0, fill_alpha);
  actual = *pixel_at(dst, 32, 32);
  printf("  alpha_en=0 raw     expected=0x80402010 actual=0x%08x\n", actual);

  printf("\n[gradient with alpha]\n");
  buffer_fill_cpu(dst, 0xff000000);
  ge_fillrect(dst, (struct mpp_rect){0, 0, 64, 8}, GE_H_LINEAR_GRADIENT, 0x80ff0000u,
              0x800000ffu, fill_alpha);
  report_pixel("grad start", dst, 0, 4);
  report_pixel("grad middle", dst, 32, 4);
  report_pixel("grad end", dst, 63, 4);

  printf("\n[cpu baselines into the same dma-buf]\n");
  GBuffer *full = buffer_allocate(800, 480, MPP_FMT_ARGB_8888);
  {
    uint64_t start = now_ns();
    for (int i = 0; i < 500; i++) {
      for (int y = 0; y < 100; y++) {
        uint32_t *row = dst->pixels + (size_t)y * (dst->stride / 4);
        for (int x = 0; x < 200; x++) row[x] = 0xff204060u;
      }
    }
    printf("  cpu fill 200x100   %8.1f us/op\n", (double)(now_ns() - start) / 500 / 1000.0);
  }
  {
    uint64_t start = now_ns();
    for (int i = 0; i < 500; i++) {
      for (int y = 0; y < 480; y++) {
        uint32_t *row = full->pixels + (size_t)y * (full->stride / 4);
        for (int x = 0; x < 800; x++) row[x] = 0xff204060u;
      }
    }
    printf("  cpu fill 800x480   %8.1f us/op\n", (double)(now_ns() - start) / 500 / 1000.0);
  }
  {
    uint64_t start = now_ns();
    for (int i = 0; i < 500; i++) {
      for (int y = 0; y < 64; y++) {
        memcpy(dst->pixels + (size_t)y * (dst->stride / 4),
               src->pixels + (size_t)y * (src->stride / 4), 64 * 4);
      }
    }
    printf("  cpu copy 64x64     %8.1f us/op\n", (double)(now_ns() - start) / 500 / 1000.0);
  }

  printf("\n[timings]\n");
  printf("  fill %-10s %8.1f us/op\n", "1x1", time_fill(dst, (struct mpp_rect){0, 0, 1, 1}, 1000));
  printf("  fill %-10s %8.1f us/op\n", "8x8", time_fill(dst, (struct mpp_rect){0, 0, 8, 8}, 1000));
  printf("  fill %-10s %8.1f us/op\n", "64x64", time_fill(dst, (struct mpp_rect){0, 0, 64, 64}, 1000));
  printf("  fill %-10s %8.1f us/op\n", "200x100", time_fill(dst, (struct mpp_rect){0, 0, 200, 100}, 500));
  printf("  fill %-10s %8.1f us/op\n", "800x480", time_fill(full, (struct mpp_rect){0, 0, 800, 480}, 200));
  printf("  blit %-10s %8.1f us/op\n", "64x64", time_blit(src, dst, 1000));
  printf("  blit %-10s %8.1f us/op\n", "64->128", time_blit_scale(src, dst, 1000));

  if (framebuffer_test) {
    printf("\n[framebuffer via AICFB_TO_DMABUF_FD]\n");
    int fb_fd = open(FB_DEVICE, O_RDWR | O_CLOEXEC);
    if (fb_fd < 0) fatal("open /dev/fb0");
    struct fb_var_screeninfo var;
    struct fb_fix_screeninfo fix;
    if (ioctl(fb_fd, FBIOGET_VSCREENINFO, &var) < 0) fatal("FBIOGET_VSCREENINFO");
    if (ioctl(fb_fd, FBIOGET_FSCREENINFO, &fix) < 0) fatal("FBIOGET_FSCREENINFO");
    struct dma_buf_info info;
    memset(&info, 0, sizeof(info));
    if (ioctl(fb_fd, AICFB_TO_DMABUF_FD, &info) < 0) fatal("AICFB_TO_DMABUF_FD");
    printf("  fb dmabuf fd=%d %ux%u stride=%u\n", info.fd, var.xres, var.yres, fix.line_length);

    GBuffer frame;
    memset(&frame, 0, sizeof(frame));
    frame.fd = info.fd;
    frame.width = var.xres;
    frame.height = var.yres;
    frame.stride = fix.line_length;

    ge_fillrect(&frame, (struct mpp_rect){0, 0, 400, 240}, GE_NO_GRADIENT, 0xffe03030, 0, plain);
    ge_fillrect(&frame, (struct mpp_rect){400, 0, 400, 240}, GE_NO_GRADIENT, 0xff30c040, 0, plain);
    ge_fillrect(&frame, (struct mpp_rect){0, 240, 400, 240}, GE_NO_GRADIENT, 0xff2040e0, 0, plain);
    ge_fillrect(&frame, (struct mpp_rect){400, 240, 400, 240}, GE_H_LINEAR_GRADIENT,
                0xffffffff, 0xff101010, plain);
    printf("  pattern drawn\n");
    close(info.fd);
    close(fb_fd);
  }

  buffer_free(flat);
  buffer_free(half);
  buffer_free(probe_src);
  buffer_free(src);
  buffer_free(dst);
  buffer_free(full);
  close(heap_fd);
  close(ge_fd);
  printf("\nge-probe: done\n");
  return 0;
}
