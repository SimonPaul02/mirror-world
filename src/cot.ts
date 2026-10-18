import type { Detection, Fix } from "./signals";
import type { Emitter, ReceiverSite } from "./scenario";

/**
 * TAK Cursor on Target.
 *
 * Every record the scenario produces leaves as a CoT `<event>`, the XML that
 * TAK servers and ATAK read. The shape follows the MITRE CoT schema: an event
 * envelope with a uid, a type from the CoT hierarchy, a `how` saying where the
 * position came from, a validity window, one `<point>` with its error figures,
 * and a `<detail>` carrying everything type-specific.
 *
 * Two extensions are ours, both namespaced the way CoT asks third parties to:
 * `__signal` for one array's measurement of one emission, and `_mirrorworld`
 * for the provenance the brief wants — which object in the scenario a record
 * came from, and whether it is truth or something a sensor believed.
 */

/** Which feed a record belongs to: what the sensors saw, or what was real. */
export type Channel = "sensor" | "truth";

export interface CotPoint {
  lat: number;
  lon: number;
  /** Height above the WGS-84 ellipsoid, metres. */
  hae: number;
  /** Circular error, metres 1σ. CoT's own "unknown" is 9999999.0. */
  ce: number;
  /** Linear (vertical) error, metres 1σ. */
  le: number;
}

export interface CotRecord {
  uid: string;
  /** CoT type, e.g. `a-u-A` for an unknown air track. */
  type: string;
  /** CoT `how`: `m-r` is machine-derived from radio, `m-g` machine GPS. */
  how: string;
  time: Date;
  stale: Date;
  point: CotPoint;
  /** Already-serialised `<detail>` children, indented four spaces. */
  detail: string;
  channel: Channel;
  /** Scenario object this record describes, for the manifest. */
  object: string;
}

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const iso = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
const deg = (value: number): string => value.toFixed(6);
const metres = (value: number): string => value.toFixed(1);
const dbm = (value: number): string => value.toFixed(1);

/** One record as the XML a TAK client would receive. */
export function toXml(record: CotRecord): string {
  const { point } = record;
  return [
    `<event version="2.0" uid="${esc(record.uid)}" type="${record.type}" how="${record.how}"`,
    `       time="${iso(record.time)}" start="${iso(record.time)}"`,
    `       stale="${iso(record.stale)}">`,
    `  <point lat="${deg(point.lat)}" lon="${deg(point.lon)}" hae="${metres(point.hae)}" ce="${metres(point.ce)}" le="${metres(point.le)}"/>`,
    `  <detail>`,
    record.detail,
    `  </detail>`,
    `</event>`,
  ].join("\n");
}

const STALE_SITE_S = 300;
const STALE_TRACK_S = 60;
const addSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);

/** A ground array, published as a friendly sensor site. */
export function receiverEvent(
  receiver: ReceiverSite,
  antennaHae: number,
  time: Date,
): CotRecord {
  return {
    uid: receiver.uid,
    // Affiliation friendly, battle dimension ground, equipment, sensor.
    type: "a-f-G-E-S",
    how: "h-g-i-g-o",
    time,
    stale: addSeconds(time, STALE_SITE_S),
    point: { lat: receiver.lat, lon: receiver.lon, hae: antennaHae, ce: 3, le: 3 },
    detail: [
      `    <contact callsign="${esc(receiver.callsign)}"/>`,
      `    <__group name="Cyan" role="Team Member"/>`,
      `    <remarks>2.4 GHz direction-finding array, mast ${receiver.mastM} m AGL, ` +
        `${receiver.gainDbi} dBi, noise floor ${receiver.noiseFloorDbm} dBm</remarks>`,
      `    <_mirrorworld object="${receiver.uid}" kind="sensor-site" truth="1"/>`,
    ].join("\n"),
    channel: "sensor",
    object: receiver.uid,
  };
}

/**
 * One array's line of bearing, with no range to it.
 *
 * Published as a sensor point of interest at the array, carrying a `<sensor>`
 * detail — the element ATAK draws as a field-of-view wedge, so the bearing
 * shows on the map even before anything crosses it.
 */
export function bearingEvent(
  detection: Detection,
  emitter: Emitter,
  sequence: number,
  time: Date,
): CotRecord {
  const { receiver } = detection;
  const id = String(sequence).padStart(6, "0");
  // The wedge is drawn at ±2σ, so its width is the measurement's honesty.
  const fov = Math.min(detection.sigmaDeg * 4, 120);
  return {
    uid: `${receiver.uid}.lob.${id}`,
    type: "b-m-p-s-p-i",
    how: "m-r",
    time,
    stale: addSeconds(time, STALE_TRACK_S),
    point: {
      lat: receiver.lat,
      lon: receiver.lon,
      hae: detection.antennaHae,
      ce: 3,
      le: 3,
    },
    detail: [
      `    <contact callsign="${esc(`${receiver.uid} LOB ${detection.measuredBearingDeg.toFixed(1)}°`)}"/>`,
      `    <sensor azimuth="${detection.measuredBearingDeg.toFixed(2)}" fov="${fov.toFixed(1)}" ` +
        `range="${Math.round(detection.slantRangeM)}" type="RF-DF" model="2.4 GHz interferometer"/>`,
      `    <remarks>Bearing only, no range. ${emitter.freqMhz} MHz at ` +
        `${dbm(detection.rssiDbm)} dBm, SNR ${detection.snrDb.toFixed(1)} dB, ` +
        `sigma ${detection.sigmaDeg.toFixed(1)} deg</remarks>`,
      `    <__signal sensor="${receiver.uid}" freq_mhz="${emitter.freqMhz}" ` +
        `power_dbm="${dbm(detection.rssiDbm)}" bearing_deg="${detection.measuredBearingDeg.toFixed(1)}" ` +
        `snr_db="${detection.snrDb.toFixed(1)}" sigma_deg="${detection.sigmaDeg.toFixed(1)}" ` +
        `terrain_loss_db="${detection.terrainLossDb.toFixed(1)}"/>`,
      `    <_mirrorworld object="${emitter.uid}" kind="line-of-bearing" sensor="${receiver.uid}" truth="0"/>`,
    ].join("\n"),
    channel: "sensor",
    object: emitter.uid,
  };
}

