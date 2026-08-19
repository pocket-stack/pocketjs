/* Socket-level harness for the network core on a POSIX host: the runtime
 * runs with the BSD-socket driver on a network thread while the owner thread
 * ticks it (begin_tick + poll) the way a guest host does. Peers are plain
 * blocking sockets in this process, so every framing case is deterministic:
 * a scripted HTTP server for the client core, and a raw client for the
 * server core. */
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "pnet_internal.h"
#include "pnet_posix_driver.h"
#include "pocketjs/net/runtime.h"

static int failures = 0;
static int checks = 0;
#define CHECK(cond)                                                                    \
  do {                                                                                 \
    checks++;                                                                          \
    if (!(cond)) {                                                                     \
      failures++;                                                                      \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                  \
    }                                                                                  \
  } while (0)

/* --- platform ----------------------------------------------------------- */

static uint64_t now_ms(void *ctx) {
  (void)ctx;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}
static void *plat_alloc(void *ctx, size_t size) { (void)ctx; return malloc(size); }
static void plat_free(void *ctx, void *ptr, size_t size) { (void)ctx; (void)size; free(ptr); }
static void plat_random(void *ctx, uint8_t *out, size_t len) {
  (void)ctx;
  for (size_t i = 0; i < len; i++) out[i] = (uint8_t)rand();
}
static void plat_log(void *ctx, pnet_log_level level, const char *msg) {
  (void)ctx;
  if (level <= PNET_LOG_WARN) fprintf(stderr, "[pnet] %s\n", msg);
}

/* --- runtime + network thread ------------------------------------------- */

typedef struct harness {
  pnet_runtime *rt;
  pnet_posix_driver *driver;
  pthread_mutex_t lock;
  pthread_t thread;
  volatile int stop;
} harness;

static void *net_thread(void *arg) {
  harness *h = arg;
  while (!h->stop) {
    pthread_mutex_lock(&h->lock);
    pnet_posix_driver_dispatch(h->driver, h->rt);
    pnet_runtime_service(h->rt);
    uint64_t deadline = pnet_runtime_next_deadline_ms(h->rt);
    bool more = pnet_runtime_has_pending_output(h->rt);
    pthread_mutex_unlock(&h->lock);
    int timeout = 50;
    if (deadline) {
      uint64_t now = now_ms(NULL);
      timeout = deadline > now ? (int)(deadline - now) : 0;
      if (timeout > 50) timeout = 50;
    }
    if (more) timeout = 0;
    pnet_posix_driver_wait(h->driver, timeout);
  }
  return NULL;
}

static void harness_start(harness *h, const char *policy) {
  pnet_platform plat = {NULL, now_ms, plat_alloc, plat_free, plat_random, plat_log};
  pnet_runtime_config cfg;
  pnet_runtime_config_defaults(&cfg);
  cfg.io_chunk_bytes = 1024;
  h->driver = pnet_posix_driver_create(32);
  h->rt = pnet_runtime_create(&plat, pnet_posix_driver_ops(), h->driver, &cfg, policy);
  pthread_mutex_init(&h->lock, NULL);
  h->stop = 0;
  pthread_create(&h->thread, NULL, net_thread, h);
}

static void harness_stop(harness *h) {
  h->stop = 1;
  pnet_posix_driver_wake(h->driver);
  pthread_join(h->thread, NULL);
  pnet_runtime_destroy(h->rt);
  pnet_posix_driver_destroy(h->driver);
  pthread_mutex_destroy(&h->lock);
}

/* One guest tick: begin_tick then poll of the named module. Returns a
 * malloc'd copy of the batch or NULL. */
typedef const char *(*poll_fn)(pnet_runtime *, size_t *);

static char *tick(harness *h, poll_fn poll) {
  pthread_mutex_lock(&h->lock);
  pnet_runtime_begin_tick(h->rt);
  size_t len = 0;
  const char *batch = poll(h->rt, &len);
  char *copy = batch ? strdup(batch) : NULL;
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  return copy;
}

/* Tick until `needle` appears in a batch or the timeout elapses; every batch
 * is appended to `log` (caller-provided buffer). */
static bool wait_for(harness *h, poll_fn poll, const char *needle, int timeout_ms, char *log, size_t log_cap) {
  uint64_t end = now_ms(NULL) + (uint64_t)timeout_ms;
  size_t used = strlen(log);
  while (now_ms(NULL) < end) {
    char *batch = tick(h, poll);
    if (batch) {
      size_t n = strlen(batch);
      if (used + n + 2 < log_cap) {
        memcpy(log + used, batch, n);
        used += n;
        log[used++] = '\n';
        log[used] = 0;
      }
      bool hit = strstr(batch, needle) != NULL;
      free(batch);
      if (hit) return true;
    }
    usleep(5000);
  }
  return false;
}

/* --- scripted HTTP peer ------------------------------------------------- */

typedef struct peer {
  int listen_fd;
  uint16_t port;
  pthread_t thread;
  volatile int stop;
  volatile int connections;
  char last_request[4096];
} peer;

static ssize_t read_head(int fd, char *buf, size_t cap) {
  size_t len = 0;
  while (len + 1 < cap) {
    ssize_t n = recv(fd, buf + len, 1, 0);
    if (n <= 0) return -1;
    len += (size_t)n;
    buf[len] = 0;
    if (len >= 4 && strcmp(buf + len - 4, "\r\n\r\n") == 0) return (ssize_t)len;
  }
  return -1;
}

static void send_all(int fd, const char *data, size_t len) {
  while (len > 0) {
    ssize_t n = send(fd, data, len, 0);
    if (n <= 0) return;
    data += n;
    len -= (size_t)n;
  }
}

