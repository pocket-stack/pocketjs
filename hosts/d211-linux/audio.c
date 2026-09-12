/*
 * d211 audio module: PocketAudioOps on top of a native audio clock.
 *
 * The device has ALSA (aplay) but no audio daemon; short UI sounds are the
 * product's whole need, so a stream owns one `aplay -t raw` child and a
 * feeder thread that moves PCM from a frame ring into the child's stdin.
 * The guest sees the spec's credit discipline: every consumed chunk queues a
 * credit line, starvation queues one underrun per episode, and endStream
 * drains then queues ended. Volume is a soft gain applied while feeding, so
 * no mixer state leaks into the system.
 */

#include "audio.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define D211_AUDIO_MAX_STREAMS 2
#define D211_AUDIO_RING_FRAMES 16384
#define D211_AUDIO_EVENTS 32
#define D211_AUDIO_FEED_CHUNK 512

typedef struct {
  int used;
  unsigned int rate;
  unsigned int channels;
  double volume;
  int playing;
  int ended;
  int pid;
  int fd;
  int16_t *ring;
  unsigned int head;
  unsigned int tail;
  unsigned int count;
  pthread_t feeder;
  int feeder_running;
  int underrun_active;
  pthread_mutex_t lock;
  pthread_cond_t cond;
  char events[D211_AUDIO_EVENTS][64];
  int event_head;
  int event_tail;
  /* credit 按“占用变化”合并上报：用变化序号而不是占用量本身比较——
     占用可能在一批内先增后减回到旧值，只比值会丢掉这次变化，guest 的
     免费帧镜像就再也恢复不了。写与消费都递增序号。 */
  unsigned int change_seq;
  unsigned int reported_seq;
  /* 设备时钟节拍：feeder 按采样率放行数据，避免把整个剪辑预灌进 aplay
     管道（那样 ring 会瞬间排空，ended 远早于真实播放结束）。 */
  unsigned long long next_write_ns;
} D211AudioStream;

static D211AudioStream streams[D211_AUDIO_MAX_STREAMS];

/** 支持的采样率（与 contracts/spec/audio.ts 的 AUDIO_RATES 一致）。 */
static int rate_supported(unsigned int rate) {
  return rate == 44100 || rate == 22050 || rate == 11025;
}

/** 入队一条事件（JSON 行，形状见 audio 规范）。 */
static void queue_event(D211AudioStream *stream, const char *format, int value, unsigned int free_frames) {
  int slot = stream->event_tail;
  if ((slot + 1) % D211_AUDIO_EVENTS == stream->event_head) return; /* 队列满丢弃 */
  if (strcmp(format, "credit") == 0) {
    snprintf(stream->events[slot], sizeof(stream->events[slot]),
             "{\"t\":\"credit\",\"h\":%d,\"free\":%u}", value, free_frames);
  } else {
    snprintf(stream->events[slot], sizeof(stream->events[slot]), "{\"t\":\"%s\",\"h\":%d}", format, value);
  }
  stream->event_tail = (slot + 1) % D211_AUDIO_EVENTS;
}

/** 启动 aplay 子进程（raw PCM 从管道读入）。 */
static int spawn_aplay(D211AudioStream *stream) {
  int pipe_fds[2];
  if (pipe(pipe_fds) != 0) return -1;
  pid_t pid = fork();
  if (pid < 0) {
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    return -1;
  }
  if (pid == 0) {
    char rate[16];
    char channels[8];
    snprintf(rate, sizeof(rate), "%u", stream->rate);
    snprintf(channels, sizeof(channels), "%u", stream->channels);
    dup2(pipe_fds[0], STDIN_FILENO);
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) {
      dup2(devnull, STDOUT_FILENO);
      dup2(devnull, STDERR_FILENO);
      close(devnull);
    }
    /* 小缓冲（150ms）让“ring 排空”与真实播放结束对齐；默认缓冲约 1 秒，
       会让 endStream 提前触发，循环语音被截短。 */
    execl("/usr/bin/aplay", "aplay", "-q", "-t", "raw", "-f", "S16_LE",
          "-r", rate, "-c", channels,
          "--buffer-time=150000", "--period-time=50000",
          "-", (char *)0);
    _exit(127);
  }
  close(pipe_fds[0]);
  stream->pid = (int)pid;
  stream->fd = pipe_fds[1];
  return 0;
}