/** The crossed-bearing fix: what the arrays together believe. */
export function fixEvent(
  fix: Fix,
  detections: Detection[],
  emitter: Emitter,
  sequence: number,
  time: Date,
  courseDeg: number | undefined,
  speedMs: number | undefined,
): CotRecord {
  const heard = detections.filter((d) => d.heard && fix.contributors.includes(d.receiver.uid));
  const signals = heard.map(
    (d) =>
      `    <__signal sensor="${d.receiver.uid}" freq_mhz="${emitter.freqMhz}" ` +
      `power_dbm="${dbm(d.rssiDbm)}" bearing_deg="${d.measuredBearingDeg.toFixed(1)}" ` +
      `snr_db="${d.snrDb.toFixed(1)}" sigma_deg="${d.sigmaDeg.toFixed(1)}"/>`,
  );
  const track =
    courseDeg !== undefined && speedMs !== undefined
      ? [`    <track course="${courseDeg.toFixed(1)}" speed="${speedMs.toFixed(1)}"/>`]
      : [];

  return {
    uid: `sig-${String(sequence).padStart(6, "0")}`,
    // Affiliation unknown, battle dimension air.
    type: "a-u-A",
    how: "m-r",
    time,
    stale: addSeconds(time, STALE_TRACK_S),
    point: { lat: fix.lat, lon: fix.lon, hae: fix.haeM, ce: fix.ceM, le: fix.leM },
    detail: [
      `    <contact callsign="${esc(emitter.unknownCallsign)}"/>`,
      `    <remarks>Video link heard by ${fix.contributors.join(" and ")}, ` +
        `position from crossed bearings at ${fix.crossAngleDeg.toFixed(0)} deg</remarks>`,
      ...signals,
      ...track,
      `    <precisionlocation geopointsrc="DF" altsrc="DF"/>`,
      `    <_mirrorworld object="${emitter.uid}" kind="crossed-bearing-fix" ` +
        `sensors="${fix.contributors.join(",")}" truth="0"/>`,
    ].join("\n"),
    channel: "sensor",
    object: emitter.uid,
  };
}

/** The answer key: where the drone really was at this instant. */
export function truthEvent(
  emitter: Emitter,
  lat: number,
  lon: number,
  hae: number,
  aglM: number,
  courseDeg: number,
  speedMs: number,
  leg: string,
  time: Date,
): CotRecord {
  return {
    uid: emitter.uid,
    // Affiliation hostile, air, military, fixed wing, UAV.
    type: "a-h-A-M-F-Q",
    how: "m-g",
    time,
    stale: addSeconds(time, STALE_TRACK_S),
    point: { lat, lon, hae, ce: 0, le: 0 },
    detail: [
      `    <contact callsign="${esc(emitter.callsign)}"/>`,
      `    <track course="${courseDeg.toFixed(1)}" speed="${speedMs.toFixed(1)}"/>`,
      `    <remarks>GROUND TRUTH, not sensor derived. ${Math.round(aglM)} m above ground on leg ${esc(leg)}</remarks>`,
      `    <_mirrorworld object="${emitter.uid}" kind="truth" agl_m="${Math.round(aglM)}" leg="${esc(leg)}"/>`,
    ].join("\n"),
    channel: "truth",
    object: emitter.uid,
  };
}

/** Cap on retained records; a long run would otherwise grow without bound. */
const FEED_CAP = 12_000;

/** The running feed: everything emitted so far, newest last. */
export class CotFeed {
  private readonly records: CotRecord[] = [];
  private dropped = 0;
  private sequence = 0;

  /** Next sequence number for a uid that carries one. */
  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  push(...records: CotRecord[]): void {
    this.records.push(...records);
    if (this.records.length > FEED_CAP) {
      this.dropped += this.records.length - FEED_CAP;
      this.records.splice(0, this.records.length - FEED_CAP);
    }
  }

  clear(): void {
    this.records.length = 0;
    this.dropped = 0;
    this.sequence = 0;
  }

  get size(): number {
    return this.records.length + this.dropped;
  }

  count(channel: Channel): number {
    return this.records.reduce((n, r) => (r.channel === channel ? n + 1 : n), 0);
  }

  latest(): CotRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /** The most recent record of a given kind, for the live XML panel. */
  latestWhere(predicate: (record: CotRecord) => boolean): CotRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i] as CotRecord;
      if (predicate(record)) return record;
    }
    return undefined;
  }

  /**
   * The whole feed as one file.
   *
   * A live TAK link carries each `<event>` on its own, so the `<events>` root
   * is only there to make the capture a single well-formed document — which is
   * how pytak's file sources and most CoT captures do it too.
   */
  toDocument(header: string[]): string {
    const body = this.records.map((record) => toXml(record)).join("\n");
    const dropped =
      this.dropped > 0 ? [`  Earlier records dropped from this capture: ${this.dropped}`] : [];
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!--`,
      ...header.map((line) => `  ${line}`),
      ...dropped,
      `-->`,
      `<events>`,
      body,
      `</events>`,
      ``,
    ].join("\n");
  }
}
