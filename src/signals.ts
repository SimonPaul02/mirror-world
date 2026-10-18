import {
  Cartesian3,
  Cartographic,
  EllipsoidGeodesic,
  Math as CesiumMath,
  Matrix4,
  Transforms,
} from "cesium";

import { clamp, gaussian, toDeg, toRad, type Random } from "./math";
import type { Emitter, ReceiverSite } from "./scenario";
import type { TerrainSampler } from "./sim";

/** Speed of light, m/s. */
const C = 299_792_458;
/** Mean Earth radius, metres. */
const EARTH_R = 6_371_008;
/**
 * Effective-earth factor. Refraction in the lower atmosphere bends radio a
 * little downward, which is modelled by pretending the Earth is 4/3 as big and
 * the rays are straight.
 */
const K_FACTOR = 4 / 3;
/** Points sampled along each path when looking for an obstruction. */
const PATH_SAMPLES = 40;
/**
 * Height added to the bare terrain for trees, hedgerows and buildings. The
 * elevation tiles are a surface model in places and bare earth in others, so
 * this is a flat allowance rather than real clutter data.
 */
const CLUTTER_M = 6;
/** Shadowing decorrelation time, seconds of scenario time. */
const FADE_CORRELATION_S = 10;
/** Standard deviation of the log-normal shadowing, dB. */
const FADE_SIGMA_DB = 2.6;
/**
 * Bearing accuracy of the arrays against SNR: σ ≈ K / √SNR, on top of each
 * array's calibration floor. 25° gives ~2.5° at 20 dB SNR, which is about what
 * a well-sited eight-element interferometer manages.
 */
const DF_SIGMA_K_DEG = 25;

/** What one array heard in one reporting interval. */
export interface Detection {
  receiver: ReceiverSite;
  /** False when the signal is below the array's detection threshold. */
  heard: boolean;
  /** Antenna phase-centre height, metres above the ellipsoid. */
  antennaHae: number;
  /** Great-circle distance over the ground, metres. */
  groundRangeM: number;
  /** Straight-line distance, metres. */
  slantRangeM: number;
  trueBearingDeg: number;
  measuredBearingDeg: number;
  trueElevationDeg: number;
  measuredElevationDeg: number;
  /** Free-space component of the path loss, dB. */
  fsplDb: number;
  /** Diffraction loss over the terrain in the way, dB. */
  terrainLossDb: number;
  /** Fraction of path samples with an actual terrain height available. */
  terrainCoverage: number;
  /** False when terrain at the receiver or anywhere on the RF path is unknown. */
  terrainComplete: boolean;
  rssiDbm: number;
  snrDb: number;
  /** Bearing uncertainty this report, degrees 1σ. */
  sigmaDeg: number;
}

/** A position from two or more crossed bearings. */
export interface Fix {
  lon: number;
  lat: number;
  /** Height above the ellipsoid from the nearest array's elevation angle. */
  haeM: number;
  /** Horizontal uncertainty, metres 1σ — the CoT `ce`. */
  ceM: number;
  /** Vertical uncertainty, metres 1σ — the CoT `le`. */
  leM: number;
  /** Angle the two bearings cross at, degrees. A shallow cross is a bad fix. */
  crossAngleDeg: number;
  contributors: string[];
}

/**
 * ITU-R P.526 single knife-edge diffraction loss, as a function of the Fresnel
 * parameter v. Below -0.78 the path is clear enough to call it free space.
 */
export function knifeEdgeLossDb(v: number): number {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Free-space path loss, dB, for a distance in metres and a frequency in MHz. */
export function fsplDb(distanceM: number, freqMhz: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0 || !Number.isFinite(freqMhz) || freqMhz <= 0) throw new Error("RF path loss requires a nonnegative distance and positive frequency");
  const km = Math.max(distanceM, 1) / 1000;
  return 20 * Math.log10(km) + 20 * Math.log10(freqMhz) + 32.44;
}

/**
 * Worst Fresnel obstruction along a path, expressed as diffraction loss.
 *
 * The path is walked in `PATH_SAMPLES` steps; at each one the terrain height is
 * compared with the straight ray, after the ray has been dropped by the
 * effective-earth bulge. The deepest intrusion into the first Fresnel zone sets
 * the loss, which is the standard single-edge approximation — real multi-edge
 * paths lose a few dB more.
 */
