# Build smoke

This app compiles the HTTP Client Core, HTTP/1.1 wire codec, and ESP-IDF
transport together. It asserts the experimental descriptor and verifies that
an HTTPS request fails before the permission callback or transport I/O.
