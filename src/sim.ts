import { Cartesian3, Cartographic, Matrix4, Transforms } from "cesium";

import type { RawAxes } from "./input";
import { G, approach, clamp, lerp, smoothing, toRad, wrap2Pi } from "./math";
import { CRUISE_BURN_KG_H, burnFactor, type FlightProfile } from "./profiles";

export interface FlightState {
  position: Cartesian3;
  carto: Cartographic;
  /** Compass bearing in radians, clockwise from north. */
  bearing: number;
  pitch: number;
  roll: number;
  /** Speed along the body's forward axis, m/s. */
  forwardSpeed: number;
  horizontalSpeed: number;
  verticalSpeed: number;
  throttle: number;
  groundHeight: number;
  aglHeight: number;
  onGround: boolean;

  /** Remaining usable fuel, kilograms. */
  fuelKg: number;
  /** Seconds flown since launch, in simulated time. */
  missionSeconds: number;
}

export type TerrainSampler = (carto: Cartographic) => number | undefined;

/**
 * Fixed-wing flight dynamics for the MQ-9.
 *
 * Attitude and speed are resolved first, then one integrator moves the aircraft
 * through the east-north-up frame at its current position. Fuel burns against
 * throttle, calibrated so cruise gives the airframe's published endurance.
 */
export class FlightSim {
  readonly state: FlightState = {
    position: new Cartesian3(),
    carto: new Cartographic(),
    bearing: 0,
    pitch: 0,
    roll: 0,
    forwardSpeed: 0,
    horizontalSpeed: 0,
    verticalSpeed: 0,
    throttle: 0,
    groundHeight: 0,
    aglHeight: 0,
    onGround: false,
    fuelKg: 0,
    missionSeconds: 0,
  };

  private lastGround = 0;

  private readonly enuScratch = new Matrix4();
  private readonly localScratch = new Cartesian3();
  private readonly deltaScratch = new Cartesian3();

  constructor(
    readonly profile: FlightProfile,
    private sampleTerrain: TerrainSampler,
  ) {}

  /** Places the aircraft on station, trimmed and fully fuelled. */
  spawn(lon: number, lat: number, bearingDeg: number, altitudeAgl: number): void {
    const s = this.state;
    const carto = Cartographic.fromDegrees(lon, lat, 0, s.carto);
    const ground = this.sampleTerrain(carto) ?? 0;
    this.lastGround = ground;

    carto.height = ground + altitudeAgl;
    Cartographic.toCartesian(carto, undefined, s.position);

    s.bearing = wrap2Pi(toRad(bearingDeg));
    s.pitch = 0;
    s.roll = 0;
    s.throttle = this.profile.cruiseThrottle;
    s.forwardSpeed = this.profile.cruiseSpeed;
    s.horizontalSpeed = this.profile.cruiseSpeed;
    s.verticalSpeed = 0;
    s.groundHeight = ground;
    s.aglHeight = altitudeAgl;
    s.onGround = false;
    s.fuelKg = this.profile.spec.fuelCapacity;
    s.missionSeconds = 0;
  }

  setTerrainSampler(sampler: TerrainSampler): void {
    this.sampleTerrain = sampler;
  }

  /** Hours of flight left at the current throttle setting. */
  enduranceRemainingHours(): number {
    const burn = CRUISE_BURN_KG_H * burnFactor(this.state.throttle);
    return burn > 0 ? this.state.fuelKg / burn : 0;
  }

  update(dt: number, axes: RawAxes): void {
    this.updateAttitude(dt, axes);
    this.integrate(dt);
    this.burnFuel(dt);
  }

