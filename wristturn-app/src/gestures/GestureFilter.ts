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

const RETURN_COOLDOWN_MS = 500;
// After a shake fires, the wrist settles erratically — suppress follow-on noise.
const SHAKE_GOBBLE_MS    = 500;

let shakeGobbleUntil = 0;

export function filterGesture(gesture: string): boolean {
  const now = Date.now();

  // Shake always passes through and arms the gobble window.
  if (gesture === "shake") {
    shakeGobbleUntil = now + SHAKE_GOBBLE_MS;
    return true;
  }

  // Suppress all non-shake gestures inside the gobble window.
  if (now < shakeGobbleUntil) return false;

  const axis = AXIS_OF[gesture];
  if (!axis) return true;

  const last = axisCooldown[axis];
  if (last && OPPOSITE[last.dir] === gesture && now - last.time < RETURN_COOLDOWN_MS) {
    return false;
  }

  axisCooldown[axis] = { dir: gesture, time: now };
  return true;
}

export function resetGestureFilter(): void {
  for (const key in axisCooldown) delete axisCooldown[key];
  shakeGobbleUntil = 0;
}
