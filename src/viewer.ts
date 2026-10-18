import {
  Cartographic,
  Color,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Ion,
  IonImageryProvider,
  OpenStreetMapImageryProvider,
  RequestScheduler,
  ScreenSpaceEventType,
  ShadowMode,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  Viewer,
  buildModuleUrl,
  createWorldTerrainAsync,
  type TerrainProvider,
} from "cesium";

import "cesium/Build/Cesium/Widgets/widgets.css";

import { TerrariumTerrainProvider } from "./terrain";

export const ION_TOKEN: string = (import.meta.env.VITE_CESIUM_ION_TOKEN ?? "").trim();
export const HAS_ION = ION_TOKEN.length > 0;

const OSM_CREDIT =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export interface ImageryOption {
  id: string;
  label: string;
  /** Needs a Cesium ion token. */
  ion: boolean;
  create: () => ImageryLayer;
}

/** The offline basemap, used as an instant backdrop under the streamed one. */
function createOfflineBase(): ImageryLayer {
  return ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(buildModuleUrl("Assets/Textures/NaturalEarthII")),
    {},
  );
}

/** Index of the streamed base layer; 0 is the offline backdrop beneath it. */
const BASE_LAYER_INDEX = 1;

export const IMAGERY_OPTIONS: ImageryOption[] = [
  {
    id: "esri-imagery",
    label: "Esri satellite",
    ion: false,
    create: () =>
      ImageryLayer.fromProviderAsync(
        Promise.resolve(
          new UrlTemplateImageryProvider({
            // Note the {y}/{x} order: ArcGIS tiles are row-major.
            url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            maximumLevel: 19,
            credit: new Credit(
              'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics',
              false,
            ),
          }),
        ),
        {},
      ),
  },
  {
    id: "carto-voyager",
    label: "Carto Voyager (modern street)",
    ion: false,
    create: () =>
      ImageryLayer.fromProviderAsync(
        Promise.resolve(
          new UrlTemplateImageryProvider({
            url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
            subdomains: ["a", "b", "c", "d"],
            maximumLevel: 20,
            credit: new Credit(`© <a href="https://carto.com/" target="_blank" rel="noopener">CARTO</a>, ${OSM_CREDIT}`, false),
          }),
        ),
        {},
      ),
  },
  {
    id: "carto-dark",
    label: "Carto Dark Matter",
    ion: false,
    create: () =>
      ImageryLayer.fromProviderAsync(
        Promise.resolve(
          new UrlTemplateImageryProvider({
            url: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png",
            subdomains: ["a", "b", "c", "d"],
            maximumLevel: 20,
            credit: new Credit(`© <a href="https://carto.com/" target="_blank" rel="noopener">CARTO</a>, ${OSM_CREDIT}`, false),
          }),
        ),
        {},
      ),
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    ion: false,
    create: () =>
      ImageryLayer.fromProviderAsync(
        Promise.resolve(
          new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
        ),
        {},
      ),
  },
  {
    id: "natural-earth",
    label: "Natural Earth II (offline)",
    ion: false,
    create: () =>
      ImageryLayer.fromProviderAsync(
        TileMapServiceImageryProvider.fromUrl(
          buildModuleUrl("Assets/Textures/NaturalEarthII"),
        ),
        {},
      ),
  },
  {
    id: "ion-aerial",
    label: "Bing Aerial (ion)",
    ion: true,
    create: () => ImageryLayer.fromWorldImagery({}),
  },
  {
    id: "ion-sentinel",
    label: "Sentinel-2 (ion)",
    ion: true,
    create: () => ImageryLayer.fromProviderAsync(IonImageryProvider.fromAssetId(3954), {}),
  },
];

export function availableImagery(): ImageryOption[] {
  return IMAGERY_OPTIONS.filter((option) => HAS_ION || !option.ion);
}

export const DEFAULT_IMAGERY_ID = "esri-imagery";

// --------------------------------------------------------------------- terrain

export type TerrainId = "aws" | "ion" | "flat";

export interface TerrainOption {
  id: TerrainId;
  label: string;
  ion: boolean;
  /** False only for the smooth ellipsoid, which has no elevation at all. */
  real: boolean;
  create: () => Promise<TerrainProvider>;
}

export const TERRAIN_OPTIONS: TerrainOption[] = [
  {
    id: "aws",
    label: "Exact elevation (AWS)",
    ion: false,
    real: true,
    create: async () => new TerrariumTerrainProvider(),
  },
  {
    id: "ion",
    label: "Cesium World Terrain (ion)",
    ion: true,
    real: true,
    create: () => createWorldTerrainAsync({ requestVertexNormals: true }),
  },
  {
    id: "flat",
    label: "Flat ellipsoid",
    ion: false,
    real: false,
    create: async () => new EllipsoidTerrainProvider(),
  },
];

export function availableTerrain(): TerrainOption[] {
  return TERRAIN_OPTIONS.filter((option) => HAS_ION || !option.ion);
}

export const DEFAULT_TERRAIN_ID: TerrainId = HAS_ION ? "ion" : "aws";

