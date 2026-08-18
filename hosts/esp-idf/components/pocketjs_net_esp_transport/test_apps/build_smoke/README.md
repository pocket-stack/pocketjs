# ESP transport build smoke

Build this app with exact ESP-IDF v6.0.2 for both supported targets. It checks
that the public descriptor remains conservative. It does not configure Wi-Fi,
perform network I/O, or advertise a PocketJS capability.

```sh
idf.py -B build-esp32s3 -DIDF_TARGET=esp32s3 build
idf.py -B build-esp32p4 -DIDF_TARGET=esp32p4 build
```