/** 停止并回收 aplay 子进程。 */
static void kill_aplay(D211AudioStream *stream) {
  if (stream->fd >= 0) {
    close(stream->fd);
    stream->fd = -1;
  }
  if (stream->pid > 0) {
    kill(stream->pid, SIGKILL);
    waitpid(stream->pid, 0, 0);
    stream->pid = -1;
  }
}

/** 喂给 aplay 的块（含软音量）。 */
static int16_t feed_buffer[D211_AUDIO_FEED_CHUNK * 2];

/** feeder 线程：把 ring 里的帧写进 aplay，并按消费量发 credit。 */
/** 单调时钟（纳秒）。 */
static unsigned long long monotonic_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (unsigned long long)ts.tv_sec * 1000000000ull + (unsigned long long)ts.tv_nsec;
}

static void *feeder_main(void *argument) {
  D211AudioStream *stream = (D211AudioStream *)argument;
  for (;;) {
    unsigned int frames;
    pthread_mutex_lock(&stream->lock);
    while (stream->count == 0 && stream->playing && !stream->ended) {
      if (!stream->underrun_active) {
        stream->underrun_active = 1;
        queue_event(stream, "underrun", (int)(stream - streams), 0);
      }
      pthread_cond_wait(&stream->cond, &stream->lock);
    }
    if (!stream->playing && !stream->ended) {
      pthread_mutex_unlock(&stream->lock);
      break;
    }
    if (stream->count == 0 && stream->ended) {
      stream->playing = 0;
      stream->ended = 0;
      queue_event(stream, "ended", (int)(stream - streams), 0);

      pthread_mutex_unlock(&stream->lock);
      break;
    }
    frames = stream->count < D211_AUDIO_FEED_CHUNK ? stream->count : D211_AUDIO_FEED_CHUNK;
    for (unsigned int index = 0; index < frames * stream->channels; index += 1) {
      int16_t sample = stream->ring[stream->head * stream->channels + index];
      if (stream->volume < 1.0) {
        sample = (int16_t)((double)sample * stream->volume);
      }
      feed_buffer[index] = sample;
    }
    stream->head = (stream->head + frames) % D211_AUDIO_RING_FRAMES;
    stream->count -= frames;
    stream->change_seq += 1;
    stream->underrun_active = 0;
    pthread_mutex_unlock(&stream->lock);

    /* 设备时钟节拍：每块按采样率放行（最多提前 2 块），aplay 的缓冲维持在
       小块级别，ended 与真实播放结束对齐。 */
    unsigned long long now = monotonic_ns();
    if (stream->next_write_ns != 0 && stream->next_write_ns > now + 100000000ull) {
      struct timespec until;
      until.tv_sec = (time_t)(stream->next_write_ns / 1000000000ull);
      until.tv_nsec = (long)(stream->next_write_ns % 1000000000ull);
      clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &until, 0);
      now = monotonic_ns();
    }
    unsigned long long step = (unsigned long long)frames * 1000000000ull / stream->rate;
    stream->next_write_ns = (stream->next_write_ns == 0 ? now : stream->next_write_ns) + step;

    size_t bytes = (size_t)frames * stream->channels * sizeof(int16_t);
    const uint8_t *cursor = (const uint8_t *)feed_buffer;
    while (bytes > 0) {
      ssize_t written = write(stream->fd, cursor, bytes);
      if (written <= 0) {
        if (errno == EINTR) continue;
        break;
      }
      cursor += written;
      bytes -= (size_t)written;
    }
  }
  stream->feeder_running = 0;
  return 0;
}

