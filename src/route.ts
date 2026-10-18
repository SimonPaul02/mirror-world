import { Cartographic, EllipsoidGeodesic } from "cesium";

import { clamp, lerp, toDeg } from "./math";
import type { Waypoint } from "./scenario";
import type { FlightState } from "./sim";

/** How close counts as "arrived", metres. Wider than the turn radius. */
const CAPTURE_M = 2600;

/** What the autopilot is being asked to do right now. */
export interface LegCommand {
  /** Compass bearing to the active waypoint, radians. */
  bearing: number;
  /** Altitude to hold, metres above ground. */
  agl: number;
  from: Waypoint;
  to: Waypoint;
  /** Great-circle distance remaining to the active waypoint, metres. */
  distanceM: number;
  /** How far along the current leg, 0 to 1. */
  progress: number;
  /** Laps completed since launch. */
  lap: number;
}

/**
 * Walks the aircraft around a fixed list of waypoints, looping forever.
 *
 * It only ever publishes a bearing and an altitude — the autopilot still has
 * to fly there with bank and pitch, so the track is a real flown path with
 * real turn radii, not a line the model is dragged along.
 */
export class RouteFollower {
  private index = 0;
  private lap = 0;
  private legLength = 1;

  private readonly here = new Cartographic();
  private readonly geodesic = new EllipsoidGeodesic();

  constructor(private readonly waypoints: Waypoint[]) {
    if (waypoints.length < 2) throw new Error("A route needs at least two waypoints");
    this.legLength = this.legDistance();
  }

  reset(): void {
    this.index = 0;
    this.lap = 0;
    this.legLength = this.legDistance();
  }

  /** The waypoint the aircraft is flying toward. */
  get target(): Waypoint {
    return this.waypoints[this.index] as Waypoint;
  }

  /** The one behind it, which the current leg started from. */
  get origin(): Waypoint {
    const previous = (this.index - 1 + this.waypoints.length) % this.waypoints.length;
    return this.waypoints[previous] as Waypoint;
  }

  /** Initial heading for the launch leg, degrees. */
  launchBearingDeg(): number {
    const first = this.waypoints[0] as Waypoint;
    const second = this.waypoints[1] as Waypoint;
    this.geodesic.setEndPoints(
      Cartographic.fromDegrees(first.lon, first.lat),
      Cartographic.fromDegrees(second.lon, second.lat),
    );
    return toDeg(this.geodesic.startHeading);
  }

  update(state: FlightState): LegCommand {
    const here = Cartographic.fromRadians(
      state.carto.longitude,
      state.carto.latitude,
      0,
      this.here,
    );

    let target = this.target;
    this.geodesic.setEndPoints(here, Cartographic.fromDegrees(target.lon, target.lat));
    let distance = this.geodesic.surfaceDistance;

    if (distance < CAPTURE_M) {
      this.advance();
      target = this.target;
      this.geodesic.setEndPoints(here, Cartographic.fromDegrees(target.lon, target.lat));
      distance = this.geodesic.surfaceDistance;
    }

    // Ramp the altitude across the leg instead of stepping at the waypoint, so
    // climbs and descents are flown rather than teleported.
    const progress = clamp(1 - distance / Math.max(this.legLength, 1), 0, 1);
    const origin = this.origin;

    return {
      bearing: this.geodesic.startHeading,
      agl: lerp(origin.agl, target.agl, progress),
      from: origin,
      to: target,
      distanceM: distance,
      progress,
      lap: this.lap,
    };
  }

  private advance(): void {
    this.index = (this.index + 1) % this.waypoints.length;
    if (this.index === 0) this.lap += 1;
    this.legLength = this.legDistance();
  }

  /** Length of the leg running into the active waypoint. */
  private legDistance(): number {
    const origin = this.origin;
    const target = this.target;
    const geodesic = new EllipsoidGeodesic(
      Cartographic.fromDegrees(origin.lon, origin.lat),
      Cartographic.fromDegrees(target.lon, target.lat),
    );
    return geodesic.surfaceDistance;
  }
}
