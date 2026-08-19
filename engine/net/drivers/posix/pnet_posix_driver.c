/* BSD-socket NetDriver (see pnet_posix_driver.h). Compiles on POSIX hosts
 * and on ESP-IDF (lwIP sockets + newlib). */
#include "pnet_posix_driver.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>

#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(ESP_PLATFORM)
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
typedef SemaphoreHandle_t drv_mutex_t;
static void mutex_init(drv_mutex_t *m) { *m = xSemaphoreCreateMutex(); }
static void mutex_lock(drv_mutex_t *m) { xSemaphoreTake(*m, portMAX_DELAY); }
static void mutex_unlock(drv_mutex_t *m) { xSemaphoreGive(*m); }
static void mutex_destroy(drv_mutex_t *m) { vSemaphoreDelete(*m); }
/* Resolver worker signal: a binary semaphore the worker blocks on. */
typedef SemaphoreHandle_t drv_signal_t;
static bool signal_init(drv_signal_t *s) { *s = xSemaphoreCreateBinary(); return *s != NULL; }
static void signal_post(drv_signal_t *s) { xSemaphoreGive(*s); }
static void signal_wait(drv_signal_t *s) { xSemaphoreTake(*s, portMAX_DELAY); }
static void signal_destroy(drv_signal_t *s) { vSemaphoreDelete(*s); }
#ifndef PNET_POSIX_RESOLVER_STACK
#define PNET_POSIX_RESOLVER_STACK 6144
#endif
#ifndef PNET_POSIX_RESOLVER_PRIORITY
#define PNET_POSIX_RESOLVER_PRIORITY 6
#endif
#else
#include <pthread.h>
typedef pthread_mutex_t drv_mutex_t;
static void mutex_init(drv_mutex_t *m) { pthread_mutex_init(m, NULL); }
static void mutex_lock(drv_mutex_t *m) { pthread_mutex_lock(m); }
static void mutex_unlock(drv_mutex_t *m) { pthread_mutex_unlock(m); }
static void mutex_destroy(drv_mutex_t *m) { pthread_mutex_destroy(m); }
/* Resolver worker signal: a counting flag under its own mutex + condvar. */
typedef struct drv_signal {
  pthread_mutex_t m;
  pthread_cond_t c;
  int pending;
} drv_signal_t;
static bool signal_init(drv_signal_t *s) {
  s->pending = 0;
  return pthread_mutex_init(&s->m, NULL) == 0 && pthread_cond_init(&s->c, NULL) == 0;
}
static void signal_post(drv_signal_t *s) {
  pthread_mutex_lock(&s->m);
  s->pending = 1;
  pthread_cond_signal(&s->c);
  pthread_mutex_unlock(&s->m);
}
static void signal_wait(drv_signal_t *s) {
  pthread_mutex_lock(&s->m);
  while (!s->pending) pthread_cond_wait(&s->c, &s->m);
  s->pending = 0;
  pthread_mutex_unlock(&s->m);
}
static void signal_destroy(drv_signal_t *s) {
  pthread_cond_destroy(&s->c);
  pthread_mutex_destroy(&s->m);
}
#endif

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define RESOLVE_SLOTS 16
#define RESOLVE_MAX_ADDRS 8

static void resolver_start(pnet_posix_driver *d);
static void resolver_stop(pnet_posix_driver *d);

typedef struct sock_slot {
  int fd;
  unsigned interest;
  int connect_error; /* cached SO_ERROR after a failed connect */
  bool in_use;
} sock_slot;

typedef enum resolve_state {
  RS_FREE = 0,
  RS_PENDING,
  RS_DONE,
} resolve_state;

typedef struct resolve_slot {
  uint32_t req_id;
  uint8_t state;
  bool cancelled;
  char host[256];
  pnet_addr addrs[RESOLVE_MAX_ADDRS];
  size_t count;
  int err;
} resolve_slot;