export interface SceneSetup {
  viewer: Viewer;
  terrainId: TerrainId;
  /** True when the terrain provider carries real elevation. */
  hasRealTerrain: boolean;
}

/**
 * Builds the Viewer.
 *
 * Everything needed for exact terrain and modern imagery works without an
 * account: elevation comes from AWS Terrain Tiles and imagery from Esri or
 * CARTO. A Cesium ion token only adds their hosted alternatives.
 */
export async function createScene(container: HTMLElement): Promise<SceneSetup> {
  if (HAS_ION) Ion.defaultAccessToken = ION_TOKEN;

  // Cesium defaults to 6 concurrent requests per host, a holdover from HTTP/1.1.
  // Every tile source here speaks HTTP/2, where many parallel streams share one
  // connection — this is the single biggest lever on time-to-first-view.
  RequestScheduler.maximumRequestsPerServer = 18;
  RequestScheduler.maximumRequests = 40;

  const wanted =
    availableTerrain().find((t) => t.id === DEFAULT_TERRAIN_ID) ??
    (availableTerrain()[0] as TerrainOption);

  let terrainProvider: TerrainProvider;
  let terrainId = wanted.id;
  let hasRealTerrain = wanted.real;
  try {
    terrainProvider = await wanted.create();
  } catch (error) {
    console.warn(`[flight-lab] ${wanted.label} unavailable, falling back to flat.`, error);
    terrainProvider = new EllipsoidTerrainProvider();
    terrainId = "flat";
    hasRealTerrain = false;
  }

  const initial =
    availableImagery().find((o) => o.id === DEFAULT_IMAGERY_ID) ??
    (availableImagery()[0] as ImageryOption);

  const viewer = new Viewer(container, {
    // Starts as the bundled world texture: no network, no blank globe.
    baseLayer: createOfflineBase(),
    terrainProvider,
    baseLayerPicker: false,
    geocoder: HAS_ION ? undefined : false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    fullscreenButton: false,
    timeline: true,
    animation: true,
    // Shadow maps cost a full extra scene pass per frame to render a shadow the
    // size of a few pixels. Not worth it.
    shadows: false,
    terrainShadows: ShadowMode.DISABLED,
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.enableLighting = true;
  // Terrain reads far better with a hint of ambient fill in the shadows.
  scene.globe.dynamicAtmosphereLighting = true;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
  // Fog culls distant detail, which is a large part of why flying stays smooth.
  scene.fog.enabled = true;
  scene.highDynamicRange = false;
  // Tiles a terrain level finer than this aren't worth the load time; 2 is
  // Cesium's default and already sharper than the eye tracks while moving.
  scene.globe.maximumScreenSpaceError = 2;
  scene.globe.tileCacheSize = 300;
  // Land that hasn't been textured yet should read as ground, not as a hole.
  scene.globe.baseColor = Color.fromCssColorString("#36404f");
  viewer.clock.shouldAnimate = false;

  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  // The real imagery streams in over the backdrop rather than replacing it, so
  // there is never a frame with nothing on the globe.
  viewer.imageryLayers.add(initial.create(), BASE_LAYER_INDEX);

  return { viewer, terrainId, hasRealTerrain };
}

/** Swaps the streamed imagery, leaving the offline backdrop in place. */
export function setBaseImagery(viewer: Viewer, option: ImageryOption): void {
  const layers = viewer.imageryLayers;
  const previous = layers.get(BASE_LAYER_INDEX);
  layers.add(option.create(), BASE_LAYER_INDEX);
  if (previous) layers.remove(previous, true);
}

/** Swaps the terrain provider in place. Returns whether it carries elevation. */
export async function setTerrain(viewer: Viewer, option: TerrainOption): Promise<boolean> {
  try {
    viewer.terrainProvider = await option.create();
    return option.real;
  } catch (error) {
    console.warn(`[flight-lab] ${option.label} failed to load.`, error);
    viewer.terrainProvider = new EllipsoidTerrainProvider();
    return false;
  }
}

/** Deepest trench and highest peak on Earth, with margin. */
const MIN_ELEVATION = -12_000;
const MAX_ELEVATION = 9_200;

/**
 * Terrain height under a point, or undefined when no trustworthy value exists.
 *
 * `globe.getHeight` is synchronous and cheap, but it interpolates over whatever
 * tile is currently in memory — and a coarse tile's mesh includes downward
 * skirts, so a point can land on one and report tens of kilometres below sea
 * level until finer tiles stream in. Anything outside Earth's real elevation
 * range is one of those artifacts, so we report "unknown" and let the caller
 * keep its previous value.
 */
export function makeTerrainSampler(viewer: Viewer, hasRealTerrain: () => boolean) {
  return (carto: Cartographic): number | undefined => {
    // On the bare ellipsoid every point is sea level; no need to probe at all.
    if (!hasRealTerrain()) return 0;

    const height = viewer.scene.globe.getHeight(carto);
    if (height === undefined || !Number.isFinite(height)) return undefined;
    if (height < MIN_ELEVATION || height > MAX_ELEVATION) return undefined;
    return height;
  };
}
