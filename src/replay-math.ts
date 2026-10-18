export interface Grid {
  width: number; height: number; west: number; north: number; dx: number; dy: number;
  values: ArrayLike<number>;
}
export interface TruthState {
  elapsed_s: number; timestamp: string; longitude_deg: number; latitude_deg: number;
  altitude_egm2008_m: number; surface_elevation_egm2008_m: number;
  height_above_surface_m: number; ground_speed_mps: number; heading_deg: number;
}
export function contains(g: Grid, lon: number, lat: number): boolean {
  return lon >= g.west && lon <= g.west + (g.width - 1) * g.dx &&
    lat <= g.north && lat >= g.north - (g.height - 1) * g.dy;
}
export function sampleGrid(g: Grid, lon: number, lat: number): number {
  if (!contains(g, lon, lat)) throw new Error("Coordinate outside local grid");
  const x = Math.min(g.width - 1, (lon - g.west) / g.dx);
  const y = Math.min(g.height - 1, (g.north - lat) / g.dy);
  const ix = Math.min(Math.floor(x), g.width - 2), iy = Math.min(Math.floor(y), g.height - 2);
  const fx = x - ix, fy = y - iy;
  const a = g.values[iy * g.width + ix]!, b = g.values[iy * g.width + ix + 1]!;
  const c = g.values[(iy + 1) * g.width + ix]!, d = g.values[(iy + 1) * g.width + ix + 1]!;
  const value = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  if (!Number.isFinite(value)) throw new Error("Missing local elevation");
  return value;
}
// Display interpolation only. Exported truth is never mutated by replay.
export function replayState(states: TruthState[], elapsed: number): TruthState {
  let lo = 0, hi = states.length - 1;
  if (elapsed <= states[0]!.elapsed_s) return states[0]!;
  if (elapsed >= states[hi]!.elapsed_s) return states[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (states[mid]!.elapsed_s <= elapsed) lo = mid; else hi = mid;
  }
  const a = states[lo]!, b = states[hi]!, t = (elapsed - a.elapsed_s) / (b.elapsed_s - a.elapsed_s);
  const mix = (x: number, y: number) => x + (y - x) * t;
  return { ...a, elapsed_s: elapsed,
    timestamp: new Date(Date.parse(a.timestamp) + (elapsed - a.elapsed_s) * 1000).toISOString(),
    longitude_deg: mix(a.longitude_deg, b.longitude_deg), latitude_deg: mix(a.latitude_deg, b.latitude_deg),
    altitude_egm2008_m: mix(a.altitude_egm2008_m, b.altitude_egm2008_m),
    surface_elevation_egm2008_m: mix(a.surface_elevation_egm2008_m, b.surface_elevation_egm2008_m),
    height_above_surface_m: mix(a.height_above_surface_m, b.height_above_surface_m),
    ground_speed_mps: mix(a.ground_speed_mps, b.ground_speed_mps),
    heading_deg: (a.heading_deg + ((b.heading_deg - a.heading_deg + 540) % 360 - 180) * t + 360) % 360
  };
}
