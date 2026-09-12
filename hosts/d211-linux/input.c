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
  if (bit_is_set(abs_bits, ABS_MT_POSITION_X) &&
      bit_is_set(abs_bits, ABS_MT_POSITION_Y)) {
    axis_x = ABS_MT_POSITION_X;
    axis_y = ABS_MT_POSITION_Y;
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

int d211_input_pump(D211Input *input) {
  if (input->fd < 0) return 0;

  int saw_down = 0;
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
      if (event.code == input->axis_x) {
        input->x = event.value;
        input->have_position = 1;
      } else if (event.code == input->axis_y) {
        input->y = event.value;
        input->have_position = 1;
      } else if (event.code == ABS_MT_TRACKING_ID) {
        if (event.value >= 0) {
          if (!input->down) {
            input->down = 1;
            saw_down = 1;
          }
        } else {
          input->down = 0;
        }
      }
    } else if (event.type == EV_KEY && event.code == BTN_TOUCH) {
      if (event.value != 0) {
        if (!input->down) {
          input->down = 1;
          saw_down = 1;
        }
      } else {
        input->down = 0;
      }
    }
  }
  return saw_down;
}
