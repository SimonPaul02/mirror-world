/** Small numeric helpers shared by the flight models. */

export const G = 9.80665;
export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Moves `value` toward `target` by at most `maxStep`. */
export function approach(value: number, target: number, maxStep: number): number {
  const delta = target - value;
  if (Math.abs(delta) <= maxStep) return target;
  return value + Math.sign(delta) * maxStep;
}

/** Normalises an angle to [0, 2π). */
export function wrap2Pi(angle: number): number {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

export const toDeg = (rad: number): number => (rad * 180) / Math.PI;
export const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Frame-rate independent smoothing factor for an exponential approach. */
export function smoothing(halfLifeSeconds: number, dt: number): number {
  return 1 - Math.pow(0.5, dt / halfLifeSeconds);
}

/** Signed shortest angle from `from` to `to`, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  return wrap2Pi(to - from + Math.PI) - Math.PI;
}

export type Random = () => number;

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * The scenario seeds it once, so every bearing error and fade in a run is
 * reproducible: the same seed replays exactly the same sensor data.
 */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One standard normal draw, Box-Muller. */
export function gaussian(random: Random): number {
  // Guard the log against an exact zero.
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
