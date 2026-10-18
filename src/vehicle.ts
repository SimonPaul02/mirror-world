import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  Entity,
  HeadingPitchRoll,
  JulianDate,
  PolylineDashMaterialProperty,
  Quaternion,
  ReferenceFrame,
  Transforms,
  type Viewer,
} from "cesium";

import type { AircraftModel } from "./models";
import type { FlightSim } from "./sim";

const TRAIL_INTERVAL = 0.4;
const TRAIL_MAX = 3000;

/**
 * The aircraft's Cesium entities: the glTF itself, a flown track, and a dashed
 * line down to the ground for depth. Position and orientation are callback
 * properties reading straight out of the FlightSim.
 */
export class Aircraft {
  readonly entity: Entity;
  private readonly trailEntity: Entity;
  private readonly tetherEntity: Entity;

  private readonly trail: Cartesian3[] = [];
  private trailClock = 0;

  private readonly hprScratch = new HeadingPitchRoll();
  private readonly tether: Cartesian3[] = [new Cartesian3(), new Cartesian3()];
  private readonly groundCarto = new Cartographic();

  constructor(
    viewer: Viewer,
    private readonly sim: FlightSim,
    private readonly model: AircraftModel,
  ) {
    this.entity = viewer.entities.add({
      id: "aircraft",
      name: model.label,
      position: new CallbackPositionProperty(
        (_time?: JulianDate, result?: Cartesian3) =>
          Cartesian3.clone(this.sim.state.position, result ?? new Cartesian3()),
        false,
        ReferenceFrame.FIXED,
      ),
      orientation: new CallbackProperty(
        (_time?: JulianDate, result?: Quaternion) => this.orientation(result),
        false,
      ),
      model: {
        uri: model.uri,
        scale: model.scale,
        minimumPixelSize: model.minimumPixelSize,
        maximumScale: 20_000,
      },
    });

    this.trailEntity = viewer.entities.add({
      id: "aircraft-trail",
      polyline: {
        positions: new CallbackProperty(
          () => (this.trail.length > 1 ? this.trail : undefined),
          false,
        ),
        width: 2,
        material: Color.fromCssColorString("#4dd4ff").withAlpha(0.6),
      },
    });

    this.tetherEntity = viewer.entities.add({
      id: "aircraft-tether",
      polyline: {
        positions: new CallbackProperty(() => this.tetherPositions(), false),
        width: 1,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString("#8affc1").withAlpha(0.35),
          dashLength: 14,
        }),
      },
    });
  }

  get position(): Cartesian3 {
    return this.sim.state.position;
  }

  setTrackVisible(visible: boolean): void {
    this.trailEntity.show = visible;
    this.tetherEntity.show = visible;
  }

  clearTrail(): void {
    this.trail.length = 0;
    this.trailClock = 0;
  }

  /** Called once per frame after the sim has stepped. */
  recordTrail(dt: number): void {
    this.trailClock += dt;
    if (this.trailClock < TRAIL_INTERVAL) return;
    this.trailClock = 0;

    this.trail.push(Cartesian3.clone(this.sim.state.position));
    if (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  private orientation(result?: Quaternion): Quaternion {
    const s = this.sim.state;
    const hpr = this.hprScratch;
    hpr.heading = s.bearing + this.model.noseOffset;
    hpr.pitch = s.pitch;
    hpr.roll = s.roll;
    return Transforms.headingPitchRollQuaternion(
      s.position,
      hpr,
      undefined,
      undefined,
      result ?? new Quaternion(),
    );
  }

  private tetherPositions(): Cartesian3[] | undefined {
    const s = this.sim.state;
    if (s.aglHeight < 2) return undefined;

    Cartesian3.clone(s.position, this.tether[0] as Cartesian3);
    const carto = Cartographic.fromCartesian(s.position, undefined, this.groundCarto);
    if (!carto) return undefined;

    const height = carto.height;
    carto.height = s.groundHeight;
    Cartographic.toCartesian(carto, undefined, this.tether[1] as Cartesian3);
    carto.height = height;

    return this.tether;
  }
}