function terrainLossDb(
  geodesic: EllipsoidGeodesic,
  rxHae: number,
  txHae: number,
  freqMhz: number,
  sampleTerrain: TerrainSampler,
  scratch: Cartographic,
): { lossDb: number; coverage: number } {
  const total = geodesic.surfaceDistance;
  if (total < 50) return { lossDb: 0, coverage: 1 };

  const lambda = C / (freqMhz * 1e6);
  let worstV = Number.NEGATIVE_INFINITY;
  let knownSamples = 0;

  for (let i = 1; i < PATH_SAMPLES; i += 1) {
    const t = i / PATH_SAMPLES;
    const point = geodesic.interpolateUsingFraction(t, scratch);
    const ground = sampleTerrain(point);
    if (ground === undefined) continue;
    knownSamples += 1;

    const d1 = total * t;
    const d2 = total - d1;
    // Straight ray between the antennas, less the earth's bulge under it.
    const ray = rxHae + (txHae - rxHae) * t - (d1 * d2) / (2 * K_FACTOR * EARTH_R);
    const intrusion = ground + CLUTTER_M - ray;
    const fresnel = Math.sqrt((lambda * d1 * d2) / total);
    const v = (intrusion * Math.SQRT2) / fresnel;
    if (v > worstV) worstV = v;
  }

  return {
    lossDb: Number.isFinite(worstV) ? knifeEdgeLossDb(worstV) : 0,
    coverage: knownSamples / (PATH_SAMPLES - 1),
  };
}

/**
 * The RF side of the scenario: turns truth into what each array reports.
 *
 * Shadowing is kept as per-array state so it drifts the way real fading does
 * instead of flickering independently every report.
 */
export class SignalModel {
  private readonly fade = new Map<string, number>();
  private readonly geodesic = new EllipsoidGeodesic();
  private readonly pathScratch = new Cartographic();
  private readonly siteScratch = new Cartographic();

  constructor(
    private readonly receivers: ReceiverSite[],
    private readonly emitter: Emitter,
    private readonly sampleTerrain: TerrainSampler,
    private readonly random: Random,
    private readonly options: { samplePeriodS?: number; shadowingSigmaDb?: number; bearingNoiseScale?: number } = {},
  ) {
    for (const rx of receivers) this.fade.set(rx.uid, 0);
  }

  /** Ellipsoid height of an array's antenna, once terrain is known. */
  antennaHae(receiver: ReceiverSite): number {
    const site = Cartographic.fromDegrees(receiver.lon, receiver.lat, 0, this.siteScratch);
    return (this.sampleTerrain(site) ?? 0) + receiver.mastM;
  }

  /** One reporting interval: what every array heard of the emitter. */
  observe(emitterCarto: Cartographic): Detection[] {
    return this.receivers.map((receiver) => this.measure(receiver, emitterCarto));
  }

  private measure(receiver: ReceiverSite, target: Cartographic): Detection {
    const receiverGround = this.sampleTerrain(Cartographic.fromDegrees(receiver.lon, receiver.lat));
    const antennaHae = (receiverGround ?? 0) + receiver.mastM;
    const site = Cartographic.fromDegrees(receiver.lon, receiver.lat, 0, this.siteScratch);
    this.geodesic.setEndPoints(site, target);

    const groundRangeM = this.geodesic.surfaceDistance;
    const rise = target.height - antennaHae;
    const slantRangeM = Math.hypot(groundRangeM, rise);
    const trueBearingDeg = CesiumMath.zeroToTwoPi(this.geodesic.startHeading) * CesiumMath.DEGREES_PER_RADIAN;
    const trueElevationDeg = toDeg(Math.atan2(rise, Math.max(groundRangeM, 1)));

    const loss = fsplDb(slantRangeM, this.emitter.freqMhz);
    const terrain = terrainLossDb(
      this.geodesic,
      antennaHae,
      target.height,
      this.emitter.freqMhz,
      this.sampleTerrain,
      this.pathScratch,
    );

    // Shadowing drifts rather than jumps: a first-order filter on white noise.
    const previous = this.fade.get(receiver.uid) ?? 0;
    const alpha = Math.exp(-(this.options.samplePeriodS ?? 2) / FADE_CORRELATION_S);
    const fade = previous * alpha + gaussian(this.random) * (this.options.shadowingSigmaDb ?? FADE_SIGMA_DB) * Math.sqrt(1 - alpha * alpha);
    this.fade.set(receiver.uid, fade);

    const rssiDbm = this.emitter.eirpDbm + receiver.gainDbi - loss - terrain.lossDb + fade;
    const snrDb = rssiDbm - receiver.noiseFloorDbm;
    const terrainComplete = receiverGround !== undefined && terrain.coverage === 1;
    const heard = terrainComplete && snrDb >= receiver.detectSnrDb;

    // σ = √(calibration² + (K/√SNR)²): the array's own floor, plus the part
    // that grows as the signal sinks toward the noise.
    const snrLinear = Math.max(10 ** (snrDb / 10), 1e-3);
    const sigmaDeg = clamp(
      Math.hypot(receiver.sigmaFloorDeg, DF_SIGMA_K_DEG / Math.sqrt(snrLinear)),
      receiver.sigmaFloorDeg,
      45,
    );

    const bearingError = heard ? gaussian(this.random) * sigmaDeg * (this.options.bearingNoiseScale ?? 1) + receiver.biasDeg : 0;
    // The elevation channel of the same array is the weaker one.
    const elevationError = heard ? gaussian(this.random) * sigmaDeg * 1.6 * (this.options.bearingNoiseScale ?? 1) : 0;

    return {
      receiver,
      heard,
      antennaHae,
      groundRangeM,
      slantRangeM,
      trueBearingDeg,
      measuredBearingDeg: ((trueBearingDeg + bearingError) % 360 + 360) % 360,
      trueElevationDeg,
      measuredElevationDeg: trueElevationDeg + elevationError,
      fsplDb: loss,
      terrainLossDb: terrain.lossDb,
      terrainCoverage: terrain.coverage,
      terrainComplete,
      rssiDbm,
      snrDb,
      sigmaDeg,
    };
  }
}