static void *peer_thread(void *arg) {
  peer *p = arg;
  while (!p->stop) {
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int fd = accept(p->listen_fd, (struct sockaddr *)&a, &al);
    if (fd < 0) {
      if (p->stop) break;
      continue;
    }
    p->connections++;
    char head[4096];
    ssize_t hl = read_head(fd, head, sizeof head);
    if (hl < 0) {
      close(fd);
      continue;
    }
    strncpy(p->last_request, head, sizeof p->last_request - 1);
    char target[256] = {0};
    sscanf(head, "%*s %255s", target);
    /* Content-Length of the request, if any: read the body. */
    const char *cl = strcasestr(head, "content-length:");
    size_t body_len = cl ? (size_t)atoi(cl + 15) : 0;
    char body[512] = {0};
    if (body_len > 0 && body_len < sizeof body) {
      size_t got = 0;
      while (got < body_len) {
        ssize_t n = recv(fd, body + got, body_len - got, 0);
        if (n <= 0) break;
        got += (size_t)n;
      }
    }
    if (strcmp(target, "/hello") == 0) {
      const char *r = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Peer: 1\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 5\r\n\r\nhello";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/chunked") == 0) {
      const char *r = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
      send_all(fd, r, strlen(r));
      usleep(20000);
      send_all(fd, "5\r\nchunk\r\n", 10);
      usleep(20000);
      send_all(fd, "3\r\ned!\r\n0\r\nX-Trailer: ok\r\n\r\n", 26);
    } else if (strcmp(target, "/close-delimited") == 0) {
      const char *r = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nuntil-close";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/redirect") == 0) {
      const char *r = "HTTP/1.1 302 Found\r\nLocation: /hello\r\nContent-Length: 0\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/redirect-loop") == 0) {
      const char *r = "HTTP/1.1 302 Found\r\nLocation: /redirect-loop\r\nContent-Length: 0\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/redirect-post") == 0) {
      const char *r = "HTTP/1.1 303 See Other\r\nLocation: /echo-method\r\nContent-Length: 0\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/echo-method") == 0) {
      char method[16] = {0};
      sscanf(head, "%15s", method);
      char r[128];
      int n = snprintf(r, sizeof r, "HTTP/1.1 200 OK\r\nContent-Length: %zu\r\n\r\n%s", strlen(method), method);
      send_all(fd, r, (size_t)n);
    } else if (strcmp(target, "/te-cl") == 0) {
      const char *r = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/big") == 0) {
      char h[128];
      int n = snprintf(h, sizeof h, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", 100000);
      send_all(fd, h, (size_t)n);
      char chunk[1000];
      for (int i = 0; i < 100; i++) {
        memset(chunk, 'a' + (i % 26), sizeof chunk);
        send_all(fd, chunk, sizeof chunk);
      }
    } else if (strcmp(target, "/slow") == 0) {
      usleep(700000);
      const char *r = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/post") == 0) {
      char r[600];
      int n = snprintf(r, sizeof r, "HTTP/1.1 201 Created\r\nContent-Length: %zu\r\n\r\n%s", body_len, body);
      send_all(fd, r, (size_t)n);
    } else if (strcmp(target, "/head") == 0) {
      const char *r = "HTTP/1.1 200 OK\r\nContent-Length: 42\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/truncated") == 0) {
      const char *r = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc";
      send_all(fd, r, strlen(r));
    } else if (strcmp(target, "/nocontent") == 0) {
      const char *r = "HTTP/1.1 204 No Content\r\n\r\n";
      send_all(fd, r, strlen(r));
    } else {
      const char *r = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
      send_all(fd, r, strlen(r));
    }
    usleep(10000);
    close(fd);
  }
  return NULL;
}

