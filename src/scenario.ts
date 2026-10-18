/**
 * Mirror World — a hardcoded synthetic defence scenario over the Donbas.
 *
 * One MQ-9-class UAV flies a fixed reconnaissance circuit between Lyman,
 * Siversk, Bakhmut and Kramatorsk in Donetsk Oblast. Two ground DF arrays on
 * the Donets ridge listen to its 2.4 GHz video downlink and cross their
 * bearings. Everything here is the scenario's *truth*; what the sensors make of
 * it is computed in `signals.ts` and written out as TAK CoT in `cot.ts`.
 *
 * Every number below is fixed, and the sensor noise is drawn from a seeded
 * generator, so the same scenario replays byte-for-byte on every run.
 */

export interface Waypoint {
  /** Shown on the map and in the mission card. */
  name: string;
  lon: number;
  lat: number;
  /** Altitude flown on the leg *into* this point, metres above ground. */
  agl: number;
  /** Why the leg is flown this way, carried into the scenario manifest. */
  intent: string;
}

export interface ReceiverSite {
  /** CoT uid, also the `sensor` attribute on every `__signal` it produces. */
  uid: string;
  callsign: string;
  lon: number;
  lat: number;
  /** Antenna height above local ground, metres. */
  mastM: number;
  /** Gain of the DF array toward the emitter's band, dBi. */
  gainDbi: number;
  /** Array calibration floor on bearing accuracy, degrees 1σ. */
  sigmaFloorDeg: number;
  /**
   * Fixed bearing bias from siting and local multipath, degrees. Real arrays
   * are never perfectly calibrated, and the bias is what pulls a crossed-bearing
   * fix consistently off to one side.
   */
  biasDeg: number;
  /** Receiver noise floor in the analysis bandwidth, dBm. */
  noiseFloorDbm: number;
  /** Minimum SNR the detector needs to declare the signal present, dB. */
  detectSnrDb: number;
}

export interface Emitter {
  /** CoT uid of the truth track. */
  uid: string;
  callsign: string;
  /** What the sensors call it, before anyone identifies it. */
  unknownCallsign: string;
  freqMhz: number;
  /** Effective radiated power toward the receivers, dBm. */
  eirpDbm: number;
  /** Occupied bandwidth of the downlink, MHz — sets the noise floor. */
  bandwidthMhz: number;
}

/**
 * The circuit. Roughly 170 km, about 26 minutes a lap at the MQ-9's 400 km/h
 * cruise, so a scenario of a few laps sits inside the brief's "few minutes to
 * a few hours".
 *
 * The two valley legs are flown low on purpose: down at 200 m over the
 * Siverskyi Donets the ridge south of the river cuts the line of sight to one
 * array at a time, and the feed shows a single-sensor bearing with no fix —
 * the dropout the brief asks for, produced by terrain rather than scripted.
 */
export const ROUTE: Waypoint[] = [
  {
    name: "ENTRY",
    lon: 37.42,
    lat: 49.05,
    agl: 2400,
    intent: "Ingress from the north-west at medium altitude",
  },
  {
    name: "LYMAN",
    lon: 37.7,
    lat: 48.99,
    agl: 2200,
    intent: "Turn east along the rail line",
  },
  {
    name: "DONETS",
    lon: 37.95,
    lat: 48.92,
    agl: 420,
    intent: "Descend into the Siverskyi Donets valley",
  },
  {
    name: "SIVERSK",
    lon: 38.12,
    lat: 48.86,
    agl: 200,
    intent: "Low run east, masked from the arrays by the ridge",
  },
  {
    name: "SOLEDAR",
    lon: 38.07,
    lat: 48.69,
    agl: 1500,
    intent: "Climb out of the valley heading south",
  },
  {
    name: "BAKHMUT",
    lon: 37.99,
    lat: 48.59,
    agl: 2600,
    intent: "Standoff altitude over the southern leg",
  },
  {
    name: "KOSTIANT",
    lon: 37.72,
    lat: 48.53,
    agl: 2600,
    intent: "Westbound, closest approach to the arrays",
  },
  {
    name: "KRAMAT",
    lon: 37.56,
    lat: 48.73,
    agl: 2000,
    intent: "Northbound past Kramatorsk",
  },
  {
    name: "RETURN",
    lon: 37.48,
    lat: 48.9,
    agl: 2400,
    intent: "Rejoin the entry point and fly the circuit again",
  },
];

/**
 * Two arrays 6.7 km apart on the high ground of the Donets ridge, as the brief
 * suggests. The baseline runs NNW so that bearings to most of the circuit cross
 * at a usable angle; targets along the baseline itself give a long, thin error
 * ellipse, and the feed reports that honestly in `ce`.
 */
export const RECEIVERS: ReceiverSite[] = [
  {
    uid: "RF1",
    callsign: "RF1 SHPYL",
    lon: 37.845,
    lat: 48.712,
    mastM: 18,
    gainDbi: 10,
    sigmaFloorDeg: 1.4,
    biasDeg: 0.6,
    noiseFloorDbm: -104,
    detectSnrDb: 6,
  },
  {
    uid: "RF2",
    callsign: "RF2 VYSHNIA",
    lon: 37.79,
    lat: 48.76,
    mastM: 24,
    gainDbi: 11,
    sigmaFloorDeg: 1.8,
    biasDeg: -0.9,
    noiseFloorDbm: -103,
    detectSnrDb: 6,
  },
];

/** The thing everyone is watching: a 0.5 W analogue video downlink. */
export const EMITTER: Emitter = {
  uid: "drone_07",
  callsign: "DRONE 07",
  unknownCallsign: "Unknown drone, 2.4 GHz",
  freqMhz: 2437.5,
  eirpDbm: 27,
  bandwidthMhz: 3,
};

/**
 * Scenario start, UTC. Early November, mid-afternoon local (UTC+2) — the sun is
 * low enough for long shadows on the ridge without the globe going dark.
 */
export const START_ISO = "2026-11-03T12:10:00Z";

/** How often the arrays report, seconds of scenario time. */
export const REPORT_INTERVAL_S = 2;

/** Seed for every random draw in the scenario, so runs are reproducible. */
export const SEED = 20_261_103;

export const SCENARIO_NAME = "Donbas ridge — single UAV, two DF arrays";
export const SCENARIO_ID = "mirror-world-donbas-01";
