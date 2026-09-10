#include "../../hosts/ios-legacy/fold-math.h"
#include <assert.h>

#define CLOSE(a,b) assert(fabs((a)-(b)) < 1e-7)
static void multiply(const double a[9], const double b[9], double out[9]) {
  for (int r=0; r<3; ++r) for (int c=0; c<3; ++c) {
    out[r*3+c]=0;
    for (int k=0; k<3; ++k) out[r*3+c]+=a[r*3+k]*b[k*3+c];
  }
}
static void euler(double yaw, double pitch, double roll, double out[9]) {
  double rx[9]={1,0,0,0,cos(pitch),-sin(pitch),0,sin(pitch),cos(pitch)};
  double ry[9]={cos(yaw),0,sin(yaw),0,1,0,-sin(yaw),0,cos(yaw)};
  double rz[9]={cos(roll),-sin(roll),0,sin(roll),cos(roll),0,0,0,1}, tmp[9];
  multiply(ry,rx,tmp); multiply(rz,tmp,out);
}
static double area(const FoldPoint *p, int n) {
  double a=0;
  for (int i=0; i<n; ++i) { int j=(i+1)%n; a+=p[i].x*p[j].y-p[j].x*p[i].y; }
  return fabs(a)/2;
}
static void check_projection(double yaw, double pitch, double roll, double w, double h, double eye) {
  double device[9], r[9];
  euler(yaw,pitch,roll,device);
  /* Independent physical screen transform in image coordinates. */
  for (int i=0; i<3; ++i) for (int j=0; j<3; ++j)
    r[i*3+j]=device[i*3+j]*((i==1) != (j==1) ? -1 : 1);
  FoldPose pose=fold_pose(fold_quaternion(device),w,h,eye);
  for (int i=0; i<9; ++i) CLOSE(pose.rotation[i],r[i]);
  double lift=fabs(r[6])*w/2+fabs(r[7])*h/2;
  for (int row=1; row<6; ++row) for (int col=1; col<6; ++col) {
    double x=w*col/6, y=h*row/6;
    double world[3]={r[0]*(x-w/2)+r[1]*(y-h/2),
                     r[3]*(x-w/2)+r[4]*(y-h/2),
                     r[6]*(x-w/2)+r[7]*(y-h/2)+lift};
    /* Project the physical glass point through a fixed camera onto z=0. */
    double sx=world[0]*eye/(eye-world[2]), sy=world[1]*eye/(eye-world[2]);
    FoldRay sample=fold_ray(&pose,x,y);
    CLOSE(sample.x,sx+w/2); CLOSE(sample.y,sy+h/2);
    assert(isfinite(sample.x) && isfinite(sample.y) && sample.depth>0);
    assert(sample.radius>=0 && sample.radius<=40 && sample.attenuation>=0.4-1e-8);

    /* Independently intersect eye -> fixed content with the physical glass,
     * transform the intersection back into screen pixels, and sample again.
     * The content point must remain in the calibrated plane at any attitude. */
    double t=r[8]*(lift-eye)/(r[2]*sx+r[5]*sy-r[8]*eye);
    double hit[3]={t*sx,t*sy,eye-t*eye-lift};
    double px=r[0]*hit[0]+r[3]*hit[1]+r[6]*hit[2]+w/2;
    double py=r[1]*hit[0]+r[4]*hit[1]+r[7]*hit[2]+h/2;
    CLOSE(px,x); CLOSE(py,y);
    FoldRay fixed=fold_ray(&pose,px,py);
    CLOSE(fixed.x,sx+w/2); CLOSE(fixed.y,sy+h/2);
  }

  /* Diagonal blur bands partition the whole screen, including radius > 40. */
  FoldPoint screen[4]={{0,0},{w,0},{w,h},{0,h}};
  double covered=0;
  if (pose.lift<1e-8) covered=w*h;
  else for (int i=0; i<FOLD_LEVELS; ++i) {
    FoldPoint a[8], b[8];
    double lo=fold_radii[i]/0.12;
    double hi=i+1<FOLD_LEVELS ? fold_radii[i+1]/0.12 : 2*pose.lift+1;
    int n=fold_clip(&pose,screen,4,a,lo,1);
    n=fold_clip(&pose,a,n,b,hi,0);
    assert(n<=6);
    for (int j=0; j<n; ++j) {
      double gap=fold_gap(&pose,b[j].x,b[j].y);
      assert(gap>=lo-1e-7 && gap<=hi+1e-7);
    }
    covered+=area(b,n);
  }
  assert(fabs(covered-w*h)<1e-6);
}
int main(void) {
  double cases[][3]={{0,0,0},{0.9,0,0},{-0.9,0,0},{0,0.9,0},
    {0,-0.9,0},{0,0,0.7},{0.9,-0.4,0.3},{-0.8,0.5,-0.2},{0,1.48,0}};
  for (int shape=0; shape<2; ++shape) for (int distance=0; distance<2; ++distance)
    for (unsigned i=0; i<sizeof cases/sizeof cases[0]; ++i)
      check_projection(cases[i][0],cases[i][1],cases[i][2],
        shape ? 480 : 320,shape ? 320 : 480,distance ? 900 : 2053.54);

  double raw[9], reference[9], world[9], recovered[9];
  euler(0.8,-0.3,0.2,raw); euler(-0.5,0.4,0.6,reference);
  multiply(reference,raw,world);
  fold_matrix(fold_relative(fold_quaternion(reference),fold_quaternion(world)),recovered);
  for (int i=0; i<9; ++i) CLOSE(recovered[i],raw[i]);
  fold_matrix(fold_relative(fold_quaternion(world),fold_quaternion(world)),recovered);
  for (int i=0; i<9; ++i) CLOSE(recovered[i],i%4==0 ? 1 : 0);
  double transposed[9]; fold_device_matrix(raw,1,transposed);
  for (int i=0; i<3; ++i) for (int j=0; j<3; ++j) CLOSE(transposed[i*3+j],raw[j*3+i]);

  /* Prediction rotates around current device axes even after a compound pose. */
  double step[9], expected[9]; euler(0,0.04,0,step); multiply(raw,step,expected);
  fold_matrix(fold_predict(fold_quaternion(raw),1,0,0,0.04),recovered);
  for (int i=0; i<9; ++i) CLOSE(recovered[i],expected[i]);
  FoldQuaternion q=fold_quaternion(raw), neg={-q.x,-q.y,-q.z,-q.w};
  fold_matrix(fold_smooth(q,neg,0.7),recovered);
  for (int i=0; i<9; ++i) CLOSE(recovered[i],raw[i]);
  double before[9], after[9]; euler(M_PI-0.01,0,0,before); euler(-M_PI+0.01,0,0,after);
  fold_matrix(fold_smooth(fold_quaternion(before),fold_quaternion(after),0.5),recovered);
  CLOSE(recovered[0],-1); CLOSE(recovered[4],1); CLOSE(recovered[8],-1);

  /* Crossing a yaw sign under roll must not switch a corner anchor. */
  euler(-1e-9,0.4,0.5,before); euler(1e-9,0.4,0.5,after);
  FoldPose left=fold_pose(fold_quaternion(before),320,480,2053.54);
  FoldPose right=fold_pose(fold_quaternion(after),320,480,2053.54);
  FoldRay a=fold_ray(&left,120,220), b=fold_ray(&right,120,220);
  CLOSE(a.x,b.x); CLOSE(a.y,b.y);
  return 0;
}
