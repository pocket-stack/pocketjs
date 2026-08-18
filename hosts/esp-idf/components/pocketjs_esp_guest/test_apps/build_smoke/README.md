# Build smoke

This app compiles the task-owned Guest component, mounts a frozen-binding
factory, calls its cached frame twice, invokes a registered Guest function
through the execution guard, and executes a bounded Promise job. Build it for
both ESP-IDF profiles with the pinned v6.0.2 toolchain:

```sh
idf.py -B build-esp32s3 -DIDF_TARGET=esp32s3 build
idf.py -B build-esp32p4 -DIDF_TARGET=esp32p4 build
```

Build success is not a network capability admission.