static bool peer_start(peer *p) {
  memset(p, 0, sizeof *p);
  p->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(p->listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = 0;
  if (bind(p->listen_fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(p->listen_fd, 8) < 0) return false;
  socklen_t al = sizeof a;
  getsockname(p->listen_fd, (struct sockaddr *)&a, &al);
  p->port = ntohs(a.sin_port);
  pthread_create(&p->thread, NULL, peer_thread, p);
  return true;
}

static void peer_stop(peer *p) {
  p->stop = 1;
  shutdown(p->listen_fd, SHUT_RDWR);
  close(p->listen_fd);
  pthread_join(p->thread, NULL);
}

/* --- HTTP client tests -------------------------------------------------- */

static int start_get(harness *h, uint16_t port, const char *path, const char *extra) {
  char meta[512];
  snprintf(meta, sizeof meta, "{\"url\":\"http://127.0.0.1:%u%s\",\"method\":\"GET\",\"headers\":{\"x-test\":\"1\"}%s}", port, path,
           extra ? extra : "");
  pthread_mutex_lock(&h->lock);
  int handle = pnet_http_start(h->rt, meta, NULL, 0);
  if (handle < 0) fprintf(stderr, "start refused: %s\n", pnet_http_last_error(h->rt));
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  return handle;
}

/* Read the whole body of a handle across ticks into buf; returns bytes. */
static size_t read_body(harness *h, int handle, char *buf, size_t cap, int timeout_ms) {
  size_t total = 0;
  uint64_t end = now_ms(NULL) + (uint64_t)timeout_ms;
  bool ended = false;
  while (now_ms(NULL) < end && !ended) {
    char *batch = tick(h, pnet_http_poll);
    if (batch) {
      if (strstr(batch, "\"t\":\"end\"")) ended = true;
      if (strstr(batch, "\"t\":\"error\"")) {
        free(batch);
        break;
      }
      free(batch);
    }
    pthread_mutex_lock(&h->lock);
    for (;;) {
      if (total >= cap) break;
      int n = pnet_http_read_into(h->rt, handle, (uint8_t *)buf + total, cap - total);
      if (n <= 0) break;
      total += (size_t)n;
    }
    pthread_mutex_unlock(&h->lock);
    if (!ended) usleep(3000);
  }
  return total;
}

static void test_client(harness *h, peer *p) {
  char log[16384];
  char body[128 * 1024];

  /* 1. Plain GET: headers event, body, end; Set-Cookie delivered as an array. */
  log[0] = 0;
  int handle = start_get(h, p->port, "/hello", NULL);
  CHECK(handle > 0);
  CHECK(wait_for(h, pnet_http_poll, "\"t\":\"headers\"", 2000, log, sizeof log));
  CHECK(strstr(log, "\"status\":200") != NULL);
  CHECK(strstr(log, "\"set-cookie\":[\"a=1\",\"b=2\"]") != NULL);
  CHECK(strstr(log, "\"length\":5") != NULL);
  CHECK(strstr(log, "\"redirected\":false") != NULL);
  size_t n = read_body(h, handle, body, sizeof body, 2000);
  CHECK(n == 5 && memcmp(body, "hello", 5) == 0);
  CHECK(strstr(p->last_request, "GET /hello HTTP/1.1\r\nHost: 127.0.0.1:") != NULL);
  CHECK(strstr(p->last_request, "x-test: 1\r\n") != NULL);
  CHECK(strstr(p->last_request, "Connection: close\r\n") != NULL);
  pthread_mutex_lock(&h->lock);
  CHECK(!pnet_runtime_has_live_handles(h->rt));
  pthread_mutex_unlock(&h->lock);

  /* 2. Chunked with trailer, split across sends. */
  handle = start_get(h, p->port, "/chunked", NULL);
  n = read_body(h, handle, body, sizeof body, 3000);
  CHECK(n == 8 && memcmp(body, "chunked!", 8) == 0);

  /* 3. Close-delimited. */
  handle = start_get(h, p->port, "/close-delimited", NULL);
  n = read_body(h, handle, body, sizeof body, 3000);
  CHECK(n == 11 && memcmp(body, "until-close", 11) == 0);

  /* 4. Redirect followed; final URL and redirected flag reported. */
  log[0] = 0;
  handle = start_get(h, p->port, "/redirect", NULL);
  CHECK(wait_for(h, pnet_http_poll, "\"t\":\"headers\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"redirected\":true") != NULL);
  CHECK(strstr(log, "/hello\"") != NULL);
  n = read_body(h, handle, body, sizeof body, 2000);
  CHECK(n == 5);
  /* manual: the 302 itself is delivered */
  log[0] = 0;
  handle = start_get(h, p->port, "/redirect", ",\"redirect\":\"manual\"");
  CHECK(wait_for(h, pnet_http_poll, "\"status\":302", 3000, log, sizeof log));
  read_body(h, handle, body, sizeof body, 1000);
  /* error mode */
  log[0] = 0;
  handle = start_get(h, p->port, "/redirect", ",\"redirect\":\"error\"");
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"redirect\"", 3000, log, sizeof log));
  /* loop exhausts maxRedirects */
  log[0] = 0;
  handle = start_get(h, p->port, "/redirect-loop", ",\"maxRedirects\":2");
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"redirect\"", 5000, log, sizeof log));
  /* 303 rewrites POST to GET and drops the body */
  {
    char meta[256];
    snprintf(meta, sizeof meta, "{\"url\":\"http://127.0.0.1:%u/redirect-post\",\"method\":\"POST\",\"headers\":{\"content-type\":\"text/plain\"}}", p->port);
    pthread_mutex_lock(&h->lock);
    handle = pnet_http_start(h->rt, meta, (const uint8_t *)"payload", 7);
    pthread_mutex_unlock(&h->lock);
    pnet_posix_driver_wake(h->driver);
    CHECK(handle > 0);
    n = read_body(h, handle, body, sizeof body, 3000);
    CHECK(n == 3 && memcmp(body, "GET", 3) == 0);
    CHECK(strstr(p->last_request, "content-type") == NULL);
    CHECK(strstr(p->last_request, "Content-Length") == NULL); /* GET carries no body framing */
  }

  /* 5. Framing violation → protocol. */
  log[0] = 0;
  handle = start_get(h, p->port, "/te-cl", NULL);
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"protocol\"", 3000, log, sizeof log));

  /* 6. Backpressure: small queue, slow reader, 100 KB body arrives intact. */
  handle = start_get(h, p->port, "/big", ",\"queueBytes\":4096");
  {
    size_t total = 0;
    uint64_t end = now_ms(NULL) + 8000;
    bool ended = false;
    int max_avail = 0;
    while (now_ms(NULL) < end && !ended) {
      char *batch = tick(h, pnet_http_poll);
      if (batch) {
        const char *r = strstr(batch, "\"avail\":");
        if (r) {
          int avail = atoi(r + 8);
          if (avail > max_avail) max_avail = avail;
        }
        if (strstr(batch, "\"t\":\"end\"")) ended = true;
        free(batch);
      }
      pthread_mutex_lock(&h->lock);
      int got = pnet_http_read_into(h->rt, handle, (uint8_t *)body, 1500);
      pthread_mutex_unlock(&h->lock);
      if (got > 0) {
        for (int i = 0; i < got; i++) {
          if (body[i] != 'a' + (int)((total + (size_t)i) / 1000 % 26)) {
            CHECK(!"body content mismatch");
            break;
          }
        }
        total += (size_t)got;
      }
      usleep(2000);
    }
    /* Drain what is left after end. */
    for (;;) {
      pthread_mutex_lock(&h->lock);
      int got = pnet_http_read_into(h->rt, handle, (uint8_t *)body, sizeof body);
      pthread_mutex_unlock(&h->lock);
      if (got <= 0) break;
      total += (size_t)got;
    }
    CHECK(total == 100000);
    CHECK(max_avail <= 4096 + 2048); /* never far past the queue window */
  }

  /* 7. Timeouts: headers timeout on a slow peer. */
  log[0] = 0;
  handle = start_get(h, p->port, "/slow", ",\"timeouts\":{\"headersMs\":200}");
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"timeout\"", 3000, log, sizeof log));

  /* 8. POST body echo. */
  {
    char meta[256];
    snprintf(meta, sizeof meta, "{\"url\":\"http://127.0.0.1:%u/post\",\"method\":\"POST\",\"headers\":{}}", p->port);
    pthread_mutex_lock(&h->lock);
    handle = pnet_http_start(h->rt, meta, (const uint8_t *)"body-bytes", 10);
    pthread_mutex_unlock(&h->lock);
    pnet_posix_driver_wake(h->driver);
    log[0] = 0;
    CHECK(wait_for(h, pnet_http_poll, "\"status\":201", 3000, log, sizeof log));
    n = read_body(h, handle, body, sizeof body, 2000);
    CHECK(n == 10 && memcmp(body, "body-bytes", 10) == 0);
    CHECK(strstr(p->last_request, "Content-Length: 10\r\n") != NULL);
  }

  /* 9. HEAD: headers carry length, then end without a body. */
  {
    char meta[256];
    snprintf(meta, sizeof meta, "{\"url\":\"http://127.0.0.1:%u/head\",\"method\":\"HEAD\",\"headers\":{}}", p->port);
    pthread_mutex_lock(&h->lock);
    handle = pnet_http_start(h->rt, meta, NULL, 0);
    pthread_mutex_unlock(&h->lock);
    pnet_posix_driver_wake(h->driver);
    log[0] = 0;
    CHECK(wait_for(h, pnet_http_poll, "\"t\":\"end\"", 3000, log, sizeof log));
    CHECK(strstr(log, "\"length\":42") != NULL);
    CHECK(strstr(log, "\"t\":\"readable\"") == NULL);
  }
  /* 204 */
  log[0] = 0;
  handle = start_get(h, p->port, "/nocontent", NULL);
  CHECK(wait_for(h, pnet_http_poll, "\"t\":\"end\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"status\":204") != NULL);

  /* 10. Truncated body → closed. */
  log[0] = 0;
  handle = start_get(h, p->port, "/truncated", NULL);
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"closed\"", 3000, log, sizeof log));

  /* 11. Cancel: the terminal error arrives at the next tick. */
  handle = start_get(h, p->port, "/slow", NULL);
  usleep(50000);
  pthread_mutex_lock(&h->lock);
  pnet_http_cancel(h->rt, handle);
  pthread_mutex_unlock(&h->lock);
  log[0] = 0;
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"cancelled\"", 2000, log, sizeof log));

  /* 12. Connection refused → connect. */
  log[0] = 0;
  handle = start_get(h, 1, "/x", NULL); /* port 1: nothing listens */
  CHECK(handle > 0);
  CHECK(wait_for(h, pnet_http_poll, "\"code\":\"connect\"", 3000, log, sizeof log));

  /* 13. Policy: an endpoint outside the rules is refused synchronously. */
  {
    char meta[256];
    snprintf(meta, sizeof meta, "{\"url\":\"http://127.0.0.2:%u/hello\",\"method\":\"GET\",\"headers\":{}}", p->port);
    pthread_mutex_lock(&h->lock);
    int rc = pnet_http_start(h->rt, meta, NULL, 0);
    CHECK(rc == -1 && strncmp(pnet_http_last_error(h->rt), "permission_denied", 17) == 0);
    pthread_mutex_unlock(&h->lock);
  }
  pthread_mutex_lock(&h->lock);
  CHECK(!pnet_runtime_has_live_handles(h->rt));
  size_t heap = pnet_runtime_heap_bytes(h->rt);
  pthread_mutex_unlock(&h->lock);
  CHECK(heap < 64 * 1024);
}

