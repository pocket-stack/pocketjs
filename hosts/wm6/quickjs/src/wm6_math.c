#include <math.h>

/*
 * The Windows CE CRT predates C99 and does not export fmax/fmin. Keep these
 * shims in the QuickJS-owned executable so no allocator or CRT state crosses
 * a future host ABI.
 */
double fmax(double left, double right)
{
    if (isnan(left))
        return right;
    if (isnan(right))
        return left;
    return left > right ? left : right;
}

double fmin(double left, double right)
{
    if (isnan(left))
        return right;
    if (isnan(right))
        return left;
    return left < right ? left : right;
}