struct pnet_posix_driver {
  sock_slot *slots;
  int max_sockets;
  int wake_fd;
  struct sockaddr_in wake_addr;
  drv_mutex_t mutex;
  resolve_slot resolves[RESOLVE_SLOTS];
  /* Resolver worker: getaddrinfo() blocks, so it runs on its own thread/
   * task and never on the network task (whose select loop must keep
   * servicing sockets and deadlines). `resolver_inline` is the fallback
   * when the worker could not be started: lookups then run inside wait(). */
  drv_signal_t resolver_signal;
  volatile bool resolver_stop;
  volatile bool resolver_exited;
  bool resolver_running;
  bool resolver_inline;
#if defined(ESP_PLATFORM)
  TaskHandle_t resolver_task;
#else
  pthread_t resolver_thread;
#endif
};

static int map_errno(int e) {
  switch (e) {
    case EAGAIN:
#if EWOULDBLOCK != EAGAIN
    case EWOULDBLOCK:
#endif
    case EINPROGRESS:
    case EALREADY:
      return PNET_IO_AGAIN;
    case ECONNREFUSED:
    case EHOSTUNREACH:
    case ENETUNREACH:
    case EHOSTDOWN:
    case ENETDOWN:
      return PNET_IO_REFUSED;
    case ETIMEDOUT:
      return PNET_IO_TIMEOUT;
    case EADDRINUSE:
      return PNET_IO_ADDRINUSE;
    case ECONNRESET:
    case EPIPE:
    case ECONNABORTED:
    case ENOTCONN:
      return PNET_IO_CLOSED;
    case ENOMEM:
    case ENOBUFS:
    case EMFILE:
    case ENFILE:
      return PNET_IO_NOMEM;
    default:
      return PNET_IO_ERROR;
  }
}

static void set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
#if defined(SO_NOSIGPIPE)
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
}

static int slot_alloc(pnet_posix_driver *d, int fd) {
  for (int i = 0; i < d->max_sockets; i++) {
    if (!d->slots[i].in_use) {
      d->slots[i].in_use = true;
      d->slots[i].fd = fd;
      d->slots[i].interest = 0;
      d->slots[i].connect_error = 0;
      return i;
    }
  }
  return -1;
}

static sock_slot *slot_get(pnet_posix_driver *d, pnet_sock s) {
  if (s < 0 || s >= d->max_sockets || !d->slots[s].in_use) return NULL;
  return &d->slots[s];
}

static bool to_sockaddr(const pnet_addr *addr, struct sockaddr_storage *ss, socklen_t *len) {
  memset(ss, 0, sizeof *ss);
  if (addr->family == 4) {
    struct sockaddr_in *in = (struct sockaddr_in *)ss;
    in->sin_family = AF_INET;
    in->sin_port = htons(addr->port);
    memcpy(&in->sin_addr, addr->addr, 4);
    *len = sizeof *in;
    return true;
  }
#if defined(AF_INET6) && (!defined(ESP_PLATFORM) || defined(CONFIG_LWIP_IPV6))
  if (addr->family == 6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)ss;
    in6->sin6_family = AF_INET6;
    in6->sin6_port = htons(addr->port);
    memcpy(&in6->sin6_addr, addr->addr, 16);
    *len = sizeof *in6;
    return true;
  }
#endif
  return false;
}

static void from_sockaddr(const struct sockaddr *sa, pnet_addr *out) {
  memset(out, 0, sizeof *out);
  if (sa->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)sa;
    out->family = 4;
    memcpy(out->addr, &in->sin_addr, 4);
    out->port = ntohs(in->sin_port);
  }
#if defined(AF_INET6) && (!defined(ESP_PLATFORM) || defined(CONFIG_LWIP_IPV6))
  else if (sa->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)sa;
    out->family = 6;
    memcpy(out->addr, &in6->sin6_addr, 16);
    out->port = ntohs(in6->sin6_port);
  }
#endif
}

/* ------------------------------------------------------------------------ */
/* Driver ops                                                                */
/* ------------------------------------------------------------------------ */

