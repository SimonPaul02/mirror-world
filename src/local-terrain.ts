import { Credit, Event, GeographicTilingScheme, HeightmapTerrainData, Math as CMath,
  TerrainProvider, type TerrainData, type TileAvailability } from "cesium";
import { contains, sampleGrid, type Grid } from "./replay-math";

/** Local DSM converted to ellipsoidal heights. Outside coverage is a flat globe. */
export class LocalTerrainProvider {
  readonly errorEvent = new Event<TerrainProvider.ErrorEvent>();
  readonly credit: Credit;
  readonly tilingScheme = new GeographicTilingScheme();
  readonly hasWaterMask = false;
  readonly hasVertexNormals = false;
  readonly availability: TileAvailability | undefined = undefined;
  private readonly tileSize = 65;
  constructor(private surface: Grid, private geoid: Grid, attribution: string) {
    this.credit = new Credit(attribution);
  }
  getLevelMaximumGeometricError(level: number): number {
    return TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this.tilingScheme.ellipsoid, this.tileSize, this.tilingScheme.getNumberOfXTilesAtLevel(0)) / 2 ** level;
  }
  getTileDataAvailable(_x: number, _y: number, level: number): boolean { return level <= 14; }
  loadTileDataAvailability(): undefined { return undefined; }
  requestTileGeometry(x: number, y: number, level: number): Promise<TerrainData> {
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const buffer = new Float32Array(this.tileSize ** 2);
    for (let row = 0; row < this.tileSize; row++) {
      const lat = CMath.toDegrees(rect.north - rect.height * row / (this.tileSize - 1));
      for (let col = 0; col < this.tileSize; col++) {
        const lon = CMath.toDegrees(rect.west + rect.width * col / (this.tileSize - 1));
        if (contains(this.surface, lon, lat)) buffer[row * this.tileSize + col] =
          sampleGrid(this.surface, lon, lat) + sampleGrid(this.geoid, lon, lat);
      }
    }
    return Promise.resolve(new HeightmapTerrainData({ buffer, width: this.tileSize,
      height: this.tileSize, childTileMask: level < 14 ? 15 : 0 }));
  }
}
