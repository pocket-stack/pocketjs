# PocketJS iPhone 4S host

This host targets the exact `iPhone4,1` / iOS 6.1.3 / `10B329` hardware tuple.
It compiles the shared legacy UIKit runtime for ARMv7 and links it against a
local sysroot extracted from the operator-provided, validated restore image.
Apple system binaries are never committed or included in the npm package.

The wrapper defaults to required OpenGL ES 1.1. Its UIKit view uses density 2
and accepts only a 640×960 renderbuffer for the 320×480 logical surface.
SpringBoard artwork is baked from the exact iPhone 2G `Icon.png`: the 1× file is
byte-identical and the Retina file is an integer 2× expansion, preserving its
precomposed round mask, chrome bevel, and glass highlight.

Use `bun iphone4s doctor`, `bun iphone4s prepare-sysroot`, and then the build,
deploy, launch, status, and capture commands documented in `docs/IPHONE4S.md`.
