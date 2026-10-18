import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  Matrix4,
  PolylineDashMaterialProperty,
  Transforms,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from "cesium";

import { toRad } from "./math";
import type { ReceiverSite, Waypoint } from "./scenario";
import type { Detection, Fix } from "./signals";

const PLAN = Color.fromCssColorString("#ffb648");
const SENSOR = Color.fromCssColorString("#8affc1");
const BEARING = Color.fromCssColorString("#ffe479");
const ESTIMATE = Color.fromCssColorString("#ff6b5e");

/** Bearing lines run this far when nothing has been crossed yet, metres. */
const LOB_FALLBACK_M = 40_000;

const labelDefaults = {
  font: "600 11px ui-monospace, Menlo, monospace",
  fillColor: Color.WHITE,
  outlineColor: Color.fromCssColorString("#050a12"),
  outlineWidth: 3,
  style: LabelStyle.FILL_AND_OUTLINE,
  verticalOrigin: VerticalOrigin.BOTTOM,
  horizontalOrigin: HorizontalOrigin.LEFT,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
} as const;

/** Point at `bearing` and `distance` from an origin, on the same height. */
function project(origin: Cartesian3, bearingDeg: number, distanceM: number): Cartesian3 {
  const frame = Transforms.eastNorthUpToFixedFrame(origin);
  const bearing = toRad(bearingDeg);
  const local = new Cartesian3(
    distanceM * Math.sin(bearing),
    distanceM * Math.cos(bearing),
    0,
  );
  return Matrix4.multiplyByPoint(frame, local, new Cartesian3());
}

/**
 * Everything the scenario draws besides the aircraft itself: the planned
 * circuit, the two arrays, their live bearings, and the crossed-bearing
 * estimate against the truth.
 */
export class ScenarioView {
  private readonly lobs = new Map<string, { entity: Entity; positions: Cartesian3[] }>();
  private readonly fixEntity: Entity;
  private readonly fixRingEntity: Entity;
  private readonly missEntity: Entity;

  private fixPosition: Cartesian3 | undefined;
  private fixRadius = 0;
  private fixLabel = "";
  private readonly missLine: Cartesian3[] = [new Cartesian3(), new Cartesian3()];
  private missVisible = false;
  private readonly siteIds: string[];
  private readonly routeIds: string[];

  constructor(
    private readonly viewer: Viewer,
    route: Waypoint[],
    receivers: ReceiverSite[],
  ) {
    this.siteIds = receivers.flatMap((receiver) => [`rx-${receiver.uid}`, `rx-mast-${receiver.uid}`]);
    this.routeIds = route.length ? ["route-plan", ...route.map((point) => `wp-${point.name}`)] : [];
    if (route.length) this.drawRoute(route);
    for (const receiver of receivers) this.drawReceiver(receiver);

    this.fixRingEntity = viewer.entities.add({
      id: "fix-ring",
      position: new CallbackProperty(() => this.fixPosition, false) as never,
      ellipse: {
        semiMajorAxis: new CallbackProperty(() => this.fixRadius, false),
        semiMinorAxis: new CallbackProperty(() => this.fixRadius, false),
        material: ESTIMATE.withAlpha(0.12),
        outline: true,
        outlineColor: ESTIMATE.withAlpha(0.85),
        outlineWidth: 2,
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND,
      },
      show: false,
    });

    this.fixEntity = viewer.entities.add({
      id: "fix-point",
      position: new CallbackProperty(() => this.fixPosition, false) as never,
      point: {
        pixelSize: 9,
        color: ESTIMATE,
        outlineColor: Color.WHITE.withAlpha(0.8),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        ...labelDefaults,
        text: new CallbackProperty(() => this.fixLabel, false),
        fillColor: ESTIMATE,
        pixelOffset: new Cartesian2(10, -6),
      },
      show: false,
    });

    // The honest part of the picture: how far the estimate sits from truth.
    this.missEntity = viewer.entities.add({
      id: "fix-miss",
      polyline: {
        positions: new CallbackProperty(
          () => (this.missVisible ? this.missLine : undefined),
          false,
        ),
        width: 1.5,
        material: new PolylineDashMaterialProperty({
          color: Color.WHITE.withAlpha(0.65),
          dashLength: 10,
        }),
      },
      show: false,
    });
  }