/* --- HTTP server tests -------------------------------------------------- */

static int connect_client(uint16_t port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = htons(port);
  if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
    close(fd);
    return -1;
  }
  struct timeval tv = {3, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  return fd;
}

/* Read a full response (head + Content-Length or chunked body) from fd. */
static size_t read_response(int fd, char *buf, size_t cap) {
  size_t len = 0;
  size_t head_len = 0;
  while (len + 1 < cap) {
    ssize_t n = recv(fd, buf + len, 1, 0);
    if (n <= 0) break;
    len += (size_t)n;
    buf[len] = 0;
    if (head_len == 0 && len >= 4 && strcmp(buf + len - 4, "\r\n\r\n") == 0) {
      head_len = len;
      const char *cl = strcasestr(buf, "content-length:");
      bool chunked = strcasestr(buf, "transfer-encoding: chunked") != NULL;
      if (cl) {
        size_t want = (size_t)atoi(cl + 15);
        size_t got = 0;
        while (got < want && len + 1 < cap) {
          ssize_t m = recv(fd, buf + len, want - got < cap - len - 1 ? want - got : cap - len - 1, 0);
          if (m <= 0) break;
          got += (size_t)m;
          len += (size_t)m;
        }
        buf[len] = 0;
        return len;
      }
      if (chunked) {
        /* read until the terminating 0-chunk */
        while (len + 1 < cap) {
          ssize_t m = recv(fd, buf + len, 1, 0);
          if (m <= 0) break;
          len += (size_t)m;
          buf[len] = 0;
          if (len >= 5 && strcmp(buf + len - 5, "0\r\n\r\n") == 0) return len;
        }
        return len;
      }
      return len;
    }
  }
  return len;
}

static int extract_int(const char *json, const char *key) {
  const char *p = strstr(json, key);
  if (!p) return -1;
  return atoi(p + strlen(key));
}

/* The resolver path: a hostname goes through getaddrinfo on the driver's
 * resolver worker, the worker wakes the network task, dispatch hands the
 * candidates to the dialer, and the exchange completes over the first
 * permitted address. An unresolvable name reports `dns` without touching a
 * socket — and while that lookup is in flight the network task keeps
 * serving another exchange (a literal-address request completes even
 * though a resolve is pending). */
static void test_resolver(harness *h, peer *p) {
  char log[16384];
  char body[1024];
  log[0] = 0;
  char meta[512];
  snprintf(meta, sizeof meta, "{\"url\":\"http://localhost:%u/hello\",\"method\":\"GET\",\"headers\":{}}", p->port);
  pthread_mutex_lock(&h->lock);
  int handle = pnet_http_start(h->rt, meta, NULL, 0);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(handle > 0);
  CHECK(wait_for(h, pnet_http_poll, "\"t\":\"headers\"", 4000, log, sizeof log));
  size_t n = read_body(h, handle, body, sizeof body, 2000);
  CHECK(n == 5 && memcmp(body, "hello", 5) == 0);

  /* NXDOMAIN: `dns`, no socket. */
  log[0] = 0;
  pthread_mutex_lock(&h->lock);
  int bad = pnet_http_start(h->rt, "{\"url\":\"http://nope.invalid/x\",\"method\":\"GET\",\"headers\":{}}", NULL, 0);
  /* Concurrently a literal-address request must not wait for the lookup. */
  char meta2[256];
  snprintf(meta2, sizeof meta2, "{\"url\":\"http://127.0.0.1:%u/hello\",\"method\":\"GET\",\"headers\":{}}", p->port);
  int literal = pnet_http_start(h->rt, meta2, NULL, 0);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(bad > 0 && literal > 0);
  char needle[64];
  snprintf(needle, sizeof needle, "\"t\":\"headers\",\"h\":%d", literal);
  CHECK(wait_for(h, pnet_http_poll, needle, 4000, log, sizeof log));
  /* The lookup's failure may already sit in the accumulated log (the
   * batches are shared), otherwise keep ticking for it. */
  snprintf(needle, sizeof needle, "\"h\":%d,\"code\":\"dns\"", bad);
  bool got_dns = strstr(log, needle) != NULL || wait_for(h, pnet_http_poll, needle, 10000, log, sizeof log);
  if (!got_dns) fprintf(stderr, "resolver log:\n%s\n", log);
  CHECK(got_dns);
  n = read_body(h, literal, body, sizeof body, 2000);
  CHECK(n == 5);
  pthread_mutex_lock(&h->lock);
  CHECK(!pnet_runtime_has_live_handles(h->rt));
  pthread_mutex_unlock(&h->lock);
}

