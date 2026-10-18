import { toRad } from "./math";

/** Published airframe data, shown in the readout. */
export interface AircraftSpec {
  designation: string;
  name: string;
  role: string;
  /** Metres. */
  wingspan: number;
  length: number;
  height: number;
  /** Kilograms. */
  mtow: number;
  payload: number;
  powerplant: string;
  /** Metres. */
  serviceCeiling: number;
  enduranceHours: number;
  /** Usable fuel, kilograms. */
  fuelCapacity: number;
}

export interface FlightProfile {
  spec: AircraftSpec;

  /** Speeds in metres/second. */
  minSpeed: number;
  cruiseSpeed: number;
  maxSpeed: number;
  accel: number;
  decel: number;

  /** Attitude limits and rates, radians and radians/second. */
  maxBank: number;
  rollRate: number;
  maxPitch: number;
  pitchRate: number;
  yawRate: number;

  /** Hard altitude limit, metres. */
  ceiling: number;
  /** Clearance kept above ground, metres. */
  minAgl: number;

  throttleRate: number;
  cruiseThrottle: number;
}

/**
 * General Atomics MQ-9 Reaper.
 *
 * Performance figures are the published ones: 50,000 ft ceiling, 400-480 km/h
 * cruise, 27 h endurance, 20.1 m span. The handling rates reflect what that
 * airframe implies — a 4.7 t turboprop on a very high aspect ratio wing rolls
 * and pitches slowly, and accelerates gently.
 */
export const MQ9: FlightProfile = {
  spec: {
    designation: "MQ-9",
    name: "Reaper",
    role: "Medium-altitude long-endurance UCAV",
    wingspan: 20.1,
    length: 11.0,
    height: 3.81,
    mtow: 4760,
    payload: 1700,
    powerplant: "Honeywell TPE331-10 turboprop, 900 shp",
    serviceCeiling: 15_240, // 50,000 ft
    enduranceHours: 27,
    fuelCapacity: 1800,
  },

  // 165 km/h loiter floor, 400 km/h cruise, 482 km/h maximum.
  minSpeed: 46,
  cruiseSpeed: 111,
  maxSpeed: 134,
  // A 900 shp turboprop hauling 4.7 t does not accelerate briskly.
  accel: 3.2,
  decel: 2.6,

  maxBank: toRad(45),
  rollRate: toRad(26),
  maxPitch: toRad(18),
  pitchRate: toRad(7),
  yawRate: toRad(5),

  ceiling: 15_240,
  minAgl: 2.5,

  throttleRate: 0.3,
  // (111 - 46) / (134 - 46): the setting that yields 400 km/h cruise.
  cruiseThrottle: 0.739,
};

/** Fuel burn at cruise throttle, kilograms per hour. */
export const CRUISE_BURN_KG_H = MQ9.spec.fuelCapacity / MQ9.spec.enduranceHours;

/**
 * Burn multiplier against throttle, normalised so cruise throttle burns
 * exactly the rate that yields the published endurance.
 */
export function burnFactor(throttle: number): number {
  // Normalised so burnFactor(cruiseThrottle) === 1, i.e. cruise burns exactly
  // the rate that empties the tanks over the published 27 hours.
  return 0.45 + 0.744 * throttle;
}
