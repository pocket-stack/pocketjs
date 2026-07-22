// Target-density asset selection shared by the app baker.
//
// Application source always names the logical 1x asset (`logo.png`). A build
// may substitute a same-directory density sibling (`logo@2x.png`) while
// keeping the pak key unchanged. The 1x file remains the source of truth for
// intrinsic size, so a malformed sibling fails at build time instead of
// silently changing layout.

export interface RasterDimensions {
  readonly width: number;
  readonly height: number;
}

function checkedRasterDensity(rasterDensity: number): number {
  if (!Number.isInteger(rasterDensity) || rasterDensity < 1 || rasterDensity > 255) {
    throw new RangeError(
      `raster density must be an integer from 1 through 255, got ${rasterDensity}`,
    );
  }
  return rasterDensity;
}

/** Insert `@Nx` immediately before the final extension, or append it. */
export function densityVariantPath(path: string, rasterDensity: number): string {
  rasterDensity = checkedRasterDensity(rasterDensity);
  if (rasterDensity === 1) return path;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return `${path}@${rasterDensity}x`;
  return `${path.slice(0, dot)}@${rasterDensity}x${path.slice(dot)}`;
}

/** Require a density sibling to represent exactly the same logical image. */
export function assertDensityVariantDimensions(
  base: RasterDimensions,
  variant: RasterDimensions,
  rasterDensity: number,
  basePath: string,
  variantPath: string,
): void {
  rasterDensity = checkedRasterDensity(rasterDensity);
  const expectedWidth = base.width * rasterDensity;
  const expectedHeight = base.height * rasterDensity;
  if (variant.width === expectedWidth && variant.height === expectedHeight) return;
  throw new Error(
    `density asset ${variantPath} is ${variant.width}x${variant.height}; ` +
      `expected ${expectedWidth}x${expectedHeight} for ${basePath} ` +
      `(${base.width}x${base.height} @${rasterDensity}x)`,
  );
}