static void test_server(harness *h) {
  char log[16384];
  char resp[65536];
  /* Listen on an ephemeral port. */
  pthread_mutex_lock(&h->lock);
  int server = pnet_httpd_listen(h->rt, "{\"address\":\"127.0.0.1\",\"port\":0,\"timeouts\":{\"handlerMs\":500,\"keepAliveMs\":300}}");
  if (server < 0) fprintf(stderr, "listen refused: %s\n", pnet_httpd_last_error(h->rt));
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(server > 0);
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"listening\"", 2000, log, sizeof log));
  int port = extract_int(log, "\"port\":");
  CHECK(port > 0);

  /* 1. Simple GET answered with respond(end=true); keep-alive second request. */
  int fd = connect_client((uint16_t)port);
  CHECK(fd >= 0);
  const char *req1 = "GET /hello?x=1 HTTP/1.1\r\nHost: unit\r\nX-A: 1\r\nX-A: 2\r\n\r\n";
  send_all(fd, req1, strlen(req1));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"request\"", 2000, log, sizeof log));
  CHECK(strstr(log, "\"method\":\"GET\"") != NULL);
  CHECK(strstr(log, "\"target\":\"/hello?x=1\"") != NULL);
  CHECK(strstr(log, "\"x-a\":\"1, 2\"") != NULL);
  CHECK(strstr(log, "\"t\":\"end\"") != NULL); /* no body: end follows in the same tick */
  int req = extract_int(log, "\"req\":");
  CHECK(req > 0);
  pthread_mutex_lock(&h->lock);
  int rc = pnet_httpd_respond(h->rt, req, "{\"status\":200,\"headers\":{\"content-type\":\"text/plain\",\"connection\":\"evil\"}}",
                              (const uint8_t *)"hi there", 8);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(rc == 0);
  size_t n = read_response(fd, resp, sizeof resp);
  CHECK(n > 0);
  CHECK(strncmp(resp, "HTTP/1.1 200 OK\r\n", 17) == 0);
  CHECK(strstr(resp, "content-type: text/plain\r\n") != NULL);
  CHECK(strstr(resp, "Content-Length: 8\r\n") != NULL);
  CHECK(strstr(resp, "Connection: keep-alive\r\n") != NULL);
  CHECK(strstr(resp, "connection: evil") == NULL);
  CHECK(strcmp(resp + n - 8, "hi there") == 0);
  /* second request on the same connection */
  const char *req2 = "POST /echo HTTP/1.1\r\nHost: unit\r\nContent-Length: 11\r\n\r\nhello world";
  send_all(fd, req2, strlen(req2));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"end\"", 2000, log, sizeof log));
  CHECK(strstr(log, "\"method\":\"POST\"") != NULL);
  CHECK(strstr(log, "\"length\":11") != NULL);
  CHECK(strstr(log, "\"t\":\"readable\"") != NULL);
  /* readable must precede end so the guest reads the bytes before EOF */
  CHECK(strstr(log, "\"t\":\"readable\"") < strstr(log, "\"t\":\"end\""));
  req = extract_int(log, "\"req\":");
  char body[64];
  pthread_mutex_lock(&h->lock);
  int got = pnet_httpd_read_into(h->rt, req, (uint8_t *)body, sizeof body);
  pthread_mutex_unlock(&h->lock);
  CHECK(got == 11 && memcmp(body, "hello world", 11) == 0);
  /* streamed response: respond(end=false) + write + endBody, chunked */
  pthread_mutex_lock(&h->lock);
  rc = pnet_httpd_respond(h->rt, req, "{\"status\":200,\"end\":false}", NULL, 0);
  CHECK(rc == 0);
  CHECK(pnet_httpd_write(h->rt, req, (const uint8_t *)"abc", 3) == 0);
  CHECK(pnet_httpd_write(h->rt, req, (const uint8_t *)"defg", 4) == 0);
  CHECK(pnet_httpd_end_body(h->rt, req) == 0);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  n = read_response(fd, resp, sizeof resp);
  CHECK(strstr(resp, "Transfer-Encoding: chunked\r\n") != NULL);
  CHECK(strstr(resp, "\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n") != NULL);
  close(fd);

  /* 2. HEAD request: body discarded, Content-Length kept. */
  fd = connect_client((uint16_t)port);
  const char *req3 = "HEAD /h HTTP/1.1\r\nHost: unit\r\nConnection: close\r\n\r\n";
  send_all(fd, req3, strlen(req3));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"request\"", 2000, log, sizeof log));
  req = extract_int(log, "\"req\":");
  pthread_mutex_lock(&h->lock);
  rc = pnet_httpd_respond(h->rt, req, "{\"status\":200}", (const uint8_t *)"12345", 5);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(rc == 0);
  {
    size_t total = 0;
    for (;;) {
      ssize_t m = recv(fd, resp + total, sizeof resp - 1 - total, 0);
      if (m <= 0) break;
      total += (size_t)m;
    }
    resp[total] = 0;
    CHECK(strstr(resp, "Content-Length: 5\r\n") != NULL);
    CHECK(strstr(resp, "Connection: close\r\n") != NULL);
    CHECK(strstr(resp, "\r\n\r\n12345") == NULL);
    CHECK(total > 0 && strcmp(resp + total - 4, "\r\n\r\n") == 0);
  }
  close(fd);

  /* 3. Handler timeout: no respond within handlerMs → 503 + aborted{timeout}. */
  fd = connect_client((uint16_t)port);
  send_all(fd, req1, strlen(req1));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"code\":\"timeout\"", 3000, log, sizeof log));
  n = read_response(fd, resp, sizeof resp);
  CHECK(strncmp(resp, "HTTP/1.1 503", 12) == 0);
  close(fd);

  /* 4. Peer disconnect before the response → aborted{closed}; late respond is refused. */
  fd = connect_client((uint16_t)port);
  send_all(fd, req1, strlen(req1));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"request\"", 2000, log, sizeof log));
  req = extract_int(log, "\"req\":");
  close(fd);
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"code\":\"closed\"", 2000, log, sizeof log));
  pthread_mutex_lock(&h->lock);
  CHECK(pnet_httpd_respond(h->rt, req, "{\"status\":200}", NULL, 0) == -1);
  pthread_mutex_unlock(&h->lock);

  /* 5. Framing violations answered 400 without delivery; oversized target 414. */
  fd = connect_client((uint16_t)port);
  const char *bad = "GET / HTTP/1.1\r\nHost: unit\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n";
  send_all(fd, bad, strlen(bad));
  n = read_response(fd, resp, sizeof resp);
  CHECK(strncmp(resp, "HTTP/1.1 400", 12) == 0);
  close(fd);
  fd = connect_client((uint16_t)port);
  {
    char big[4096];
    size_t o = (size_t)snprintf(big, sizeof big, "GET /");
    while (o < 3000) big[o++] = 'a';
    o += (size_t)snprintf(big + o, sizeof big - o, " HTTP/1.1\r\nHost: unit\r\n\r\n");
    send_all(fd, big, o);
  }
  n = read_response(fd, resp, sizeof resp);
  CHECK(strncmp(resp, "HTTP/1.1 414", 12) == 0);
  close(fd);
  /* Missing Host */
  fd = connect_client((uint16_t)port);
  const char *nohost = "GET / HTTP/1.1\r\n\r\n";
  send_all(fd, nohost, strlen(nohost));
  n = read_response(fd, resp, sizeof resp);
  CHECK(strncmp(resp, "HTTP/1.1 400", 12) == 0);
  close(fd);

  /* 6. Expect: 100-continue gets an interim response; chunked request body. */
  fd = connect_client((uint16_t)port);
  const char *expect = "POST /up HTTP/1.1\r\nHost: unit\r\nExpect: 100-continue\r\nTransfer-Encoding: chunked\r\n\r\n";
  send_all(fd, expect, strlen(expect));
  {
    char interim[64];
    ssize_t m = recv(fd, interim, sizeof interim - 1, 0);
    CHECK(m > 0);
    if (m > 0) {
      interim[m] = 0;
      CHECK(strncmp(interim, "HTTP/1.1 100 Continue\r\n\r\n", 25) == 0);
    }
  }
  send_all(fd, "4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n", 24);
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"end\"", 2000, log, sizeof log));
  req = extract_int(log, "\"req\":");
  pthread_mutex_lock(&h->lock);
  got = pnet_httpd_read_into(h->rt, req, (uint8_t *)body, sizeof body);
  CHECK(got == 9 && memcmp(body, "Wikipedia", 9) == 0);
  rc = pnet_httpd_respond(h->rt, req, "{\"status\":204}", NULL, 0);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(rc == 0);
  n = read_response(fd, resp, sizeof resp);
  CHECK(strncmp(resp, "HTTP/1.1 204 No Content\r\n", 25) == 0);
  close(fd);

  /* 7. abort(req) closes the connection and reports aborted{cancelled}. */
  fd = connect_client((uint16_t)port);
  send_all(fd, req1, strlen(req1));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"request\"", 2000, log, sizeof log));
  req = extract_int(log, "\"req\":");
  pthread_mutex_lock(&h->lock);
  pnet_httpd_abort(h->rt, req);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"code\":\"cancelled\"", 2000, log, sizeof log));
  {
    ssize_t m = recv(fd, resp, sizeof resp, 0);
    CHECK(m == 0); /* EOF: closed without a response */
  }
  close(fd);

  /* 8. stop(graceful) with an inflight request: closes after the response. */
  fd = connect_client((uint16_t)port);
  send_all(fd, req1, strlen(req1));
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"request\"", 2000, log, sizeof log));
  req = extract_int(log, "\"req\":");
  pthread_mutex_lock(&h->lock);
  CHECK(pnet_httpd_stop(h->rt, server, true, 2000) == 0);
  CHECK(pnet_httpd_stop(h->rt, server, true, 2000) == -1);
  rc = pnet_httpd_respond(h->rt, req, "{\"status\":200}", (const uint8_t *)"bye", 3);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  CHECK(rc == 0);
  n = read_response(fd, resp, sizeof resp);
  CHECK(strstr(resp, "Connection: close\r\n") != NULL);
  CHECK(strcmp(resp + n - 3, "bye") == 0);
  close(fd);
  log[0] = 0;
  CHECK(wait_for(h, pnet_httpd_poll, "\"t\":\"closed\"", 3000, log, sizeof log));
  CHECK(connect_client((uint16_t)port) < 0);
  pthread_mutex_lock(&h->lock);
  CHECK(!pnet_runtime_has_live_handles(h->rt));
  pthread_mutex_unlock(&h->lock);
}


