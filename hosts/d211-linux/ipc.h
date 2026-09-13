/*
 * d211 ipc host module: PocketIpcOps table accessor.
 * One SOCK_SEQPACKET connection to the local daemon (forkliftd).
 */

#ifndef D211_IPC_H
#define D211_IPC_H

#include "pocket_runtime.h"

/** 取 IPC ops 表（装入运行时前调用 pocket_runtime_set_ipc_ops）。 */
const PocketIpcOps *d211_ipc_ops_table(void);

#endif
