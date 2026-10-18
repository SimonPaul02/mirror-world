/**
 * One-time preparation of the flight areas listed in terrain/regions.json.
 *
 * Every region is a window of the same Copernicus GLO-30 DSM that the packaged
 * Odesa crop comes from, read keyless from the AWS Open Data mirror over HTTP
 * range requests, so only the window travels rather than a whole degree tile.
 * Runtime never touches the network for terrain: the output is checksummed into
 * a manifest and read from disk, exactly like the packaged crop.
 *
 * Samples are decimated, never resampled, so every value is an untouched source
 * sample and the grid stays an honest subset of GLO-30.
 *
 *   node scripts/fetch-regions.mjs [id ...]
 */
import { fromUrl, writeArrayBuffer } from "geotiff";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("terrain/regions.json", ROOT), "utf8"));
const GEOID_SOURCE = "https://cdn.proj.org/us_nga_egm08_25.tif";
/** Keep every second source sample: 60 m posts, ~2 MB a region instead of ~8. */
const DECIMATE = 2;
/** The geoid grid is coarse; pad well past the box so lookups never fall off. */
const GEOID_PAD_DEG = 0.2;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sourceUrl(lon, lat) {
  const id = `Copernicus_DSM_COG_10_N${String(Math.floor(lat)).padStart(2, "0")}_00` +
    `_E${String(Math.floor(lon)).padStart(3, "0")}_00_DEM`;
  return `https://copernicus-dem-30m.s3.amazonaws.com/${id}/${id}.tif`;
}

/** Horn's 3x3 slope/aspect against a 315 degree sun, 45 degrees up. */
function hillshade(values, width, height, dxDeg, dyDeg, northDeg) {
  const shade = new Uint8Array(width * height);
  const midLat = northDeg - (height - 1) * dyDeg / 2;
  const xScale = dxDeg * 111_320 * Math.cos(midLat * Math.PI / 180);
  const yScale = dyDeg * 110_540;
  const azimuth = (360 - 315 + 90) * Math.PI / 180, zenith = (90 - 45) * Math.PI / 180;
  const at = (x, y) => values[Math.min(height - 1, Math.max(0, y)) * width +
    Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const d = at(x - 1, y), f = at(x + 1, y);
      const g = at(x - 1, y + 1), h = at(x, y + 1), i = at(x + 1, y + 1);
      const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * xScale);
      const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * yScale);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const lit = Math.cos(zenith) * Math.cos(slope) +
        Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect);
      // 0 is the transparent sentinel in the viewer, so the floor is 1.
      shade[y * width + x] = Math.max(1, Math.min(255, Math.round(255 * Math.max(0, lit))));
    }
  }
  return shade;
}

async function geoidCrop(west, south, east, north) {
  const image = await (await fromUrl(GEOID_SOURCE)).getImage();
  const [ox, oy] = image.getOrigin();
  const [gdx, gry] = image.getResolution();
  const gdy = -gry;
  const x0 = Math.floor((west - GEOID_PAD_DEG - ox) / gdx);
  const x1 = Math.ceil((east + GEOID_PAD_DEG - ox) / gdx) + 1;
  const y0 = Math.floor((oy - (north + GEOID_PAD_DEG)) / gdy);
  const y1 = Math.ceil((oy - (south - GEOID_PAD_DEG)) / gdy) + 1;
  const values = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
  return {
    source: GEOID_SOURCE, license: "Public Domain",
    attribution: "NGA EGM2008; GeographicLib / PROJ grid",
    documentation: "https://cdn.proj.org/us_nga_README.txt",
    conversion: "ellipsoidal_height_m = altitude_egm2008_m + geoid_undulation_m",
    width: x1 - x0, height: y1 - y0, west: ox + x0 * gdx, north: oy - y0 * gdy,
    dx: gdx, dy: gdy, values: Array.from(values)
  };
}

