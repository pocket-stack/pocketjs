# ESP runtime build smoke

This app compiles the formal ABI 1.1 binding with the experimental ESP-IDF
HTTP runtime, mounts it through `pocketjs_esp_guest`, exercises `getLimits`
and a guarded `nextCompletion` service turn, then completes the three-phase
shutdown contract. A frame retained by the Guest also verifies that binding
closures fail with `TypeError` after runtime destruction instead of accessing
freed runtime memory.

Build both targets with the exact PocketJS ESP-IDF baseline:

```sh
source /Users/halfsweet/Documents/GitHub/esp-idf-v6-pocketjs-network/export.sh
idf.py -B build-current-esp32s3 set-target esp32s3
idf.py -B build-current-esp32s3 build
idf.py -B build-current-esp32p4 set-target esp32p4
idf.py -B build-current-esp32p4 build
```

The P4 defaults select **ESP32-P4 revision 1.0 or newer** and the
`SELECTS_REV_LESS_V3` compatibility path required by the Tab5 revision 1.3
silicon. They also retain the 1000 Hz FreeRTOS tick. The smoke app does not
write eFuses or modify the Tab5 ESP32-C6 companion.

The component descriptor deliberately keeps public capability advertisement
disabled while redirect URL differential conformance, descriptor aggregation,
resource admission, and the complete hardware gate remain incomplete.
