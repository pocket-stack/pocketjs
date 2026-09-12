/*
 * d211 audio host module: PocketAudioOps table accessor.
 * See audio.c for the implementation notes.
 */

#ifndef D211_AUDIO_H
#define D211_AUDIO_H

#include "pocket_runtime.h"

/** 取音频 ops 表（装入运行时前调用 pocket_runtime_set_audio_ops）。 */
const PocketAudioOps *d211_audio_ops_table(void);

#endif
