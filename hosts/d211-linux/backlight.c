/*
 * d211 backlight module: percent <-> /sys/class/backlight/<name>/brightness.
 *
 * The panel exposes a 0..max_brightness scale (10 on this device); the guest
 * API is percent 0-100, mapped here. Reading is cached for max_brightness so
 * set() is one write.
 */

#include "backlight.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>

static char brightness_path[512];
static char max_path[512];
static int max_brightness;
static int discovered;

/** 发现背光节点与最大亮度（只执行一次）。 */
static void discover(void) {
  DIR *directory;
  struct dirent *entry;
  if (discovered) return;
  discovered = 1;
  directory = opendir("/sys/class/backlight");
  if (directory == 0) return;
  while ((entry = readdir(directory)) != 0) {
    if (entry->d_name[0] == '.') continue;
    snprintf(brightness_path, sizeof(brightness_path),
             "/sys/class/backlight/%s/brightness", entry->d_name);
    snprintf(max_path, sizeof(max_path),
             "/sys/class/backlight/%s/max_brightness", entry->d_name);
    FILE *file = fopen(max_path, "r");
    if (file == 0) continue;
    if (fscanf(file, "%d", &max_brightness) != 1 || max_brightness <= 0) {
      max_brightness = 0;
      fclose(file);
      continue;
    }
    fclose(file);
    break;
  }
  closedir(directory);
}

/** 读取当前亮度（0-100）；无背光节点返回 -1。 */
static int d211_backlight_get(void) {
  int value = 0;
  discover();
  if (max_brightness <= 0) return -1;
  FILE *file = fopen(brightness_path, "r");
  if (file == 0) return -1;
  if (fscanf(file, "%d", &value) != 1) value = 0;
  fclose(file);
  int percent = (int)((long)value * 100 / max_brightness);
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  return percent;
}

/** 写入百分比亮度（0-100，越界夹取）。 */
static void d211_backlight_set(int percent) {
  discover();
  if (max_brightness <= 0) return;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  int value = (int)((long)percent * max_brightness / 100);
  FILE *file = fopen(brightness_path, "w");
  if (file == 0) return;
  fprintf(file, "%d", value);
  fclose(file);
}

/** 宿主背光 ops 表。 */
static const PocketBacklightOps d211_backlight_ops = {
  .get = d211_backlight_get,
  .set = d211_backlight_set,
};

/** 取背光 ops 表。 */
const PocketBacklightOps *d211_backlight_ops_table(void) {
  return &d211_backlight_ops;
}
