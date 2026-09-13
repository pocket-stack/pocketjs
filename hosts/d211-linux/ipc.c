/*
 * d211 ipc host module: SOCK_SEQPACKET client for the local daemon.
 * One datagram is one framed message; send/recv are non-blocking so the
 * guest's per-frame pump owns the timing. close() releases the socket.
 */

#include "ipc.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int ipc_fd = -1;

/** 关闭当前连接（未连接时为空操作）。 */
static void d211_ipc_close(void) {
  if (ipc_fd >= 0) {
    close(ipc_fd);
    ipc_fd = -1;
  }
}

/** 连接 Unix 域套接字（SEQPACKET；一个数据报一帧）。 */
static int d211_ipc_connect(const char *path) {
  if (path == 0) return -1;
  d211_ipc_close();
  if (strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
    return -1;
  }
  int fd = socket(AF_UNIX, SOCK_SEQPACKET, 0);
  if (fd < 0) return -1;
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) {
    close(fd);
    return -1;
  }
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(fd);
    return -1;
  }
  ipc_fd = fd;
  return 0;
}

/** 发送一个完整帧；驱动暂满返回 -1，由 guest 下一帧重试。 */
static int d211_ipc_send(const uint8_t *data, size_t length) {
  if (ipc_fd < 0) return -1;
  ssize_t count = send(ipc_fd, data, length, MSG_DONTWAIT);
  if (count < 0) return -1;
  return (int)count;
}

/** 非阻塞收一个数据报；空返回 0，错误返回 -1。 */
static int d211_ipc_recv(uint8_t *buffer, size_t capacity) {
  if (ipc_fd < 0) return -1;
  ssize_t count = recv(ipc_fd, buffer, capacity, MSG_DONTWAIT);
  if (count < 0) {
    return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
  }
  return (int)count;
}

static const PocketIpcOps d211_ipc_ops = {
  .connect = d211_ipc_connect,
  .close = d211_ipc_close,
  .send = d211_ipc_send,
  .recv = d211_ipc_recv,
};

/** 取 IPC ops 表。 */
const PocketIpcOps *d211_ipc_ops_table(void) {
  return &d211_ipc_ops;
}