static int drv_resolve(void *ctx, uint32_t req_id, const char *host) {
  pnet_posix_driver *d = ctx;
  if (strlen(host) >= sizeof d->resolves[0].host) return PNET_IO_ERROR;
  mutex_lock(&d->mutex);
  int rc = PNET_IO_NOMEM;
  for (int i = 0; i < RESOLVE_SLOTS; i++) {
    resolve_slot *r = &d->resolves[i];
    if (r->state == RS_FREE) {
      r->req_id = req_id;
      r->state = RS_PENDING;
      r->cancelled = false;
      strcpy(r->host, host);
      r->count = 0;
      r->err = 0;
      rc = 0;
      break;
    }
  }
  mutex_unlock(&d->mutex);
  if (rc == 0) {
    if (d->resolver_running) signal_post(&d->resolver_signal);
    else pnet_posix_driver_wake(d); /* inline fallback: resolved in wait() */
  }
  return rc;
}

static void drv_resolve_cancel(void *ctx, uint32_t req_id) {
  pnet_posix_driver *d = ctx;
  mutex_lock(&d->mutex);
  for (int i = 0; i < RESOLVE_SLOTS; i++) {
    resolve_slot *r = &d->resolves[i];
    if (r->state != RS_FREE && r->req_id == req_id) {
      r->cancelled = true;
      if (r->state == RS_DONE) r->state = RS_FREE;
    }
  }
  mutex_unlock(&d->mutex);
}

static pnet_sock drv_connect(void *ctx, const pnet_addr *addr, int *err) {
  pnet_posix_driver *d = ctx;
  struct sockaddr_storage ss;
  socklen_t len;
  if (!to_sockaddr(addr, &ss, &len)) {
    *err = PNET_IO_ERROR;
    return PNET_SOCK_INVALID;
  }
  int fd = socket(((struct sockaddr *)&ss)->sa_family, SOCK_STREAM, IPPROTO_TCP);
  if (fd < 0) {
    *err = map_errno(errno);
    return PNET_SOCK_INVALID;
  }
  set_nonblock(fd);
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  int slot = slot_alloc(d, fd);
  if (slot < 0) {
    close(fd);
    *err = PNET_IO_NOMEM;
    return PNET_SOCK_INVALID;
  }
  int rc = connect(fd, (struct sockaddr *)&ss, len);
  if (rc < 0 && errno != EINPROGRESS) {
    int e = map_errno(errno);
    if (e != PNET_IO_AGAIN) {
      close(fd);
      d->slots[slot].in_use = false;
      *err = e;
      return PNET_SOCK_INVALID;
    }
  }
  *err = 0;
  return slot;
}

static int drv_connect_status(void *ctx, pnet_sock s) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (!slot) return PNET_IO_ERROR;
  if (slot->connect_error) return slot->connect_error;
  /* Probe writability without blocking. */
  fd_set wfds, efds;
  FD_ZERO(&wfds);
  FD_ZERO(&efds);
  FD_SET(slot->fd, &wfds);
  FD_SET(slot->fd, &efds);
  struct timeval tv = {0, 0};
  int rc = select(slot->fd + 1, NULL, &wfds, &efds, &tv);
  if (rc <= 0) return 0;
  int soerr = 0;
  socklen_t sl = sizeof soerr;
  if (getsockopt(slot->fd, SOL_SOCKET, SO_ERROR, &soerr, &sl) < 0) soerr = errno;
  if (soerr == 0) return 1;
  if (soerr == EINPROGRESS || soerr == EALREADY) return 0;
  slot->connect_error = map_errno(soerr);
  return slot->connect_error;
}

static int drv_read(void *ctx, pnet_sock s, uint8_t *buf, size_t len) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (!slot) return PNET_IO_ERROR;
  ssize_t n = recv(slot->fd, buf, len, 0);
  if (n > 0) return (int)n;
  if (n == 0) return PNET_IO_EOF;
  return map_errno(errno);
}

static int drv_write(void *ctx, pnet_sock s, const uint8_t *buf, size_t len) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (!slot) return PNET_IO_ERROR;
  ssize_t n = send(slot->fd, buf, len, MSG_NOSIGNAL);
  if (n >= 0) return (int)n;
  return map_errno(errno);
}

static void drv_shutdown_write(void *ctx, pnet_sock s) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (slot) shutdown(slot->fd, SHUT_WR);
}

static void drv_close(void *ctx, pnet_sock s) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (!slot) return;
  close(slot->fd);
  slot->in_use = false;
  slot->fd = -1;
  slot->interest = 0;
}

