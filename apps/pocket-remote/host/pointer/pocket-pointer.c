// SPDX-License-Identifier: GPL-3.0-or-later
// pocket-pointer.c — a virtual pointer for the Pocket Remote daemon.
//
// The remote's trackpad needs a mouse the compositor believes in: relative
// motion, buttons, finger scrolling. Hyprland has no dispatcher for a click
// and nothing in Omarchy's repositories drives a pointer from a script, but
// Hyprland speaks zwlr_virtual_pointer_v1, so this is a client of that
// protocol and nothing else — no uinput, no root, no daemon of its own.
//
// It reads one command per line on stdin and forwards it as pointer events:
//
//   m <dx> <dy>      relative motion, logical px (fractions allowed)
//   b <code> <0|1>   button release / press (272 left, 273 right, 274 middle)
//   s <dy> <dx>      finger scroll, in px of travel
//   e                the scroll gesture ended (axis_stop)
//
// It prints "ready" once the pointer exists, then says nothing. The daemon
// (host/serve.ts) keeps one running for as long as it lives and restarts it
// if it dies. Built on the Omarchy machine at deploy time by
// `bun tools/pocket-remote.ts deploy-host` with wayland-scanner and cc.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wayland-client.h>

#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct zwlr_virtual_pointer_manager_v1 *manager;
static struct wl_seat *seat;

static void registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface,
                            uint32_t version) {
  (void)data;
  if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
    manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, version < 2 ? version : 2);
  } else if (strcmp(interface, wl_seat_interface.name) == 0 && !seat) {
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  }
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener registry_listener = {registry_global, registry_global_remove};

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

int main(void) {
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) {
    fprintf(stderr, "pocket-pointer: no Wayland display (is WAYLAND_DISPLAY set?)\n");
    return 2;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!manager) {
    fprintf(stderr, "pocket-pointer: the compositor does not offer zwlr_virtual_pointer_manager_v1\n");
    return 3;
  }
  struct zwlr_virtual_pointer_v1 *pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, seat);
  wl_display_roundtrip(display);
  printf("ready\n");
  fflush(stdout);

  char line[256];
  unsigned commands = 0;
  while (fgets(line, sizeof line, stdin)) {
    double a = 0;
    double b = 0;
    unsigned code = 0;
    unsigned state = 0;
    uint32_t t = now_ms();
    if (sscanf(line, "m %lf %lf", &a, &b) == 2) {
      zwlr_virtual_pointer_v1_motion(pointer, t, wl_fixed_from_double(a), wl_fixed_from_double(b));
      zwlr_virtual_pointer_v1_frame(pointer);
    } else if (sscanf(line, "b %u %u", &code, &state) == 2) {
      zwlr_virtual_pointer_v1_button(pointer, t, code,
                                     state ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
      zwlr_virtual_pointer_v1_frame(pointer);
    } else if (sscanf(line, "s %lf %lf", &a, &b) == 2) {
      zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_FINGER);
      if (a != 0) zwlr_virtual_pointer_v1_axis(pointer, t, WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_double(a));
      if (b != 0) zwlr_virtual_pointer_v1_axis(pointer, t, WL_POINTER_AXIS_HORIZONTAL_SCROLL, wl_fixed_from_double(b));
      zwlr_virtual_pointer_v1_frame(pointer);
    } else if (line[0] == 'e') {
      zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_FINGER);
      zwlr_virtual_pointer_v1_axis_stop(pointer, t, WL_POINTER_AXIS_VERTICAL_SCROLL);
      zwlr_virtual_pointer_v1_axis_stop(pointer, t, WL_POINTER_AXIS_HORIZONTAL_SCROLL);
      zwlr_virtual_pointer_v1_frame(pointer);
    } else {
      continue;
    }
    wl_display_flush(display);
    // The pointer never receives events, but the seat does; drain the
    // socket now and then so the compositor's side cannot fill up.
    if ((++commands & 63) == 0) wl_display_roundtrip(display);
  }

  zwlr_virtual_pointer_v1_destroy(pointer);
  wl_display_flush(display);
  wl_display_disconnect(display);
  return 0;
}
