import type { RawAxes } from "./input";
import { angleDelta, clamp } from "./math";
import { MQ9 } from "./profiles";
import type { FlightState } from "./sim";

/** Bank the autopilot is willing to use to make a turn. */
const MAX_TURN_BANK = MQ9.maxBank * 0.78;
/** Radians of heading error that call for full bank. */
const FULL_BANK_ERROR = 0.45;
const CRUISE_THROTTLE = MQ9.cruiseThrottle;

const NO_INPUT: RawAxes = {
  ws: 0,
  ad: 0,
  qe: 0,
  arrowLR: 0,
  arrowUD: 0,
  bracket: 0,
  brake: false,
  boost: false,
};

/**
 * Flies the aircraft toward a commanded bearing at a commanded altitude.
 *
 * It drives the same control axes a pilot would, so the aircraft keeps the
 * flight model's real behaviour — coordinated turns at a real turn radius,
 * energy traded against climb — rather than being dragged along a path.
 */
export function autopilot(
  state: FlightState,
  targetAgl: number,
  targetBearing: number,
): RawAxes {
  // Proportional on altitude error, damped by climb rate, or it porpoises.
  const altitudeError = targetAgl - state.aglHeight;
  const pitchCommand = clamp(altitudeError * 0.004 - state.verticalSpeed * 0.25, -1, 1);

  // Heading error picks a bank angle; the roll loop then chases that bank.
  const headingError = angleDelta(state.bearing, targetBearing);
  const wantedBank = clamp(
    (headingError / FULL_BANK_ERROR) * MAX_TURN_BANK,
    -MAX_TURN_BANK,
    MAX_TURN_BANK,
  );
  const rollCommand = clamp((wantedBank - state.roll) * 6, -1, 1);
  const throttleCommand = clamp((CRUISE_THROTTLE - state.throttle) * 8, -1, 1);

  return {
    ...NO_INPUT,
    ws: throttleCommand,
    ad: rollCommand,
    arrowUD: pitchCommand,
  };
}