static void drv_interest(void *ctx, pnet_sock s, unsigned flags) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (slot) slot->interest = flags;
}

static pnet_sock drv_listen(void *ctx, const pnet_addr *addr, int backlog, pnet_addr *bound, int *err) {
  pnet_posix_driver *d = ctx;
  struct sockaddr_storage ss;
  socklen_t len;
  if (!to_sockaddr(addr, &ss, &len)) {
    *err = PNET_IO_ERROR;
    return PNET_SOCK_INVALID;
  }
  int fd = socket(((struct sockaddr *)&ss)->sa_family, SOCK_STREAM, IPPROTO_TCP);
  if (fd < 0) {
    *err = map_errno(errno);
    return PNET_SOCK_INVALID;
  }
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  set_nonblock(fd);
  if (bind(fd, (struct sockaddr *)&ss, len) < 0 || listen(fd, backlog > 0 ? backlog : 4) < 0) {
    *err = map_errno(errno);
    close(fd);
    return PNET_SOCK_INVALID;
  }
  struct sockaddr_storage local;
  socklen_t llen = sizeof local;
  if (getsockname(fd, (struct sockaddr *)&local, &llen) == 0) from_sockaddr((struct sockaddr *)&local, bound);
  else *bound = *addr;
  int slot = slot_alloc(d, fd);
  if (slot < 0) {
    close(fd);
    *err = PNET_IO_NOMEM;
    return PNET_SOCK_INVALID;
  }
  *err = 0;
  return slot;
}

static pnet_sock drv_accept(void *ctx, pnet_sock listener, pnet_addr *peer, int *err) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, listener);
  if (!slot) {
    *err = PNET_IO_ERROR;
    return PNET_SOCK_INVALID;
  }
  struct sockaddr_storage ss;
  socklen_t len = sizeof ss;
  int fd = accept(slot->fd, (struct sockaddr *)&ss, &len);
  if (fd < 0) {
    *err = map_errno(errno);
    return PNET_SOCK_INVALID;
  }
  set_nonblock(fd);
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  int ns = slot_alloc(d, fd);
  if (ns < 0) {
    close(fd);
    *err = PNET_IO_NOMEM;
    return PNET_SOCK_INVALID;
  }
  from_sockaddr((struct sockaddr *)&ss, peer);
  *err = 0;
  return ns;
}

static int drv_local_addr(void *ctx, pnet_sock s, pnet_addr *out) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  if (!slot) return PNET_IO_ERROR;
  struct sockaddr_storage ss;
  socklen_t len = sizeof ss;
  if (getsockname(slot->fd, (struct sockaddr *)&ss, &len) < 0) return map_errno(errno);
  from_sockaddr((struct sockaddr *)&ss, out);
  return 0;
}

static int drv_native_handle(void *ctx, pnet_sock s) {
  pnet_posix_driver *d = ctx;
  sock_slot *slot = slot_get(d, s);
  return slot ? slot->fd : -1;
}

static const pnet_driver_ops OPS = {
    .resolve = drv_resolve,
    .resolve_cancel = drv_resolve_cancel,
    .connect = drv_connect,
    .connect_status = drv_connect_status,
    .read = drv_read,
    .write = drv_write,
    .shutdown_write = drv_shutdown_write,
    .close = drv_close,
    .interest = drv_interest,
    .listen = drv_listen,
    .accept = drv_accept,
    .local_addr = drv_local_addr,
    .native_handle = drv_native_handle,
};

const pnet_driver_ops *pnet_posix_driver_ops(void) {
  return &OPS;
}

/* ------------------------------------------------------------------------ */
/* Lifecycle, wait, dispatch                                                 */
/* ------------------------------------------------------------------------ */