async function build(region) {
  const [reqW, reqS, reqE, reqN] = region.bounds_wsen;
  const url = sourceUrl(reqW, reqS);
  const image = await (await fromUrl(url)).getImage();
  const [ox, oy] = image.getOrigin();
  const [sdx, sry] = image.getResolution();
  const sdy = -sry;

  // Snap to whole source samples so no value is interpolated.
  const col0 = Math.round((reqW - ox) / sdx), col1 = Math.round((reqE - ox) / sdx);
  const row0 = Math.round((oy - reqN) / sdy), row1 = Math.round((oy - reqS) / sdy);
  const width = Math.floor((col1 - col0) / DECIMATE) + 1;
  const height = Math.floor((row1 - row0) / DECIMATE) + 1;
  const dx = sdx * DECIMATE, dy = sdy * DECIMATE;
  const west = ox + col0 * sdx, north = oy - row0 * sdy;

  const raw = await image.readRasters({
    window: [col0, row0, col0 + (width - 1) * DECIMATE + 1, row0 + (height - 1) * DECIMATE + 1],
    samples: [0], interleave: true
  });
  const rawWidth = (width - 1) * DECIMATE + 1;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      values[y * width + x] = raw[y * DECIMATE * rawWidth + x * DECIMATE];

  let min = Infinity, max = -Infinity, finite = 0, zero = 0, negative = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    finite++; if (v < min) min = v; if (v > max) max = v;
    if (v === 0) zero++; if (v < 0) negative++;
  }
  if (finite !== values.length) throw new Error(`${region.id}: ${values.length - finite} non-finite samples`);

  const elevation = Buffer.from(await writeArrayBuffer(values, {
    width, height, SamplesPerPixel: 1, BitsPerSample: [32], SampleFormat: [3],
    ModelPixelScale: [dx, dy, 0], ModelTiepoint: [0, 0, 0, west, north, 0],
    GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 2, GeographicTypeGeoKey: 4326
  }));
  const shade = hillshade(values, width, height, dx, dy, north);
  const shadeTif = Buffer.from(await writeArrayBuffer(shade, {
    width, height, SamplesPerPixel: 1, BitsPerSample: [8], SampleFormat: [1],
    ModelPixelScale: [dx, dy, 0], ModelTiepoint: [0, 0, 0, west - dx / 2, north + dy / 2, 0],
    GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326
  }));
  const geoid = Buffer.from(JSON.stringify(await geoidCrop(reqW, reqS, reqE, reqN), null, 2) + "\n");

  const east = west + (width - 1) * dx, south = north - (height - 1) * dy;
  const manifest = {
    schema_version: "1.0",
    terrain_id: region.id,
    name: `${region.name} - Copernicus GLO-30`,
    dataset: {
      name: catalog.source.name, provider: catalog.source.provider,
      source_url: url, documentation: catalog.source.documentation,
      documentation_checked_date: new Date().toISOString().slice(0, 10),
      surface_type: catalog.source.surface_type,
      resampling: `decimated by ${DECIMATE} from the source grid; every value is an untouched source sample, none are interpolated`
    },
    coordinates: {
      horizontal_crs: "EPSG:4326", horizontal_units: "degrees",
      json_position_order: ["longitude_deg", "latitude_deg"],
      vertical_crs: "EPSG:3855", vertical_reference: "EGM2008",
      vertical_units: "metres", height_type: "orthometric",
      vertical_reference_evidence: "provider_documentation",
      vertical_crs_embedded_in_tiff: false
    },
    grid: {
      pixel_size_degrees: [dx, dy],
      row_direction: "north_to_south", column_direction: "west_to_east",
      sample_origin_lon_lat: [west, north],
      sample_center_bounds_wsen: [west, south, east, north],
      pixel_edge_bounds_wsen: [west - dx / 2, south - dy / 2, east + dx / 2, north + dy / 2],
      requested_bounds_wsen: region.bounds_wsen
    },
    assets: {
      surface_elevation: { path: "elevation.tif", sha256: sha256(elevation), size_bytes: elevation.length,
        source_url: url, raster_type: "PixelIsPoint", sample_origin_lon_lat: [west, north] },
      visualization_only: { path: "hillshade.tif", sha256: sha256(shadeTif), size_bytes: shadeTif.length,
        raster_type: "PixelIsArea", data_type: "uint8", declared_nodata: 0, nodata_pixel_count: 0,
        derivation: "Horn 3x3 slope and aspect from this elevation grid, sun azimuth 315, altitude 45",
        pixel_edge_origin_lon_lat: [west - dx / 2, north + dy / 2] },
      geoid_undulation: { path: "geoid-egm2008.json", sha256: sha256(geoid), size_bytes: geoid.length,
        source_url: GEOID_SOURCE, license: "Public Domain",
        role: "display conversion only; ellipsoidal height = EGM2008 height + geoid undulation" }
    },
    inspection: {
      width, height, band_count: 1, data_type: "float32",
      finite_pixel_count: finite, nonfinite_pixel_count: values.length - finite,
      minimum_elevation_m: min, maximum_elevation_m: max,
      zero_elevation_pixel_count: zero, negative_elevation_pixel_count: negative,
      nodata_tag_present: image.getGDALNoData() !== null, declared_nodata: image.getGDALNoData()
    },
    policies: {
      out_of_bounds: "reject", missing_or_nonfinite_elevation: "reject",
      zero_elevation: "preserve; not a reliable water or validity mask",
      negative_elevation: "preserve", water_mask_available: false,
      surface_clearance_name: "height_above_surface_m",
      ellipsoidal_height_conversion_available: true
    },
    attribution: "Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, " +
      "provided under COPERNICUS by the European Union and ESA; NGA EGM2008 geoid via PROJ"
  };

  const dir = new URL(`terrain/regions/${region.id}/`, ROOT);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL("elevation.tif", dir), elevation);
  await writeFile(new URL("hillshade.tif", dir), shadeTif);
  await writeFile(new URL("geoid-egm2008.json", dir), geoid);
  await writeFile(new URL("manifest.json", dir), JSON.stringify(manifest, null, 2) + "\n");
  return { width, height, min, max, bytes: elevation.length };
}

const wanted = process.argv.slice(2);
const todo = catalog.regions.filter(r => !r.packaged && (wanted.length === 0 || wanted.includes(r.id)));
for (const region of todo) {
  process.stdout.write(`${region.id.padEnd(17)} `);
  try {
    const r = await build(region);
    console.log(`${r.width}x${r.height}  ${r.min.toFixed(0)}..${r.max.toFixed(0)} m  ` +
      `relief ${(r.max - r.min).toFixed(0)} m  ${(r.bytes / 1e6).toFixed(1)} MB`);
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
