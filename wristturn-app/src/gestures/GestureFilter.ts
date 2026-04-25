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

export function filterGesture(gesture: string): boolean {
  const now  = Date.now();
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
}
