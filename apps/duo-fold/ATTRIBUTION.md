# Pocket Fold

The fixed-eye projection, distance-based blur and darkening,
and calibrated Core Motion tracking are adapted from
[Elijah Semyonov's DuoLikeAnimation](https://github.com/elijah-semyonov/DuoLikeAnimation).
Reference revision: `be927684c8585ce3d90761095284329dfdeff901`.
The upstream source uses SwiftUI and Metal. This port uses a PocketJS Solid
control panel, a local HostOps service, and OpenGL ES 1.1 projective textures.
It extends the source's single-axis far-edge hinge to a full calibrated attitude
with a fixed screen center in X/Y and a Z lift to the content plane.

Blur uses eight baked filled-disk convolution levels, interpolated across the screen.
It omits the upstream shader's per-pixel random rotation. The screenshot is
captured from the user's device and is not included in the source distribution.

The upstream MIT license follows:

MIT License

Copyright (c) 2026 Elijah Semyonov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
