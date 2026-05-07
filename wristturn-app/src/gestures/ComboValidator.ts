const OPPOSITE: Record<string, string> = {
  turn_right: "turn_left",  turn_left: "turn_right",
  pitch_up:   "pitch_down", pitch_down: "pitch_up",
  yaw_right:  "yaw_left",   yaw_left:  "yaw_right",
};

// Motion-axis tokens that HoldDetector will own via auto-repeat. Same-token
// adjacency on these collides with auto-repeat, so reject at registration.
// `tap` and `shake` are deliberately exempt — HoldDetector never emits them.
const MOTION_AXIS_TOKENS = new Set([
  "turn_right", "turn_left",
  "pitch_up",   "pitch_down",
  "yaw_right",  "yaw_left",
]);

// Keys that are synthetic (not gesture sequences) — skip all combo checks
const SYNTHETIC_PREFIXES = ["symbol:", "hold:"];

function isSyntheticKey(key: string): boolean {
  return SYNTHETIC_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Returns an error string if the combo contains:
 *   - consecutive opposite-direction gestures on the same axis (refractory blocks),
 *   - or consecutive same motion-axis tokens (auto-repeat / Hold owns this).
 * Skips validation for synthetic knob/symbol/hold keys.
 */
export function validateCombo(combo: string): string | null {
  if (isSyntheticKey(combo)) return null;
  const parts = combo.split(",").map((g) => g.trim());
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i];
    const b = parts[i + 1];
    if (OPPOSITE[a] === b) {
      return (
        `"${combo}": position ${i + 1} ("${a}") and ${i + 2} ("${b}") ` +
        `are opposite-direction gestures — refractory period will always block this combo`
      );
    }
    if (a === b && MOTION_AXIS_TOKENS.has(a)) {
      return (
        `"${combo}": position ${i + 1} and ${i + 2} repeat "${a}" — ` +
        `auto-repeat (Hold) will own this. Use a hold instead.`
      );
    }
  }
  return null;
}

export function validateComboMap(map: Record<string, unknown>): string[] {
  return Object.keys(map).flatMap((combo) => {
    const err = validateCombo(combo);
    return err ? [err] : [];
  });
}