/* --- scripted WebSocket peer ------------------------------------------- */

typedef struct ws_peer {
  int listen_fd;
  uint16_t port;
  pthread_t thread;
  volatile int stop;
  volatile int pongs_seen;
  volatile int closes_seen;
  volatile int last_close_code;
} ws_peer;

static void ws_peer_send_frame(int fd, uint8_t opcode, bool fin, const uint8_t *payload, size_t len) {
  uint8_t head[10];
  size_t hl = 0;
  head[hl++] = (uint8_t)((fin ? 0x80 : 0) | opcode);
  if (len < 126) head[hl++] = (uint8_t)len;
  else if (len <= 0xffff) {
    head[hl++] = 126;
    head[hl++] = (uint8_t)(len >> 8);
    head[hl++] = (uint8_t)len;
  } else {
    head[hl++] = 127;
    for (int i = 7; i >= 0; i--) head[hl++] = (uint8_t)((uint64_t)len >> (8 * i));
  }
  send_all(fd, (const char *)head, hl);
  if (len) send_all(fd, (const char *)payload, len);
}

static bool recv_exact(int fd, uint8_t *buf, size_t len) {
  size_t got = 0;
  while (got < len) {
    ssize_t n = recv(fd, buf + got, len - got, 0);
    if (n <= 0) return false;
    got += (size_t)n;
  }
  return true;
}