  /** Hand in the latest reports; bearings and the estimate follow. */
  setReports(detections: Detection[], fix: Fix | undefined, truth: Cartesian3): void {
    for (const detection of detections) {
      const lob = this.lobs.get(detection.receiver.uid);
      if (!lob) continue;

      lob.entity.show = detection.heard;
      if (!detection.heard) continue;

      const origin = Cartesian3.fromDegrees(
        detection.receiver.lon,
        detection.receiver.lat,
        detection.antennaHae,
      );
      const reach = fix ? Cartesian3.distance(origin, Cartesian3.fromDegrees(fix.lon, fix.lat, detection.antennaHae)) * 1.08 : LOB_FALLBACK_M;
      Cartesian3.clone(origin, lob.positions[0] as Cartesian3);
      Cartesian3.clone(
        project(origin, detection.measuredBearingDeg, reach),
        lob.positions[1] as Cartesian3,
      );
    }

    if (!fix) {
      this.fixEntity.show = false;
      this.fixRingEntity.show = false;
      this.missEntity.show = false;
      this.missVisible = false;
      return;
    }

    this.fixPosition = Cartesian3.fromDegrees(fix.lon, fix.lat, fix.haeM);
    this.fixRadius = fix.ceM;
    const missM = Cartesian3.distance(this.fixPosition, truth);
    this.fixLabel = `FIX  ce ±${Math.round(fix.ceM)} m · off by ${Math.round(missM)} m`;

    Cartesian3.clone(this.fixPosition, this.missLine[0] as Cartesian3);
    Cartesian3.clone(truth, this.missLine[1] as Cartesian3);
    this.missVisible = true;

    this.fixEntity.show = true;
    this.fixRingEntity.show = true;
    this.missEntity.show = true;
  }

  /** Called on reset, before the first report of the new run. */
  clear(): void {
    for (const lob of this.lobs.values()) lob.entity.show = false;
    this.fixEntity.show = false;
    this.fixRingEntity.show = false;
    this.missEntity.show = false;
    this.missVisible = false;
  }

  /** Dispose replay overlays before replacing the trajectory or receiver sites. */
  destroy(): void {
    for (const lob of this.lobs.values()) this.viewer.entities.remove(lob.entity);
    this.viewer.entities.remove(this.fixEntity);
    this.viewer.entities.remove(this.fixRingEntity);
    this.viewer.entities.remove(this.missEntity);
    for (const id of [...this.siteIds, ...this.routeIds]) this.viewer.entities.removeById(id);
  }

  private drawRoute(route: Waypoint[]): void {
    const loop = [...route, route[0] as Waypoint];
    this.viewer.entities.add({
      id: "route-plan",
      polyline: {
        positions: loop.map((w) => Cartesian3.fromDegrees(w.lon, w.lat)),
        width: 2,
        clampToGround: true,
        material: new PolylineDashMaterialProperty({
          color: PLAN.withAlpha(0.75),
          dashLength: 18,
        }),
      },
    });

    for (const waypoint of route) {
      this.viewer.entities.add({
        id: `wp-${waypoint.name}`,
        position: Cartesian3.fromDegrees(waypoint.lon, waypoint.lat),
        point: {
          pixelSize: 6,
          color: PLAN,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          ...labelDefaults,
          // "AGL" matters: a bare "2200 m" next to a waypoint reads as the
          // range to it, which never counts down and looks like a stuck sim.
          text: `${waypoint.name}  ${waypoint.agl} m AGL`,
          fillColor: PLAN,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          pixelOffset: new Cartesian2(8, -4),
          // Waypoint names are clutter from orbit; they fade in on approach.
          distanceDisplayCondition: undefined,
        },
      });
    }
  }

  private drawReceiver(receiver: ReceiverSite): void {
    const ground = Cartesian3.fromDegrees(receiver.lon, receiver.lat);
    this.viewer.entities.add({
      id: `rx-${receiver.uid}`,
      position: ground,
      point: {
        pixelSize: 10,
        color: SENSOR,
        outlineColor: Color.fromCssColorString("#06301d"),
        outlineWidth: 2,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        ...labelDefaults,
        text: `${receiver.callsign}\n${receiver.mastM} m mast`,
        fillColor: SENSOR,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        pixelOffset: new Cartesian2(11, -2),
      },
    });

    // The mast itself, so the antenna reads as being above the ridge.
    this.viewer.entities.add({
      id: `rx-mast-${receiver.uid}`,
      polyline: {
        positions: new CallbackProperty(() => {
          const carto = Cartographic.fromDegrees(receiver.lon, receiver.lat);
          const height = this.viewer.scene.globe.getHeight(carto) ?? 0;
          return [
            Cartesian3.fromDegrees(receiver.lon, receiver.lat, height),
            Cartesian3.fromDegrees(receiver.lon, receiver.lat, height + receiver.mastM),
          ];
        }, false),
        width: 2,
        material: SENSOR.withAlpha(0.8),
      },
    });

    const positions = [new Cartesian3(), new Cartesian3()];
    const entity = this.viewer.entities.add({
      id: `lob-${receiver.uid}`,
      polyline: {
        positions: new CallbackProperty(() => positions, false),
        width: 1.6,
        // Bearings are a horizontal map overlay; avoid hiding them inside relief.
        clampToGround: true,
        material: BEARING.withAlpha(0.85),
      },
      show: false,
    });
    this.lobs.set(receiver.uid, { entity, positions });
  }
}