/** 分配流句柄；不合法返回 -1。 */
static int d211_audio_create_stream(unsigned int sample_rate, unsigned int channels) {
  if (!rate_supported(sample_rate) || (channels != 1 && channels != 2)) {
    fprintf(stderr, "d211: audio createStream refused rate=%u ch=%u\n", sample_rate, channels);
    return -1;
  }
  for (int index = 0; index < D211_AUDIO_MAX_STREAMS; index += 1) {
    D211AudioStream *stream = &streams[index];
    if (stream->used) continue;
    stream->used = 1;
    stream->rate = sample_rate;
    stream->channels = channels;
    stream->volume = 1.0;
    stream->playing = 0;
    stream->ended = 0;
    stream->pid = -1;
    stream->fd = -1;
    stream->head = 0;
    stream->tail = 0;
    stream->count = 0;
    stream->feeder_running = 0;
    stream->underrun_active = 0;
    stream->event_head = 0;
    stream->event_tail = 0;
    stream->change_seq = 0;
    stream->reported_seq = 0;
    pthread_mutex_init(&stream->lock, 0);
    pthread_cond_init(&stream->cond, 0);
    stream->ring = malloc(sizeof(int16_t) * D211_AUDIO_RING_FRAMES * channels);
    if (stream->ring == 0) {
      stream->used = 0;
      return -1;
    }
    fprintf(stderr, "d211: audio createStream handle=%d rate=%u ch=%u\n", index, sample_rate, channels);
    return index;
  }
  return -1;
}

/** 停止输出并释放 ring。 */
static void d211_audio_destroy_stream(int handle) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return;

  fprintf(stderr, "d211: audio destroy handle=%d\n", handle);
  D211AudioStream *stream = &streams[handle];
  if (!stream->used) return;
  pthread_mutex_lock(&stream->lock);
  stream->playing = 0;
  pthread_cond_broadcast(&stream->cond);
  pthread_mutex_unlock(&stream->lock);
  if (stream->feeder_running) {
    pthread_join(stream->feeder, 0);
  }
  kill_aplay(stream);
  free(stream->ring);
  stream->ring = 0;
  pthread_cond_destroy(&stream->cond);
  pthread_mutex_destroy(&stream->lock);
  stream->used = 0;
}

/** 写入 PCM；返回接受的帧数。 */
static int d211_audio_write_pcm(int handle, const void *pcm, size_t bytes) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return 0;
  D211AudioStream *stream = &streams[handle];
  if (!stream->used || stream->ring == 0) return 0;
  (void)bytes;
  unsigned int frames = (unsigned int)(bytes / (stream->channels * sizeof(int16_t)));
  const int16_t *samples = (const int16_t *)pcm;
  unsigned int accepted = 0;
  pthread_mutex_lock(&stream->lock);
  while (accepted < frames && stream->count < D211_AUDIO_RING_FRAMES) {
    unsigned int write_index = stream->tail;
    for (unsigned int channel = 0; channel < stream->channels; channel += 1) {
      stream->ring[write_index * stream->channels + channel] =
        samples[accepted * stream->channels + channel];
    }
    stream->tail = (stream->tail + 1) % D211_AUDIO_RING_FRAMES;
    stream->count += 1;
    accepted += 1;
  }
  if (accepted > 0) stream->change_seq += 1;
  pthread_cond_broadcast(&stream->cond);
  pthread_mutex_unlock(&stream->lock);
  return (int)accepted;
}

/** 开始输出（必要时拉起 aplay 与 feeder）。 */
static void d211_audio_play(int handle) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return;
  D211AudioStream *stream = &streams[handle];
  if (!stream->used) return;
  pthread_mutex_lock(&stream->lock);
  if (!stream->playing) {
    stream->playing = 1;
    stream->ended = 0;
    if (stream->pid > 0) {
      kill(stream->pid, SIGCONT);
    }
  }
  int needs_feeder = !stream->feeder_running;
  pthread_mutex_unlock(&stream->lock);
  if (stream->pid < 0 && spawn_aplay(stream) != 0) {
    pthread_mutex_lock(&stream->lock);
    stream->playing = 0;
    pthread_mutex_unlock(&stream->lock);
    return;
  }
  if (needs_feeder) {
    stream->feeder_running = 1;
    pthread_create(&stream->feeder, 0, feeder_main, stream);
  }
  fprintf(stderr, "d211: audio play handle=%d rate=%u ch=%u\n",
          handle, stream->rate, stream->channels);
  pthread_mutex_lock(&stream->lock);
  pthread_cond_broadcast(&stream->cond);
  pthread_mutex_unlock(&stream->lock);
}