/* Read one masked client frame; returns opcode or -1. */
static int ws_peer_recv_frame(int fd, uint8_t *payload, size_t cap, size_t *out_len, bool *fin) {
  uint8_t h[2];
  if (!recv_exact(fd, h, 2)) return -1;
  int opcode = h[0] & 0x0f;
  *fin = (h[0] & 0x80) != 0;
  if (!(h[1] & 0x80)) return -1; /* client frames must be masked */
  uint64_t len = h[1] & 0x7f;
  if (len == 126) {
    uint8_t e[2];
    if (!recv_exact(fd, e, 2)) return -1;
    len = ((uint64_t)e[0] << 8) | e[1];
  } else if (len == 127) {
    uint8_t e[8];
    if (!recv_exact(fd, e, 8)) return -1;
    len = 0;
    for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
  }
  uint8_t mask[4];
  if (!recv_exact(fd, mask, 4)) return -1;
  if (len > cap) return -1;
  if (!recv_exact(fd, payload, (size_t)len)) return -1;
  for (size_t i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  *out_len = (size_t)len;
  return opcode;
}

static void *ws_peer_thread(void *arg) {
  ws_peer *p = arg;
  while (!p->stop) {
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int fd = accept(p->listen_fd, (struct sockaddr *)&a, &al);
    if (fd < 0) {
      if (p->stop) break;
      continue;
    }
    char head[4096];
    if (read_head(fd, head, sizeof head) < 0) {
      close(fd);
      continue;
    }
    char target[256] = {0};
    sscanf(head, "%*s %255s", target);
    const char *keyh = strcasestr(head, "sec-websocket-key:");
    char key[64] = {0};
    if (keyh) sscanf(keyh + 18, " %63s", key);
    if (strcmp(target, "/deny") == 0) {
      const char *r = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
      send_all(fd, r, strlen(r));
      close(fd);
      continue;
    }
    char concat[128];
    snprintf(concat, sizeof concat, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    uint8_t digest[20];
    pnet_sha1((const uint8_t *)concat, strlen(concat), digest);
    char accept_key[32];
    pnet_base64_encode(digest, 20, accept_key, sizeof accept_key);
    char resp[512];
    const char *proto_line = strcasestr(head, "sec-websocket-protocol:") ? "Sec-WebSocket-Protocol: chat.v1\r\n" : "";
    if (strcmp(target, "/badaccept") == 0) accept_key[0] = accept_key[0] == 'A' ? 'B' : 'A';
    int n = snprintf(resp, sizeof resp,
                     "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     "Sec-WebSocket-Accept: %s\r\n%s\r\n", accept_key, proto_line);
    send_all(fd, resp, (size_t)n);
    if (strcmp(target, "/fragments") == 0) {
      /* server → client: a fragmented text message with a ping in between */
      ws_peer_send_frame(fd, 1, false, (const uint8_t *)"Hel", 3);
      ws_peer_send_frame(fd, 9, true, (const uint8_t *)"pp", 2);
      ws_peer_send_frame(fd, 0, false, (const uint8_t *)"lo ", 3);
      ws_peer_send_frame(fd, 0, true, (const uint8_t *)"\xE4\xB8\x96\xE7\x95\x8C", 6);
      /* expect the pong echo */
      uint8_t buf[256];
      size_t len;
      bool fin;
      int op = ws_peer_recv_frame(fd, buf, sizeof buf, &len, &fin);
      if (op == 10 && len == 2 && memcmp(buf, "pp", 2) == 0) p->pongs_seen++;
      /* then a server-initiated close */
      uint8_t cl[16] = {0x03, 0xE9, 'b', 'y', 'e'};
      ws_peer_send_frame(fd, 8, true, cl, 5);
      op = ws_peer_recv_frame(fd, buf, sizeof buf, &len, &fin);
      if (op == 8) p->closes_seen++;
      close(fd);
      continue;
    }
    if (strcmp(target, "/oversized") == 0) {
      uint8_t big[300];
      memset(big, 'x', sizeof big);
      ws_peer_send_frame(fd, 2, true, big, sizeof big);
      uint8_t buf[256];
      size_t len;
      bool fin;
      int op = ws_peer_recv_frame(fd, buf, sizeof buf, &len, &fin);
      if (op == 8 && len >= 2) {
        p->last_close_code = (buf[0] << 8) | buf[1];
        ws_peer_send_frame(fd, 8, true, buf, 2);
      }
      close(fd);
      continue;
    }
    if (strcmp(target, "/badutf8") == 0) {
      ws_peer_send_frame(fd, 1, true, (const uint8_t *)"\xff\xfe", 2);
      uint8_t buf[256];
      size_t len;
      bool fin;
      int op = ws_peer_recv_frame(fd, buf, sizeof buf, &len, &fin);
      if (op == 8 && len >= 2) {
        p->last_close_code = (buf[0] << 8) | buf[1];
        ws_peer_send_frame(fd, 8, true, buf, 2);
      }
      close(fd);
      continue;
    }
    if (strcmp(target, "/masked") == 0) {
      /* server frame with the mask bit set: protocol error 1002 */
      uint8_t bad[8] = {0x81, 0x81, 1, 2, 3, 4, 'x' ^ 1};
      send_all(fd, (const char *)bad, 7);
      uint8_t buf[256];
      size_t len;
      bool fin;
      int op = ws_peer_recv_frame(fd, buf, sizeof buf, &len, &fin);
      if (op == 8 && len >= 2) p->last_close_code = (buf[0] << 8) | buf[1];
      close(fd);
      continue;
    }
    if (strcmp(target, "/drop") == 0) {
      usleep(50000);
      close(fd);
      continue;
    }
    /* echo server: echo data frames, answer pings, mirror close */
    for (;;) {
      uint8_t buf[70000];
      size_t len;
      bool fin;
      int op = ws_peer_recv_frame(fd, buf, sizeof buf, &len, &fin);
      if (op < 0) break;
      if (op == 1 || op == 2) ws_peer_send_frame(fd, (uint8_t)op, true, buf, len);
      else if (op == 9) ws_peer_send_frame(fd, 10, true, buf, len);
      else if (op == 10) p->pongs_seen++;
      else if (op == 8) {
        p->closes_seen++;
        if (len >= 2) p->last_close_code = (buf[0] << 8) | buf[1];
        ws_peer_send_frame(fd, 8, true, buf, len);
        break;
      }
    }
    usleep(10000);
    close(fd);
  }
  return NULL;
}

static bool ws_peer_start(ws_peer *p) {
  memset(p, 0, sizeof *p);
  p->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(p->listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(p->listen_fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(p->listen_fd, 8) < 0) return false;
  socklen_t al = sizeof a;
  getsockname(p->listen_fd, (struct sockaddr *)&a, &al);
  p->port = ntohs(a.sin_port);
  pthread_create(&p->thread, NULL, ws_peer_thread, p);
  return true;
}

static void ws_peer_stop(ws_peer *p) {
  p->stop = 1;
  shutdown(p->listen_fd, SHUT_RDWR);
  close(p->listen_fd);
  pthread_join(p->thread, NULL);
}

static int ws_connect(harness *h, uint16_t port, const char *path, const char *extra) {
  char meta[512];
  snprintf(meta, sizeof meta, "{\"url\":\"ws://127.0.0.1:%u%s\"%s}", port, path, extra ? extra : "");
  pthread_mutex_lock(&h->lock);
  int handle = pnet_ws_connect(h->rt, meta);
  if (handle < 0) fprintf(stderr, "ws connect refused: %s\n", pnet_ws_last_error(h->rt));
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  return handle;
}

static void test_websocket(harness *h, ws_peer *p) {
  char log[16384];

  /* 1. Handshake with subprotocol; text and binary echo. */
  log[0] = 0;
  int handle = ws_connect(h, p->port, "/echo", ",\"protocols\":[\"chat.v1\",\"other\"],\"headers\":{\"origin\":\"pocket\"}");
  CHECK(handle > 0);
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"open\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"protocol\":\"chat.v1\"") != NULL);
  pthread_mutex_lock(&h->lock);
  CHECK(pnet_ws_send(h->rt, handle, 1, (const uint8_t *)"h\xC3\xA9llo", 6) == 0);
  CHECK(pnet_ws_send(h->rt, handle, 2, (const uint8_t *)"\x01\x02\x03", 3) == 0);
  CHECK(pnet_ws_send(h->rt, handle, 1, (const uint8_t *)"\xff", 1) == PWS_SEND_INVALID); /* invalid UTF-8 text */
  CHECK(pnet_ws_send(h->rt, handle, 9, (const uint8_t *)"ping!", 5) == 0);
  CHECK(pnet_ws_send(h->rt, handle, 9, (const uint8_t *)log, 126) == PWS_SEND_INVALID);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  log[0] = 0;
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"pong\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"kind\":\"text\",\"text\":\"h\xC3\xA9llo\"") != NULL);
  CHECK(strstr(log, "\"kind\":\"binary\",\"bytes\":3") != NULL);
  CHECK(strstr(log, "\"payload\":{\"$b\":\"cGluZyE=\"}") != NULL);
  {
    uint8_t buf[8];
    pthread_mutex_lock(&h->lock);
    CHECK(pnet_ws_receive_into(h->rt, handle, buf, 2) == -1); /* too small: nothing dequeued */
    int got = pnet_ws_receive_into(h->rt, handle, buf, sizeof buf);
    CHECK(got == 3 && buf[0] == 1 && buf[2] == 3);
    CHECK(pnet_ws_receive_into(h->rt, handle, buf, sizeof buf) == -1);
    CHECK(pnet_ws_buffered_amount(h->rt, handle) >= 0);
    pthread_mutex_unlock(&h->lock);
  }
  /* client-initiated close: clean, local, code echoed */
  pthread_mutex_lock(&h->lock);
  CHECK(pnet_ws_close(h->rt, handle, 4001, "done", 4) == 0);
  CHECK(pnet_ws_close(h->rt, handle, 1000, NULL, 0) == -1);
  CHECK(pnet_ws_send(h->rt, handle, 1, (const uint8_t *)"x", 1) == PWS_SEND_CLOSED);
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  log[0] = 0;
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"code\":4001,\"reason\":\"done\",\"clean\":true,\"local\":true") != NULL);
  CHECK(p->last_close_code == 4001);

  /* 2. Fragmented server message + interleaved ping (auto pong) + server close. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/fragments", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"text\":\"Hello \xE4\xB8\x96\xE7\x95\x8C\"") != NULL);
  CHECK(strstr(log, "\"t\":\"ping\"") != NULL);
  CHECK(strstr(log, "\"code\":1001,\"reason\":\"bye\",\"clean\":true,\"local\":false") != NULL);
  usleep(50000);
  CHECK(p->pongs_seen >= 1);

  /* 3. Oversized message → error message_too_large + close 1009. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/oversized", ",\"limits\":{\"maxMessageBytes\":100}");
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"code\":\"message_too_large\"") != NULL);
  CHECK(strstr(log, "\"code\":1009") != NULL);
  CHECK(p->last_close_code == 1009);

  /* 4. Invalid UTF-8 → 1007; masked server frame → 1002. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/badutf8", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"code\":\"websocket_protocol_error\"") != NULL && strstr(log, "\"code\":1007") != NULL);
  log[0] = 0;
  handle = ws_connect(h, p->port, "/masked", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"code\":1002") != NULL);

  /* 5. Transport loss → error closed + close 1006. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/drop", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"code\":\"closed\"") != NULL && strstr(log, "\"code\":1006") != NULL);

  /* 6. Handshake failures: 403 and a bad accept key. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/deny", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"code\":\"websocket_handshake_failed\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"status\":403") != NULL);
  log[0] = 0;
  handle = ws_connect(h, p->port, "/badaccept", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"code\":\"websocket_handshake_failed\"", 3000, log, sizeof log));

  /* 7. Terminate: close 1006 local without a Close frame. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/echo", NULL);
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"open\"", 3000, log, sizeof log));
  pthread_mutex_lock(&h->lock);
  pnet_ws_terminate(h->rt, handle);
  pthread_mutex_unlock(&h->lock);
  log[0] = 0;
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));
  CHECK(strstr(log, "\"code\":1006,\"reason\":\"\",\"clean\":false,\"local\":true") != NULL);

  /* 8. Backpressure and drain with a tiny send queue. */
  log[0] = 0;
  handle = ws_connect(h, p->port, "/echo", ",\"limits\":{\"sendQueueBytes\":64}");
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"open\"", 3000, log, sizeof log));
  {
    uint8_t payload[40];
    memset(payload, 'z', sizeof payload);
    pthread_mutex_lock(&h->lock);
    int rc1 = pnet_ws_send(h->rt, handle, 2, payload, sizeof payload);
    int rc2 = pnet_ws_send(h->rt, handle, 2, payload, sizeof payload);
    pthread_mutex_unlock(&h->lock);
    pnet_posix_driver_wake(h->driver);
    CHECK(rc1 == 0 || rc1 == 1);
    CHECK(rc2 == PWS_SEND_BACKPRESSURE);
    log[0] = 0;
    CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"drain\"", 3000, log, sizeof log));
  }
  pthread_mutex_lock(&h->lock);
  pnet_ws_close(h->rt, handle, 1000, NULL, 0);
  pthread_mutex_unlock(&h->lock);
  log[0] = 0;
  CHECK(wait_for(h, pnet_ws_poll, "\"t\":\"close\"", 3000, log, sizeof log));

  /* 9. Refusals. */
  pthread_mutex_lock(&h->lock);
  CHECK(pnet_ws_connect(h->rt, "{\"url\":\"wss://127.0.0.1/\"}") == -1);
  CHECK(strncmp(pnet_ws_last_error(h->rt), "unsupported", 11) == 0);
  CHECK(pnet_ws_connect(h->rt, "{\"url\":\"ws://127.0.0.1/\",\"headers\":{\"Host\":\"x\"}}") == -1);
  CHECK(pnet_ws_connect(h->rt, "{\"url\":\"ws://127.0.0.1/\",\"protocols\":[\"a\",\"a\"]}") == -1);
  CHECK(pnet_ws_connect(h->rt, "{\"url\":\"ws://127.0.0.2/\"}") == -1);
  CHECK(strncmp(pnet_ws_last_error(h->rt), "permission_denied", 17) == 0);
  CHECK(!pnet_runtime_has_live_handles(h->rt));
  pthread_mutex_unlock(&h->lock);
}

