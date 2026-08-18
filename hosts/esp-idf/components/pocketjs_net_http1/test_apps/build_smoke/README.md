# Bounded HTTP/1.1 wire corpus app

This app runs request encoder (including case-insensitive rejection of the
Fetch-forbidden `CONNECT`, `TRACE`, and `TRACK` methods), response
fragmentation, framing, body-credit, chunk, and trailer assertions in
`app_main`. A successful boot prints:

```text
pocketjs_net_http1: corpus passed
```

Use the pinned ESP-IDF v6.0.2 worktree for both targets:

```sh
idf.py -B build-esp32s3 -DIDF_TARGET=esp32s3 build
idf.py -B build-esp32p4 -DIDF_TARGET=esp32p4 build
```

The same corpus can run on macOS without ESP-IDF:

```sh
clang -std=c11 -Wall -Wextra -Werror \
  -DPOCKETJS_NET_HTTP1_HOST_TEST \
  -I../../include ../../src/http1_wire.c main/build_smoke.c \
  -o /tmp/pocketjs-net-http1-corpus
/tmp/pocketjs-net-http1-corpus
```

Build or corpus success validates the wire codec only. It does not admit the
PocketJS HTTP Client capability.
