#ifndef POCKET_FOLD_MATH_H
#define POCKET_FOLD_MATH_H
#include <math.h>

/* Fixed-eye ray/plane projection, extended to the full calibrated attitude.
 * See apps/duo-fold/ATTRIBUTION.md for the upstream MIT notice. */
typedef struct { double x, y, depth, radius, attenuation; } FoldRay;
typedef struct { double x, y; } FoldPoint;
typedef struct { double x, y, z, w; } FoldQuaternion;
typedef struct {
  double rotation[9], width, height, eye, lift;
} FoldPose;
static inline double fold_clamp(double x, double lo, double hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
static inline FoldQuaternion fold_normalize(FoldQuaternion q) {
  double n = sqrt(q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w);
  if (n < 1e-12) return (FoldQuaternion){0, 0, 0, 1};
  return (FoldQuaternion){q.x/n, q.y/n, q.z/n, q.w/n};
}
static inline FoldQuaternion fold_multiply(FoldQuaternion a, FoldQuaternion b) {
  return (FoldQuaternion){
    a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
    a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z
  };
}
static inline FoldQuaternion fold_quaternion(const double m[9]) {
  FoldQuaternion q;
  double s, trace = m[0] + m[4] + m[8];
  if (trace > 0) {
    s = sqrt(trace + 1) * 2;
    q = (FoldQuaternion){(m[7]-m[5])/s, (m[2]-m[6])/s, (m[3]-m[1])/s, s/4};
  } else if (m[0] > m[4] && m[0] > m[8]) {
    s = sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = (FoldQuaternion){s/4, (m[1]+m[3])/s, (m[2]+m[6])/s, (m[7]-m[5])/s};
  } else if (m[4] > m[8]) {
    s = sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = (FoldQuaternion){(m[1]+m[3])/s, s/4, (m[5]+m[7])/s, (m[2]-m[6])/s};
  } else {
    s = sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = (FoldQuaternion){(m[2]+m[6])/s, (m[5]+m[7])/s, s/4, (m[3]-m[1])/s};
  }
  return fold_normalize(q);
}
static inline void fold_matrix(FoldQuaternion q, double m[9]) {
  q = fold_normalize(q);
  double x=q.x, y=q.y, z=q.z, w=q.w;
  m[0]=1-2*(y*y+z*z); m[1]=2*(x*y-z*w); m[2]=2*(x*z+y*w);
  m[3]=2*(x*y+z*w); m[4]=1-2*(x*x+z*z); m[5]=2*(y*z-x*w);
  m[6]=2*(x*z-y*w); m[7]=2*(y*z+x*w); m[8]=1-2*(x*x+y*y);
}
/* Gyroscope rates are in the current device frame: extrapolate on the right. */
static inline FoldQuaternion fold_predict(FoldQuaternion q, double x, double y, double z, double dt) {
  double speed = sqrt(x*x+y*y+z*z), half = speed*dt/2;
  double scale = speed > 1e-12 ? sin(half)/speed : dt/2;
  return fold_normalize(fold_multiply(q, (FoldQuaternion){x*scale,y*scale,z*scale,cos(half)}));
}
static inline FoldQuaternion fold_smooth(FoldQuaternion a, FoldQuaternion b, double alpha) {
  double dot = a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w;
  if (dot < 0) { b = (FoldQuaternion){-b.x,-b.y,-b.z,-b.w}; dot = -dot; }
  double u = 1-alpha, v = alpha;
  if (dot < 0.9995) {
    double theta = acos(fold_clamp(dot, -1, 1)), s = sin(theta);
    u = sin((1-alpha)*theta)/s; v = sin(alpha*theta)/s;
  }
  return fold_normalize((FoldQuaternion){u*a.x+v*b.x,u*a.y+v*b.y,u*a.z+v*b.z,u*a.w+v*b.w});
}
static inline void fold_device_matrix(const double raw[9], int transpose, double out[9]) {
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c) out[r*3+c] = raw[transpose ? c*3+r : r*3+c];
}
static inline FoldQuaternion fold_relative(FoldQuaternion reference, FoldQuaternion current) {
  reference = (FoldQuaternion){-reference.x,-reference.y,-reference.z,reference.w};
  return fold_normalize(fold_multiply(reference, current));
}
static inline FoldPose fold_pose(FoldQuaternion attitude, double width, double height, double eye) {
  FoldPose pose = {{0}, width, height, eye, 0};
  fold_matrix(attitude, pose.rotation);
  /* Core Motion Y points up; framebuffer Y points down. Change both bases. */
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c)
      if ((r == 1) != (c == 1)) pose.rotation[r*3+c] *= -1;
  /* Keep the screen center fixed in X/Y. Lift only in Z so the lowest corner
   * touches the content plane; a sign change never switches an X/Y hinge. */
  pose.lift = fabs(pose.rotation[6])*width/2 + fabs(pose.rotation[7])*height/2;
  return pose;
}
static inline double fold_gap(const FoldPose *pose, double x, double y) {
  return pose->rotation[6]*(x-pose->width/2) + pose->rotation[7]*(y-pose->height/2) + pose->lift;
}
static inline FoldRay fold_ray(const FoldPose *pose, double x, double y) {
  const double *r = pose->rotation;
  double dx=x-pose->width/2, dy=y-pose->height/2;
  double gx=r[0]*dx+r[1]*dy, gy=r[3]*dx+r[4]*dy;
  double gap=fold_gap(pose,x,y), depth=pose->eye-gap;
  double radius=fold_clamp(0.12*gap,0,40);
  FoldRay ray = {0,0,depth,radius,1-0.015*radius};
  if (depth > 0.001) {
    ray.x=pose->width/2+gx*pose->eye/depth;
    ray.y=pose->height/2+gy*pose->eye/depth;
  }
  return ray;
}
/* Clip convex screen polygons by a constant gap. Gap is affine in screen X/Y,
 * so each blur band stays exact for yaw, pitch and roll with <= 6 vertices. */
static inline int fold_clip(const FoldPose *pose, const FoldPoint *in, int count,
                            FoldPoint *out, double gap, int above) {
  int n=0;
  if (!count) return 0;
  FoldPoint a=in[count-1];
  double da=(fold_gap(pose,a.x,a.y)-gap)*(above ? 1 : -1);
  for (int i=0; i<count; ++i) {
    FoldPoint b=in[i];
    double db=(fold_gap(pose,b.x,b.y)-gap)*(above ? 1 : -1);
    if ((da >= 0) != (db >= 0)) {
      double t=da/(da-db);
      out[n++]=(FoldPoint){a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t};
    }
    if (db >= 0) out[n++]=b;
    a=b; da=db;
  }
  return n;
}
#define FOLD_WIDTH 320
#define FOLD_HEIGHT 480
#define FOLD_TEXTURE_WIDTH 512
#define FOLD_TEXTURE_HEIGHT 1024
#define FOLD_PADDING 64
#define FOLD_LEVELS 8
static const double fold_radii[FOLD_LEVELS] = {0, 2, 4, 8, 12, 20, 30, 40};
#endif