/** 暂停输出（SIGSTOP 子进程，ring 保留）。 */
static void d211_audio_pause(int handle) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return;
  fprintf(stderr, "d211: audio pause handle=%d\n", handle);
  D211AudioStream *stream = &streams[handle];
  if (!stream->used) return;
  pthread_mutex_lock(&stream->lock);
  stream->playing = 0;
  pthread_cond_broadcast(&stream->cond);
  pthread_mutex_unlock(&stream->lock);
  if (stream->pid > 0) kill(stream->pid, SIGSTOP);
}

/** 停止并清空 ring。 */
static void d211_audio_stop(int handle) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return;
  fprintf(stderr, "d211: audio stop handle=%d\n", handle);
  D211AudioStream *stream = &streams[handle];
  if (!stream->used) return;
  pthread_mutex_lock(&stream->lock);
  stream->playing = 0;
  stream->ended = 0;
  stream->count = 0;
  stream->head = 0;
  stream->tail = 0;
  pthread_cond_broadcast(&stream->cond);
  pthread_mutex_unlock(&stream->lock);
  kill_aplay(stream);
}

/** 设置软音量（0..1）。 */
static void d211_audio_set_volume(int handle, double volume) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return;
  D211AudioStream *stream = &streams[handle];
  if (!stream->used) return;
  fprintf(stderr, "d211: audio setVolume handle=%d volume=%.2f\n", handle, volume);
  pthread_mutex_lock(&stream->lock);
  stream->volume = volume;
  pthread_mutex_unlock(&stream->lock);
}

/** 标记流结束：ring 排空后自动暂停并上报 ended。 */
static void d211_audio_end_stream(int handle) {
  if (handle < 0 || handle >= D211_AUDIO_MAX_STREAMS) return;


  D211AudioStream *stream = &streams[handle];
  if (!stream->used) return;
  pthread_mutex_lock(&stream->lock);
  if (stream->count == 0) {
    stream->playing = 0;
    queue_event(stream, "ended", handle, 0);
  } else {
    stream->ended = 1;
  }
  pthread_cond_broadcast(&stream->cond);
  pthread_mutex_unlock(&stream->lock);
}

/** 取一条事件（NULL 表示队列空）。 */
static const char *d211_audio_poll(void) {
  static char line[64];
  for (int index = 0; index < D211_AUDIO_MAX_STREAMS; index += 1) {
    D211AudioStream *stream = &streams[index];
    if (!stream->used) continue;
    pthread_mutex_lock(&stream->lock);
    /* credit：占用自上次上报以来有变化才上报。用变化序号比较而不是占用
       数量本身——占用可能在一批内先增后减回到旧值，只比值会漏掉变化，
       guest 的免费帧镜像就再也恢复不了。写与消费都递增序号。 */
    if (stream->reported_seq != stream->change_seq) {
      stream->reported_seq = stream->change_seq;
      snprintf(line, sizeof(line), "{\"t\":\"credit\",\"h\":%d,\"free\":%u}",
               index, D211_AUDIO_RING_FRAMES - stream->count);
      pthread_mutex_unlock(&stream->lock);
      return line;
    }
    if (stream->event_head != stream->event_tail) {
      memcpy(line, stream->events[stream->event_head], sizeof(line));
      line[sizeof(line) - 1] = '\0';
      stream->event_head = (stream->event_head + 1) % D211_AUDIO_EVENTS;
      pthread_mutex_unlock(&stream->lock);
      return line;
    }
    pthread_mutex_unlock(&stream->lock);
  }
  return 0;
}

/** 宿主音频 ops 表。 */
static const PocketAudioOps d211_audio_ops = {
  .create_stream = d211_audio_create_stream,
  .destroy_stream = d211_audio_destroy_stream,
  .write_pcm = d211_audio_write_pcm,
  .play = d211_audio_play,
  .pause = d211_audio_pause,
  .stop = d211_audio_stop,
  .set_volume = d211_audio_set_volume,
  .end_stream = d211_audio_end_stream,
  .poll = d211_audio_poll,
};

/** 取音频 ops 表。 */
const PocketAudioOps *d211_audio_ops_table(void) {
  return &d211_audio_ops;
}