pnet_posix_driver *pnet_posix_driver_create(int max_sockets) {
  if (max_sockets < 1) max_sockets = 8;
  pnet_posix_driver *d = calloc(1, sizeof *d);
  if (!d) return NULL;
  d->slots = calloc((size_t)max_sockets, sizeof(sock_slot));
  if (!d->slots) {
    free(d);
    return NULL;
  }
  for (int i = 0; i < max_sockets; i++) d->slots[i].fd = -1;
  d->max_sockets = max_sockets;
  mutex_init(&d->mutex);
  /* Loopback UDP wake socket. */
  d->wake_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (d->wake_fd >= 0) {
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    if (bind(d->wake_fd, (struct sockaddr *)&a, sizeof a) == 0) {
      socklen_t l = sizeof d->wake_addr;
      getsockname(d->wake_fd, (struct sockaddr *)&d->wake_addr, &l);
      set_nonblock(d->wake_fd);
    } else {
      close(d->wake_fd);
      d->wake_fd = -1;
    }
  }
  resolver_start(d);
  return d;
}

void pnet_posix_driver_destroy(pnet_posix_driver *d) {
  if (!d) return;
  resolver_stop(d);
  for (int i = 0; i < d->max_sockets; i++)
    if (d->slots[i].in_use) close(d->slots[i].fd);
  if (d->wake_fd >= 0) close(d->wake_fd);
  mutex_destroy(&d->mutex);
  free(d->slots);
  free(d);
}

void pnet_posix_driver_wake(pnet_posix_driver *d) {
  if (d->wake_fd < 0) return;
  uint8_t byte = 1;
  sendto(d->wake_fd, &byte, 1, MSG_NOSIGNAL, (struct sockaddr *)&d->wake_addr, sizeof d->wake_addr);
}

int pnet_posix_driver_socket_count(pnet_posix_driver *d) {
  int n = 0;
  for (int i = 0; i < d->max_sockets; i++)
    if (d->slots[i].in_use) n++;
  return n;
}

/* Resolve the first pending slot (one blocking getaddrinfo); false when no
 * slot is pending. Results land in the slot under the mutex; the network
 * task hands them to the runtime in dispatch(). */
static bool resolve_one(pnet_posix_driver *d) {
  int idx = -1;
  char host[256];
  mutex_lock(&d->mutex);
  for (int i = 0; i < RESOLVE_SLOTS; i++) {
    resolve_slot *r = &d->resolves[i];
    if (r->state == RS_PENDING && !r->cancelled) {
      idx = i;
      strcpy(host, r->host);
      break;
    }
    if (r->state == RS_PENDING && r->cancelled) r->state = RS_FREE; /* cancelled before it ran */
  }
  mutex_unlock(&d->mutex);
  if (idx < 0) return false;
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  struct addrinfo *res = NULL;
  int rc = getaddrinfo(host, NULL, &hints, &res);
  pnet_addr addrs[RESOLVE_MAX_ADDRS];
  size_t count = 0;
  if (rc == 0) {
    /* IPv4 first, then IPv6 (v1 modules are IPv4-first). */
    for (int pass = 0; pass < 2 && count < RESOLVE_MAX_ADDRS; pass++) {
      for (struct addrinfo *ai = res; ai && count < RESOLVE_MAX_ADDRS; ai = ai->ai_next) {
        if ((pass == 0 && ai->ai_family != AF_INET) || (pass == 1 && ai->ai_family == AF_INET)) continue;
        pnet_addr a;
        from_sockaddr(ai->ai_addr, &a);
        if (a.family == 0) continue;
        bool dup = false;
        for (size_t k = 0; k < count; k++)
          if (addrs[k].family == a.family && memcmp(addrs[k].addr, a.addr, 16) == 0) dup = true;
        if (!dup) addrs[count++] = a;
      }
    }
    freeaddrinfo(res);
  }
  mutex_lock(&d->mutex);
  resolve_slot *r = &d->resolves[idx];
  if (r->state == RS_PENDING) {
    r->state = RS_DONE;
    r->err = rc == 0 && count > 0 ? 0 : PNET_IO_ERROR;
    r->count = count;
    memcpy(r->addrs, addrs, count * sizeof(pnet_addr));
    if (r->cancelled) r->state = RS_FREE;
  }
  mutex_unlock(&d->mutex);
  return true;
}

