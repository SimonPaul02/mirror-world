// One-time preparation. Runtime uses the checked-in local crop, without network access.
import { fromUrl } from "geotiff";
import { writeFile } from "node:fs/promises";
const source = "https://cdn.proj.org/us_nga_egm08_25.tif";
const image = await (await fromUrl(source)).getImage();
const [west, north] = image.getOrigin();
const [dx, ry] = image.getResolution();
const x0 = Math.floor((30.50 - west) / dx), x1 = Math.ceil((31.00 - west) / dx) + 1;
const y0 = Math.floor((north - 46.75) / -ry), y1 = Math.ceil((north - 46.25) / -ry) + 1;
const values = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
const result = {
  source, license: "Public Domain", attribution: "NGA EGM2008; GeographicLib / PROJ grid",
  documentation: "https://cdn.proj.org/us_nga_README.txt",
  conversion: "ellipsoidal_height_m = altitude_egm2008_m + geoid_undulation_m",
  source_metadata: await image.getGDALMetadata(),
  band_metadata: await image.getGDALMetadata(0),
  width: x1 - x0, height: y1 - y0, west: west + x0 * dx, north: north + y0 * ry,
  dx, dy: -ry, values: Array.from(values)
};
await writeFile(new URL("../terrain/odesa/geoid-egm2008.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log({ width: result.width, height: result.height, range: [Math.min(...values), Math.max(...values)], metadata: result.band_metadata });
