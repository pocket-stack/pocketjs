#define _GNU_SOURCE

#include "input.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int bit_is_set(const unsigned long *bits, int bit) {
  return (int)((bits[bit / (int)(8 * sizeof(unsigned long))] >>
                (bit % (int)(8 * sizeof(unsigned long)))) &
               1UL);
}

static int read_axis_max(int fd, int axis) {
  struct input_absinfo info;
  if (ioctl(fd, EVIOCGABS(axis), &info) < 0) return 0;
  return info.maximum > 0 ? info.maximum : 0;
}

/* Returns 1 when `fd` is a usable touch device and fills `input`. */
static int probe_device(int fd, D211Input *input) {
  char name[64] = {0};
  if (ioctl(fd, EVIOCGNAME(sizeof(name) - 1), name) < 0) return 0;

  unsigned long abs_bits[(ABS_MAX + 1 + 8 * sizeof(unsigned long) - 1) /
                         (8 * sizeof(unsigned long))];
  memset(abs_bits, 0, sizeof(abs_bits));
  if (ioctl(fd, EVIOCGBIT(EV_ABS, sizeof(abs_bits)), abs_bits) < 0) return 0;

  unsigned long key_bits[(KEY_MAX + 1 + 8 * sizeof(unsigned long) - 1) /
                         (8 * sizeof(unsigned long))];
  memset(key_bits, 0, sizeof(key_bits));
  if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(key_bits)), key_bits) < 0) return 0;

  int axis_x = -1;
  int axis_y = -1;
  int multi_touch = 0;
  if (bit_is_set(abs_bits, ABS_MT_POSITION_X) &&
      bit_is_set(abs_bits, ABS_MT_POSITION_Y)) {
    axis_x = ABS_MT_POSITION_X;
    axis_y = ABS_MT_POSITION_Y;
    multi_touch = 1;
  } else if (bit_is_set(abs_bits, ABS_X) && bit_is_set(abs_bits, ABS_Y) &&
             bit_is_set(key_bits, BTN_TOUCH)) {
    axis_x = ABS_X;
    axis_y = ABS_Y;
  }
  if (axis_x < 0) return 0;

  int max_x = read_axis_max(fd, axis_x);
  int max_y = read_axis_max(fd, axis_y);
  if (max_x <= 0 || max_y <= 0) return 0;

  snprintf(input->name, sizeof(input->name), "%s", name);
  input->fd = fd;
  input->axis_x = axis_x;
  input->axis_y = axis_y;
  input->max_x = max_x;
  input->max_y = max_y;
  input->multi_touch = multi_touch;
  input->slot_axis = bit_is_set(abs_bits, ABS_MT_SLOT) ? ABS_MT_SLOT : -1;
  input->tracking_axis =
    bit_is_set(abs_bits, ABS_MT_TRACKING_ID) ? ABS_MT_TRACKING_ID : -1;
  return 1;
}

int d211_input_open(D211Input *input) {
  memset(input, 0, sizeof(*input));
  input->fd = -1;

  DIR *directory = opendir("/dev/input");
  if (directory == 0) return 0;

  int selected = -1;
  struct dirent *entry;
  while ((entry = readdir(directory)) != 0) {
    if (strncmp(entry->d_name, "event", 5) != 0) continue;
    char path[sizeof(entry->d_name) + 16];
    if (snprintf(path, sizeof(path), "/dev/input/%s", entry->d_name) >=
        (int)sizeof(path)) {
      continue;
    }
    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) continue;
    if (probe_device(fd, input)) {
      selected = fd;
      break;
    }
    close(fd);
  }
  closedir(directory);
  return selected >= 0;
}

void d211_input_close(D211Input *input) {
  if (input->fd >= 0) close(input->fd);
  input->fd = -1;
}

static int clamp_slot(int slot) {
  if (slot < 0) return 0;
  if (slot >= D211_MAX_CONTACTS) return D211_MAX_CONTACTS - 1;
  return slot;
}

unsigned int d211_input_pump(D211Input *input, D211ContactState *state) {
  state->count = 0;
  if (input->fd < 0) return 0;

  struct input_event event;
  for (;;) {
    ssize_t bytes = read(input->fd, &event, sizeof(event));
    if (bytes < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      if (errno == EINTR) continue;
      break;
    }
    if (bytes != (ssize_t)sizeof(event)) break;

    if (event.type == EV_ABS) {
      if (input->multi_touch) {
        int slot = input->current_slot;
        if (input->slot_axis >= 0 && event.code == input->slot_axis) {
          input->current_slot = clamp_slot(event.value);
          continue;
        }
        if (event.code == input->axis_x) {
          input->slot_x[slot] = event.value;
        } else if (event.code == input->axis_y) {
          input->slot_y[slot] = event.value;
        } else if (input->tracking_axis >= 0 &&
                   event.code == input->tracking_axis) {
          if (event.value >= 0) {
            if (!input->slot_active[slot]) {
              input->slot_active[slot] = 1;
              input->slot_pending_down[slot] = 1;
            }
          } else {
            input->slot_active[slot] = 0;
          }
        }
      } else if (event.code == input->axis_x) {
        input->single_x = event.value;
      } else if (event.code == input->axis_y) {
        input->single_y = event.value;
      }
    } else if (event.type == EV_KEY && event.code == BTN_TOUCH) {
      if (!input->multi_touch) {
        if (event.value != 0) {
          if (!input->single_down) {
            input->single_down = 1;
            input->single_pending_down = 1;
          }
        } else {
          input->single_down = 0;
        }
      } else if (input->tracking_axis < 0) {
        /* Slot protocol without tracking ids: BTN_TOUCH owns the slot. */
        int slot = input->current_slot;
        if (event.value != 0) {
          if (!input->slot_active[slot]) {
            input->slot_active[slot] = 1;
            input->slot_pending_down[slot] = 1;
          }
        } else {
          input->slot_active[slot] = 0;
        }
      }
    }
  }

  unsigned int down_mask = 0;
  if (input->multi_touch) {
    for (int slot = 0; slot < D211_MAX_CONTACTS; slot++) {
      if (!input->slot_active[slot]) continue;
      int index = state->count++;
      state->contacts[index].id = slot;
      state->contacts[index].x = input->slot_x[slot];
      state->contacts[index].y = input->slot_y[slot];
      if (input->slot_pending_down[slot]) {
        down_mask |= 1u << index;
        input->slot_pending_down[slot] = 0;
      }
    }
  } else if (input->single_down) {
    state->contacts[0].id = 0;
    state->contacts[0].x = input->single_x;
    state->contacts[0].y = input->single_y;
    state->count = 1;
    if (input->single_pending_down) {
      down_mask = 1u;
      input->single_pending_down = 0;
    }
  }
  return down_mask;
}