static void resolver_loop(pnet_posix_driver *d) {
  for (;;) {
    signal_wait(&d->resolver_signal);
    if (d->resolver_stop) break;
    bool any = false;
    while (!d->resolver_stop && resolve_one(d)) any = true;
    /* Results are ready: interrupt the network task's select so dispatch()
     * delivers them now rather than at its next timeout. */
    if (any) pnet_posix_driver_wake(d);
  }
  d->resolver_exited = true;
}

#if defined(ESP_PLATFORM)
static void resolver_task(void *arg) {
  resolver_loop(arg);
  vTaskDelete(NULL);
}
#else
static void *resolver_thread(void *arg) {
  resolver_loop(arg);
  return NULL;
}
#endif

static void resolver_start(pnet_posix_driver *d) {
  if (!signal_init(&d->resolver_signal)) {
    d->resolver_inline = true;
    return;
  }
#if defined(ESP_PLATFORM)
  if (xTaskCreate(resolver_task, "pnet-dns", PNET_POSIX_RESOLVER_STACK, d, PNET_POSIX_RESOLVER_PRIORITY,
                  &d->resolver_task) != pdPASS) {
    signal_destroy(&d->resolver_signal);
    d->resolver_inline = true;
    return;
  }
#else
  if (pthread_create(&d->resolver_thread, NULL, resolver_thread, d) != 0) {
    signal_destroy(&d->resolver_signal);
    d->resolver_inline = true;
    return;
  }
#endif
  d->resolver_running = true;
}

static void resolver_stop(pnet_posix_driver *d) {
  if (!d->resolver_running) return;
  d->resolver_stop = true;
  signal_post(&d->resolver_signal);
#if defined(ESP_PLATFORM)
  /* The task deletes itself after setting resolver_exited; a lookup in
   * flight delays this by at most the resolver's own timeout. */
  while (!d->resolver_exited) vTaskDelay(pdMS_TO_TICKS(5));
  vTaskDelay(pdMS_TO_TICKS(5)); /* let the idle task reclaim the TCB */
#else
  pthread_join(d->resolver_thread, NULL);
#endif
  signal_destroy(&d->resolver_signal);
  d->resolver_running = false;
}

void pnet_posix_driver_wait(pnet_posix_driver *d, int timeout_ms) {
  /* Lookups normally run on the resolver worker; only the fallback (worker
   * unavailable) resolves here, blocking this call like the v1 driver did. */
  if (d->resolver_inline) {
    while (resolve_one(d)) {
    }
  }
  fd_set rfds, wfds;
  FD_ZERO(&rfds);
  FD_ZERO(&wfds);
  int maxfd = -1;
  if (d->wake_fd >= 0) {
    FD_SET(d->wake_fd, &rfds);
    maxfd = d->wake_fd;
  }
  for (int i = 0; i < d->max_sockets; i++) {
    sock_slot *s = &d->slots[i];
    if (!s->in_use || s->fd < 0) continue;
    if (s->interest & PNET_INTEREST_READ) FD_SET(s->fd, &rfds);
    if (s->interest & PNET_INTEREST_WRITE) FD_SET(s->fd, &wfds);
    if (s->interest && s->fd > maxfd) maxfd = s->fd;
  }
  struct timeval tv;
  struct timeval *ptv = NULL;
  if (timeout_ms >= 0) {
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    ptv = &tv;
  }
  int rc = select(maxfd + 1, &rfds, &wfds, NULL, ptv);
  if (rc > 0 && d->wake_fd >= 0 && FD_ISSET(d->wake_fd, &rfds)) {
    uint8_t drain[16];
    while (recv(d->wake_fd, drain, sizeof drain, 0) > 0) {
    }
  }
}

void pnet_posix_driver_dispatch(pnet_posix_driver *d, pnet_runtime *rt) {
  for (int i = 0; i < RESOLVE_SLOTS; i++) {
    mutex_lock(&d->mutex);
    resolve_slot *r = &d->resolves[i];
    bool done = r->state == RS_DONE;
    resolve_slot copy;
    if (done) {
      copy = *r;
      r->state = RS_FREE;
    }
    mutex_unlock(&d->mutex);
    if (done && !copy.cancelled) pnet_runtime_resolve_done(rt, copy.req_id, copy.addrs, copy.count, copy.err);
  }
}
