/*
 * d211 backlight host module: PocketBacklightOps table accessor.
 * The sysfs node is discovered once (first /sys/class/backlight entry).
 */

#ifndef D211_BACKLIGHT_H
#define D211_BACKLIGHT_H

#include "pocket_runtime.h"

/** 取背光 ops 表（装入运行时前调用 pocket_runtime_set_backlight_ops）。 */
const PocketBacklightOps *d211_backlight_ops_table(void);

#endif