  private updateAttitude(dt: number, axes: RawAxes): void {
    const p = this.profile;
    const s = this.state;

    s.throttle = clamp(s.throttle + axes.ws * p.throttleRate * dt, 0, 1);

    // Climbing trades speed for height; diving gives it back.
    const energy = -Math.sin(s.pitch) * G * 0.85 * dt;
    const target = lerp(p.minSpeed, p.maxSpeed, s.throttle);
    const rate = target > s.forwardSpeed ? p.accel : p.decel;
    s.forwardSpeed = Math.max(0, approach(s.forwardSpeed + energy, target, rate * dt));

    const rollCommand = clamp(axes.ad + axes.arrowLR, -1, 1);
    if (rollCommand !== 0) {
      s.roll = clamp(s.roll + rollCommand * p.rollRate * dt, -p.maxBank, p.maxBank);
    } else {
      s.roll = approach(s.roll, 0, p.rollRate * 0.5 * dt);
    }

    const pitchCommand = axes.arrowUD;
    if (pitchCommand !== 0) {
      s.pitch = clamp(s.pitch + pitchCommand * p.pitchRate * dt, -p.maxPitch, p.maxPitch);
    } else {
      s.pitch = approach(s.pitch, 0, p.pitchRate * 0.3 * dt);
    }

    if (s.onGround) {
      s.roll = approach(s.roll, 0, p.rollRate * dt);
      if (s.pitch < 0) s.pitch = 0;
    }

    // Coordinated turn: bank sets turn rate, scaled by how fast we are going.
    const turnSpeed = Math.max(s.forwardSpeed, p.minSpeed * 0.6, 1);
    const turnRate = (G * Math.tan(s.roll)) / turnSpeed;
    s.bearing = wrap2Pi(s.bearing + (turnRate + axes.qe * p.yawRate) * dt);

    s.horizontalSpeed = s.forwardSpeed * Math.cos(s.pitch);
    s.verticalSpeed = s.forwardSpeed * Math.sin(s.pitch);
  }

  private integrate(dt: number): void {
    const p = this.profile;
    const s = this.state;

    // Unit vector along `bearing` is (sin, cos) in (east, north).
    const east = s.horizontalSpeed * Math.sin(s.bearing);
    const north = s.horizontalSpeed * Math.cos(s.bearing);

    const enu = Transforms.eastNorthUpToFixedFrame(s.position, undefined, this.enuScratch);
    const local = Cartesian3.fromElements(
      east * dt,
      north * dt,
      s.verticalSpeed * dt,
      this.localScratch,
    );
    const delta = Matrix4.multiplyByPointAsVector(enu, local, this.deltaScratch);
    Cartesian3.add(s.position, delta, s.position);

    const carto = Cartographic.fromCartesian(s.position, undefined, s.carto);
    if (!carto) return;

    // Ease toward each new terrain sample: relief refines as tiles stream in,
    // and a hard snap would shove the aircraft when the ground "moves".
    //
    // A coarse tile can interpolate across a coastline and report the sea floor
    // under dry land, so the estimate is slew-limited by how fast real ground
    // could change at this speed. Terrain following stays well inside the
    // limit; a bad sample is ignored long enough for finer tiles to correct it.
    const sampled = this.sampleTerrain(carto);
    if (sampled !== undefined && Number.isFinite(sampled)) {
      const slew = Math.max(60, Math.abs(s.horizontalSpeed) * 2) * dt;
      const eased = (sampled - this.lastGround) * smoothing(0.25, dt);
      this.lastGround += clamp(eased, -slew, slew);
    }
    const ground = this.lastGround;

    const floor = ground + p.minAgl;
    if (carto.height <= floor) {
      carto.height = floor;
      if (s.verticalSpeed < 0) s.verticalSpeed = 0;
      s.onGround = true;
    } else {
      s.onGround = false;
    }
    carto.height = Math.min(carto.height, p.ceiling);

    s.groundHeight = ground;
    s.aglHeight = carto.height - ground;
    Cartographic.toCartesian(carto, undefined, s.position);
  }

  private burnFuel(dt: number): void {
    const s = this.state;
    s.missionSeconds += dt;
    if (s.fuelKg <= 0) {
      s.fuelKg = 0;
      return;
    }
    s.fuelKg = Math.max(0, s.fuelKg - (CRUISE_BURN_KG_H * burnFactor(s.throttle) * dt) / 3600);
  }
}
