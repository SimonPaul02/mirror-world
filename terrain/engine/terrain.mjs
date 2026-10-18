import assert from "node:assert/strict";
import { fromArrayBuffer } from "geotiff";

export class TerrainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Bilinear sampling in sample-center coordinates. No extrapolation or zero fill.
export function createSampler({ values, width, height, west, north, dx, dy, nodata = null }) {
  assert(width >= 2 && height >= 2 && values.length === width * height);
  assert(dx > 0 && dy > 0);
  const bounds = [west, north - (height - 1) * dy, west + (width - 1) * dx, north];
  function sample(longitude, latitude) {
    const details = { longitude_deg: longitude, latitude_deg: latitude };
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
        longitude < bounds[0] || longitude > bounds[2] || latitude < bounds[1] || latitude > bounds[3]) {
      throw new TerrainError("OUT_OF_BOUNDS", "Position is outside terrain sample-center coverage", details);
    }
    // Clamp only sub-pixel roundoff after the explicit geographic bounds check.
    const x = Math.max(0, Math.min(width - 1, (longitude - west) / dx));
    const y = Math.max(0, Math.min(height - 1, (north - latitude) / dy));
    const x0 = Math.min(Math.floor(x), width - 2), y0 = Math.min(Math.floor(y), height - 2);
    const tx = x - x0, ty = y - y0;
    const neighbors = [
      [y0 * width + x0, (1 - tx) * (1 - ty)], [y0 * width + x0 + 1, tx * (1 - ty)],
      [(y0 + 1) * width + x0, (1 - tx) * ty], [(y0 + 1) * width + x0 + 1, tx * ty]
    ];
    let result = 0;
    for (const [index, weight] of neighbors) {
      if (weight === 0) continue;
      const value = values[index];
      if (!Number.isFinite(value) || (nodata !== null && value === nodata)) {
        throw new TerrainError("MISSING_ELEVATION", "Interpolation requires an unavailable elevation", details);
      }
      result += value * weight;
    }
    return result;
  }
  return { sample, bounds, width, height, dx, dy };
}

export async function readTerrain(bytes, manifest) {
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const image = await tiff.getImage();
  const geo = image.getGeoKeys();
  assert.equal(geo.GeographicTypeGeoKey, 4326, "Only WGS84 geographic rasters are supported");
  assert.equal(geo.GTRasterTypeGeoKey, 2, "Packaged elevation must use PixelIsPoint");
  assert.equal(image.getSamplesPerPixel(), 1, "Elevation must be a single band");
  const [west, north] = image.getOrigin();
  const [dx, ry] = image.getResolution();
  const dy = -ry;
  assert(dx > 0 && dy > 0, "Expected an unrotated north-up raster");
  const width = image.getWidth(), height = image.getHeight();
  assert.equal(width, manifest.inspection.width);
  assert.equal(height, manifest.inspection.height);
  const expected = [...manifest.grid.sample_origin_lon_lat, ...manifest.grid.pixel_size_degrees];
  [west, north, dx, dy].forEach((value, i) =>
    assert(Math.abs(value - expected[i]) < 1e-12, "TIFF georeferencing differs from manifest"));
  const values = await image.readRasters({ samples: [0], interleave: true });
  const sampler = createSampler({ values, width, height, west, north, dx, dy, nodata: image.getGDALNoData() });
  sampler.bounds.forEach((value, i) => assert(Math.abs(value - manifest.grid.sample_center_bounds_wsen[i]) < 1e-12,
    "Manifest sample-center bounds differ from the TIFF"));
  return sampler;
}
