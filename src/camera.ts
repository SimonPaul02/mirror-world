import {
  Cartesian3,
  Cartographic,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  Transforms,
  type Viewer,
} from "cesium";

import type { Controls } from "./input";
import { clamp, wrap2Pi } from "./math";

const LOOK_SENSITIVITY = 0.0025;
const MAX_PITCH = CesiumMath.toRadians(88);
/** Never let the eye sink below the ground; underground renders as black. */
const GROUND_CLEARANCE = 3;

export type CameraMode = "follow" | "free";

/**
 * Two ways to watch the aircraft, sharing one set of mouse and key bindings.
 *
 * `follow` orbits the aircraft and travels with it. `free` detaches entirely —
 * six degrees of freedom, go anywhere. Cesium's own controller orbits the
 * globe, which is neither of these, so it stays switched off and the camera is
 * driven directly.
 */
export class CameraRig {
  private mode: CameraMode = "follow";

  /** Free-flight orientation, in the camera's own east-north-up frame. */
  private yaw = 0;
  private pitch = -0.15;
  private speedScale = 1;

  /** Follow-mode orbit, relative to the aircraft's heading. */
  private followYaw = 0;
  private followPitch = -0.22;
  private followDistance = 180;

  private looking = false;

  private readonly enuScratch = new Matrix4();
  private readonly localScratch = new Cartesian3();
  private readonly deltaScratch = new Cartesian3();
  private readonly positionScratch = new Cartesian3();
  private readonly cartoScratch = new Cartographic();
  private readonly dirScratch = new Cartesian3();
  private readonly offsetScratch = new HeadingPitchRange();

  constructor(
    private readonly viewer: Viewer,
    private readonly controls: Controls,
  ) {
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    const canvas = viewer.canvas;
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  get current(): CameraMode {
    return this.mode;
  }

  /** Swaps mode without the view jumping. */
  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;

    if (mode === "free") {
      // Inherit wherever follow mode was pointing, then let go of the target.
      this.yaw = wrap2Pi(this.viewer.camera.heading);
      this.pitch = clamp(this.viewer.camera.pitch, -MAX_PITCH, MAX_PITCH);
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    }
    this.mode = mode;
  }

  toggleMode(): CameraMode {
    this.setMode(this.mode === "follow" ? "free" : "follow");
    return this.mode;
  }

  /** Drops the eye at a position already looking at `target`. */
  placeLookingAt(position: Cartesian3, target: Cartesian3): void {
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.camera.setView({ destination: position });
    this.aimAt(target);
    if (this.mode === "free") this.apply(Cartesian3.clone(position, this.positionScratch));
  }

  /** Turns to face a point without moving. */
  aimAt(target: Cartesian3): void {
    if (this.mode === "follow") {
      // Already looking at the aircraft; just square up behind it.
      this.followYaw = 0;
      return;
    }

    const from = this.viewer.camera.positionWC;
    const direction = Cartesian3.subtract(target, from, this.dirScratch);
    if (Cartesian3.magnitude(direction) < 1) return;
    Cartesian3.normalize(direction, direction);

    // Express the look direction in the camera's own east-north-up frame.
    const enu = Transforms.eastNorthUpToFixedFrame(from, undefined, this.enuScratch);
    const inverse = Matrix4.inverseTransformation(enu, this.enuScratch);
    const local = Matrix4.multiplyByPointAsVector(inverse, direction, this.localScratch);

    this.yaw = wrap2Pi(Math.atan2(local.x, local.y));
    this.pitch = clamp(Math.asin(clamp(local.z, -1, 1)), -MAX_PITCH, MAX_PITCH);
  }

  /**
   * @param target Aircraft position, used by follow mode.
   * @param targetBearing Aircraft heading, so the orbit trails behind it.
   */
  update(dt: number, target: Cartesian3, targetBearing: number): void {
    if (this.mode === "follow") this.updateFollow(target, targetBearing);
    else this.updateFree(dt);
  }

