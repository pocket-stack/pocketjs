#ifndef POCKET_FOLD_MATH_H
#define POCKET_FOLD_MATH_H
#include <math.h>

/* DuoLikeAnimation's fixed eye / far-edge hinge model, in screen points.
 * See apps/duo-fold/ATTRIBUTION.md for the upstream MIT notice. */
typedef struct { double x, y, depth, radius, attenuation; } FoldRay;
static inline double fold_clamp(double x, double lo, double hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
static inline FoldRay fold_ray(double x, double y, double angle,
                               double width, double height, double eye) {
  double hinge = angle > 0 ? width : 0;
  double d = fabs(x - hinge), tilt = fabs(angle);
  double gx = hinge + (angle > 0 ? -1 : 1) * d * cos(tilt);
  double gap = d * sin(tilt), depth = eye - gap;
  double radius = 0.12 * gap;
  FoldRay ray = {0, 0, depth, radius, fmax(1 - 0.015 * radius, 0)};
  if (depth > 0.001) {
    ray.x = width / 2 + (gx - width / 2) * eye / depth;
    ray.y = height / 2 + (y - height / 2) * eye / depth;
  }
  return ray;
}

/* Matrices map device coordinates into the reference frame, row-major.
 * dot(reference X, current Z) / dot(reference Z, current Z) isolates the
 * screen Y tilt without confusing roll with a fold. */
static inline double fold_tilt(const double reference[9], const double current[9]) {
  double x = reference[0]*current[2] + reference[3]*current[5] + reference[6]*current[8];
  double z = reference[2]*current[2] + reference[5]*current[5] + reference[8]*current[8];
  return atan2(x, z);
}
static inline void fold_device_matrix(const double raw[9], int transpose, double out[9]) {
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c) out[r*3+c] = raw[transpose ? c*3+r : r*3+c];
}
#define FOLD_WIDTH 320
#define FOLD_HEIGHT 480
#define FOLD_TEXTURE_WIDTH 512
#define FOLD_TEXTURE_HEIGHT 1024
#define FOLD_PADDING 64
#define FOLD_LEVELS 8
static const double fold_radii[FOLD_LEVELS] = {0, 2, 4, 8, 12, 20, 30, 40};
#endif