int main(void) {
  srand(1234);
  peer p;
  CHECK(peer_start(&p));
  ws_peer wp;
  CHECK(ws_peer_start(&wp));
  char policy[512];
  snprintf(policy, sizeof policy,
           "{\"connect\":[{\"protocol\":\"http\",\"host\":\"127.0.0.1\",\"port\":{\"min\":1,\"max\":65535}},"
           "{\"protocol\":\"ws\",\"host\":\"127.0.0.1\",\"port\":{\"min\":1,\"max\":65535}},"
           "{\"protocol\":\"http\",\"host\":\"localhost\",\"port\":{\"min\":1,\"max\":65535}},"
           "{\"protocol\":\"http\",\"host\":\"*.invalid\",\"port\":{\"min\":1,\"max\":65535}}],"
           "\"listen\":[{\"protocol\":\"http\",\"address\":\"127.0.0.1\",\"port\":\"ephemeral\"}],"
           "\"insecureTransport\":true,\"localNetwork\":true}");
  harness h;
  harness_start(&h, policy);
  CHECK(h.rt != NULL);
  if (h.rt) {
    test_client(&h, &p);
    test_resolver(&h, &p);
    test_server(&h);
    test_websocket(&h, &wp);
  }
  harness_stop(&h);
  peer_stop(&p);
  ws_peer_stop(&wp);
  printf("host: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