  private updateFollow(target: Cartesian3, targetBearing: number): void {
    const offset = this.offsetScratch;
    offset.heading = wrap2Pi(targetBearing + this.followYaw);
    offset.pitch = this.followPitch;
    offset.range = this.followDistance;
    this.viewer.camera.lookAt(target, offset);
  }

  private updateFree(dt: number): void {
    const axes = this.controls.axes();
    const forward = clamp(axes.ws + axes.arrowUD, -1, 1);
    const strafe = clamp(axes.ad + axes.arrowLR, -1, 1);
    const vertical = clamp(axes.qe, -1, 1);

    const position = Cartesian3.clone(this.viewer.camera.positionWC, this.positionScratch);

    if (forward !== 0 || strafe !== 0 || vertical !== 0) {
      const speed = this.moveSpeed() * (axes.boost ? 4 : 1) * dt;
      const cosPitch = Math.cos(this.pitch);
      const sinYaw = Math.sin(this.yaw);
      const cosYaw = Math.cos(this.yaw);

      // Unit vector along yaw is (sin, cos) in (east, north); its right is
      // (cos, -sin). Pitch tilts the forward axis out of the horizontal plane.
      const east = forward * sinYaw * cosPitch + strafe * cosYaw;
      const north = forward * cosYaw * cosPitch - strafe * sinYaw;
      const up = forward * Math.sin(this.pitch) + vertical;

      const local = Cartesian3.fromElements(
        east * speed,
        north * speed,
        up * speed,
        this.localScratch,
      );
      const enu = Transforms.eastNorthUpToFixedFrame(position, undefined, this.enuScratch);
      const delta = Matrix4.multiplyByPointAsVector(enu, local, this.deltaScratch);
      Cartesian3.add(position, delta, position);
    }

    this.apply(position);
  }

  /** Metres per second, scaled by height so high altitude isn't a crawl. */
  moveSpeed(): number {
    return clamp(this.heightAboveGround() * 0.45, 20, 4000) * this.speedScale;
  }

  heightAboveGround(): number {
    const carto = Cartographic.fromCartesian(
      this.viewer.camera.positionWC,
      undefined,
      this.cartoScratch,
    );
    if (!carto) return 1000;
    const ground = this.viewer.scene.globe.getHeight(carto);
    const height = carto.height - (ground !== undefined && Number.isFinite(ground) ? ground : 0);
    return Math.max(height, 1);
  }

  destroy(): void {
    const canvas = this.viewer.canvas;
    canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
  }

  private apply(position: Cartesian3): void {
    const carto = Cartographic.fromCartesian(position, undefined, this.cartoScratch);
    if (carto) {
      const ground = this.viewer.scene.globe.getHeight(carto);
      const floor =
        (ground !== undefined && Number.isFinite(ground) ? ground : 0) + GROUND_CLEARANCE;
      if (carto.height < floor) {
        carto.height = floor;
        Cartographic.toCartesian(carto, undefined, position);
      }
    }

    this.viewer.camera.setView({
      destination: position,
      orientation: { heading: this.yaw, pitch: this.pitch, roll: 0 },
    });
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.looking = true;
    this.viewer.canvas.style.cursor = "grabbing";
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.looking) return;

    if (this.mode === "follow") {
      // Orbit the aircraft rather than turning in place.
      this.followYaw = wrap2Pi(this.followYaw - event.movementX * LOOK_SENSITIVITY);
      this.followPitch = clamp(
        this.followPitch + event.movementY * LOOK_SENSITIVITY,
        -1.45,
        0.4,
      );
      return;
    }

    this.yaw = wrap2Pi(this.yaw + event.movementX * LOOK_SENSITIVITY);
    this.pitch = clamp(this.pitch - event.movementY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
  };

  private readonly onMouseUp = (): void => {
    this.looking = false;
    this.viewer.canvas.style.cursor = "grab";
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const step = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    if (this.mode === "follow") {
      this.followDistance = clamp(this.followDistance * step, 35, 20_000);
    } else {
      this.speedScale = clamp(this.speedScale / step, 0.1, 25);
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };
}
