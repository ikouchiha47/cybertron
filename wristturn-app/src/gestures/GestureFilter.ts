const OPPOSITE: Record<string, string> = {
  turn_right: "turn_left",  turn_left: "turn_right",
  pitch_up:   "pitch_down", pitch_down: "pitch_up",
  yaw_right:  "yaw_left",   yaw_left:  "yaw_right",
};

const AXIS_OF: Record<string, string> = {
  turn_right: "roll",  turn_left: "roll",
  pitch_up:   "pitch", pitch_down: "pitch",
  yaw_right:  "yaw",   yaw_left:  "yaw",
};

// Per-axis: last fired direction + timestamp.
// Activity on other axes never resets a cooldown — roll snap-back
// after pitch_down does not affect the pitch cooldown.
type AxisState = { dir: string; time: number };
const axisCooldown: Record<string, AxisState> = {};

// Per-gesture: last fire timestamp — suppresses ring-buffer duplicates.
const lastFired: Record<string, number> = {};

const RETURN_COOLDOWN_MS = 500;
const REFRACTORY_MS      = 200;  // min gap between two identical gestures — largest observed duplicate is 120ms
// After a shake fires, the wrist settles erratically — suppress follow-on noise.
const SHAKE_GOBBLE_MS    = 500;
export const SNAP_PEAK_THRESHOLD = 4.5; // rad/s — above this = snap, not command

let shakeGobbleUntil = 0;

/**
 * Returns true if the gesture should be dispatched.
 * peakRate is optional; when provided and above SNAP_PEAK_THRESHOLD the gesture
 * is classified as a snap — it passes this filter (caller decides routing) but
 * does NOT arm the snap-back cooldown or the refractory window.
 */
export function filterGesture(gesture: string, peakRate?: number): boolean {
  const now = Date.now();

  // Shake always passes and arms the gobble window.
  if (gesture === "shake") {
    shakeGobbleUntil = now + SHAKE_GOBBLE_MS;
    return true;
  }

  // Suppress all non-shake gestures inside the shake gobble window.
  if (now < shakeGobbleUntil) return false;

  const axis = AXIS_OF[gesture];

  // Refractory: suppress identical gesture fired within REFRACTORY_MS.
  // Snaps bypass refractory — caller handles them separately.
  const isSnap = peakRate !== undefined && peakRate >= SNAP_PEAK_THRESHOLD;
  if (!isSnap) {
    const last = lastFired[gesture];
    if (last && now - last < REFRACTORY_MS) return false;
  }

  if (!axis) {
    if (!isSnap) lastFired[gesture] = now;
    return true;
  }

  // Snap-back cooldown: suppress immediate opposite-direction return.
  // Snaps bypass this — they should not pollute the cooldown state.
  if (!isSnap) {
    const axisState = axisCooldown[axis];
    if (axisState && OPPOSITE[axisState.dir] === gesture && now - axisState.time < RETURN_COOLDOWN_MS) {
      return false;
    }
    axisCooldown[axis] = { dir: gesture, time: now };
    lastFired[gesture] = now;
  }

  return true;
}

export function isSnap(peakRate: number): boolean {
  return peakRate >= SNAP_PEAK_THRESHOLD;
}

export function resetGestureFilter(): void {
  for (const key in axisCooldown) delete axisCooldown[key];
  for (const key in lastFired)    delete lastFired[key];
  shakeGobbleUntil = 0;
}
