import { toDeg, wrap2Pi } from "./math";
import type { FlightProfile } from "./profiles";
import type { FlightState } from "./sim";

const M_TO_FT = 3.28084;
const MS_TO_KMH = 3.6;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const row = (term: string, value: string): [HTMLElement, HTMLElement] => {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
};

/** Formats seconds as h:mm, for endurance and mission time. */
function hoursMinutes(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function clock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `T+${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export class Hud {
  private readonly alt = el("hud-alt");
  private readonly agl = el("hud-agl");
  private readonly tas = el("hud-tas");
  private readonly vs = el("hud-vs");
  private readonly hdg = el("hud-hdg");
  private readonly thr = el("hud-thr");
  private readonly fuel = el("hud-fuel");
  private readonly endurance = el("hud-endurance");
  private readonly pos = el("hud-pos");
  private readonly mission = el("hud-mission");
  private readonly warp = el("hud-warp");
  private readonly cam = el("hud-cam");

  private accumulator = 0;

  update(
    state: FlightState,
    enduranceHours: number,
    cameraAgl: number,
    cameraSpeed: number,
    dt: number,
  ): void {
    this.accumulator += dt;
    if (this.accumulator < 0.05) return;
    this.accumulator = 0;

    this.alt.textContent = Math.round(state.carto.height * M_TO_FT).toLocaleString();
    this.agl.textContent = Math.round(state.aglHeight).toLocaleString();
    this.tas.textContent = Math.round(state.forwardSpeed * MS_TO_KMH).toString();
    const climb = Math.round(state.verticalSpeed * M_TO_FT * 60);
    this.vs.textContent = (climb >= 0 ? "+" : "") + climb.toLocaleString();
    this.hdg.textContent = toDeg(wrap2Pi(state.bearing)).toFixed(0).padStart(3, "0");
    this.thr.textContent = Math.round(state.throttle * 100).toString();
    this.fuel.textContent = Math.round(state.fuelKg).toLocaleString();
    this.endurance.textContent = hoursMinutes(enduranceHours * 3600);

    const lat = toDeg(state.carto.latitude);
    const lon = toDeg(state.carto.longitude);
    this.pos.textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
    this.mission.textContent = clock(state.missionSeconds);
    this.cam.textContent = `cam ${Math.round(cameraAgl).toLocaleString()} m agl · ${Math.round(cameraSpeed)} m/s`;
  }

  setCameraMode(mode: "follow" | "free"): void {
    const badge = el("hud-mode");
    badge.textContent = mode === "follow" ? "FOLLOW" : "FREE";
    badge.classList.toggle("badge--free", mode === "free");
  }

  setWarp(multiplier: number): void {
    this.warp.textContent = `${multiplier}×`;
  }

  /** Fills the airframe card from the published specification. */
  setSpec(profile: FlightProfile): void {
    const { spec } = profile;
    el("spec-list").replaceChildren(
      ...[
        row("Wingspan", `${spec.wingspan.toFixed(1)} m`),
        row("Length", `${spec.length.toFixed(1)} m`),
        row("Height", `${spec.height.toFixed(2)} m`),
        row("MTOW", `${spec.mtow.toLocaleString()} kg`),
        row("Payload", `${spec.payload.toLocaleString()} kg`),
        row("Ceiling", `${Math.round(spec.serviceCeiling * M_TO_FT).toLocaleString()} ft`),
        row("Cruise", `${Math.round(profile.cruiseSpeed * MS_TO_KMH)} km/h`),
        row("Max speed", `${Math.round(profile.maxSpeed * MS_TO_KMH)} km/h`),
        row("Endurance", `${spec.enduranceHours} h`),
        row("Fuel", `${spec.fuelCapacity.toLocaleString()} kg`),
        row("Engine", spec.powerplant.split(",")[0] ?? ""),
      ].flat(),
    );
  }

  setKeyMap(keys: Array<[string, string]>): void {
    el("help-keys").replaceChildren(...keys.map(([k, v]) => row(k, v)).flat());
  }

  toggleHelp(): void {
    el("help").classList.toggle("card--collapsed");
  }

  toggleSpec(): void {
    el("spec").classList.toggle("card--collapsed");
  }
}
