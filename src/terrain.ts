import {
  Credit,
  Ellipsoid,
  Event as CesiumEvent,
  HeightmapTerrainData,
  Request,
  Resource,
  TerrainProvider,
  WebMercatorTilingScheme,
  defined,
  type TerrainData,
  type TileAvailability,
  type TilingScheme,
} from "cesium";

const TILE_SIZE = 256;
/** AWS Terrain Tiles publish up to zoom 15; above that Cesium upsamples. */
const MAX_LEVEL = 15;
const URL_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

/**
 * Real worldwide elevation with no API key, from the AWS Open Data
 * "Terrain Tiles" set (SRTM / 3DEP / GMTED, Mapzen's terrarium encoding).
 *
 * Each tile is a PNG where elevation is packed into the RGB channels as
 * `height = R * 256 + G + B / 256 - 32768` metres. Cesium's HeightmapTerrainData
 * can decode exactly that shape natively, so all this provider does is fetch the
 * image, pull its pixels out through a canvas, and describe the encoding:
 *
 *   heightSample = ((R * 256 + G) * 256 + B)   // elementsPerHeight 3, big endian
 *   height       = heightSample / 256 - 32768  // heightScale, heightOffset
 */
export class TerrariumTerrainProvider implements TerrainProvider {
  readonly errorEvent = new CesiumEvent<TerrainProvider.ErrorEvent>();
  readonly credit: Credit;
  readonly tilingScheme: TilingScheme;
  readonly hasWaterMask = false;
  readonly hasVertexNormals = false;
  readonly availability: TileAvailability | undefined = undefined;

  private readonly levelZeroError: number;
  private canvas?: HTMLCanvasElement;

  constructor() {
    this.tilingScheme = new WebMercatorTilingScheme({ ellipsoid: Ellipsoid.WGS84 });
    this.levelZeroError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this.tilingScheme.ellipsoid,
      TILE_SIZE,
      this.tilingScheme.getNumberOfXTilesAtLevel(0),
    );
    this.credit = new Credit(
      'Elevation <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a>',
      false,
    );
  }

  getLevelMaximumGeometricError(level: number): number {
    return this.levelZeroError / (1 << level);
  }

  getTileDataAvailable(_x: number, _y: number, level: number): boolean | undefined {
    // Reporting "no data" past the published zoom makes Cesium refine from the
    // parent tile instead of firing requests that would 404.
    return level <= MAX_LEVEL;
  }

  loadTileDataAvailability(): undefined {
    return undefined;
  }

  requestTileGeometry(
    x: number,
    y: number,
    level: number,
    request?: Request,
  ): Promise<TerrainData> | undefined {
    const resource = new Resource({
      url: `${URL_BASE}/${level}/${x}/${y}.png`,
      request,
    });

    const promise = resource.fetchImage({ preferImageBitmap: true });
    // Undefined means Cesium's scheduler throttled us; it will ask again.
    if (!defined(promise)) return undefined;

    return promise
      .then((image) => this.decode(image as CanvasImageSource))
      // A missing or corrupt tile becomes flat ground rather than a hole.
      .catch(() => this.flat());
  }

  /** Pulls the RGB-packed heights out of the PNG via a scratch canvas. */
  private decode(image: CanvasImageSource): HeightmapTerrainData {
    const canvas = (this.canvas ??= document.createElement("canvas"));
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return this.flat();

    context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    context.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
    const { data } = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);

    return new HeightmapTerrainData({
      buffer: new Uint8Array(data.buffer),
      width: TILE_SIZE,
      height: TILE_SIZE,
      childTileMask: 15,
      structure: {
        heightScale: 1 / 256,
        heightOffset: -32768,
        elementsPerHeight: 3,
        stride: 4,
        elementMultiplier: 256,
        isBigEndian: true,
      },
    });
  }

  private flat(): HeightmapTerrainData {
    // 32768 in terrarium encoding is exactly sea level.
    const buffer = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < buffer.length; i += 4) buffer[i] = 128;

    return new HeightmapTerrainData({
      buffer,
      width: TILE_SIZE,
      height: TILE_SIZE,
      childTileMask: 15,
      structure: {
        heightScale: 1 / 256,
        heightOffset: -32768,
        elementsPerHeight: 3,
        stride: 4,
        elementMultiplier: 256,
        isBigEndian: true,
      },
    });
  }
}