/** Two-dimensional cross product, used to intersect the bearing lines. */
const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * Crosses the bearings from two arrays into a position.
 *
 * The arithmetic runs in a local east-north plane pinned to the first array.
 * Over the tens of kilometres this scenario spans, the tangent plane differs
 * from the ellipsoid by centimetres horizontally — far inside the bearing error
 * the fix carries anyway.
 *
 * Returns undefined when fewer than two arrays heard the signal, when the
 * bearings cross too shallowly to mean anything, or when the crossing falls
 * behind one of the arrays.
 */
export function crossBearings(detections: Detection[]): Fix | undefined {
  const heard = detections.filter((d) => d.heard && [d.measuredBearingDeg, d.measuredElevationDeg, d.sigmaDeg, d.receiver.lat, d.receiver.lon, d.antennaHae].every(Number.isFinite));
  if (heard.length < 2) return undefined;

  // MVP has two receivers; additional inputs use the strongest two reports.
  const [a, b] = [...heard].sort((x, y) => y.snrDb - x.snrDb) as [Detection, Detection];
  if (a.receiver.uid === b.receiver.uid) return undefined;

  const origin = Cartographic.fromDegrees(a.receiver.lon, a.receiver.lat, 0);
  const enu = Transforms.eastNorthUpToFixedFrame(Cartographic.toCartesian(origin));
  const inverseEnu = Matrix4.inverseTransformation(enu, new Matrix4());

  // Transform B's site and local north into A's frame. Geodetic north at the
  // two sites differs slightly; treating their azimuth frames as identical
  // otherwise creates metre-scale error even with perfect measurements.
  const bWorld = Cartesian3.fromDegrees(b.receiver.lon, b.receiver.lat);
  const bLocal = Matrix4.multiplyByPoint(inverseEnu, bWorld, new Cartesian3());
  const bx = bLocal.x;
  const by = bLocal.y;

  const ua = toRad(a.measuredBearingDeg);
  const ub = toRad(b.measuredBearingDeg);
  const uax = Math.sin(ua);
  const uay = Math.cos(ua);
  const bEnu = Transforms.eastNorthUpToFixedFrame(bWorld);
  const bDirectionWorld = Matrix4.multiplyByPointAsVector(bEnu, new Cartesian3(Math.sin(ub), Math.cos(ub), 0), new Cartesian3());
  const bDirectionLocal = Matrix4.multiplyByPointAsVector(inverseEnu, bDirectionWorld, new Cartesian3());
  const bLength = Math.hypot(bDirectionLocal.x, bDirectionLocal.y);
  const ubx = bDirectionLocal.x / bLength;
  const uby = bDirectionLocal.y / bLength;

  const denominator = cross2(uax, uay, ubx, uby);
  const crossAngleDeg = toDeg(Math.asin(clamp(Math.abs(denominator), 0, 1)));
  if (Math.abs(denominator) < 0.15) return undefined;

  // Distance along A's bearing to where it meets B's.
  const ta = cross2(bx, by, ubx, uby) / denominator;
  const tb = cross2(bx, by, uax, uay) / denominator;
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta < 0 || tb < 0 || Math.max(ta, tb) > 200_000) return undefined;

  const east = ta * uax;
  const north = ta * uay;
  const world = Matrix4.multiplyByPoint(
    enu,
    new Cartesian3(east, north, 0),
    new Cartesian3(),
  );
  const carto = Cartographic.fromCartesian(world);
  if (!carto) return undefined;

  // Error ellipse from two noisy bearings: each array contributes range × σ
  // across its own line, and a shallow crossing stretches both.
  const sigmaA = toRad(a.sigmaDeg) * ta;
  const sigmaB = toRad(b.sigmaDeg) * tb;
  const ceM = Math.hypot(sigmaA, sigmaB) / Math.max(Math.abs(denominator), 1e-3);

  // Height from the nearer array's elevation channel, which is all a
  // two-axis DF array can offer — and at long range it offers very little.
  const near = ta <= tb ? a : b;
  const nearRange = near === a ? ta : tb;
  const haeM =
    near.antennaHae + nearRange * Math.tan(toRad(near.measuredElevationDeg));
  const leM = clamp(nearRange * toRad(near.sigmaDeg * 1.6), 25, 4000);

  return {
    lon: toDeg(carto.longitude),
    lat: toDeg(carto.latitude),
    haeM,
    ceM: clamp(ceM, 5, 20_000),
    leM,
    crossAngleDeg,
    contributors: [a.receiver.uid, b.receiver.uid],
  };
}
