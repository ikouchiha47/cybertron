const OPPOSITE: Record<string, string> = {
  turn_right: "turn_left",  turn_left: "turn_right",
  pitch_up:   "pitch_down", pitch_down: "pitch_up",
  yaw_right:  "yaw_left",   yaw_left:  "yaw_right",
};

// Keys that are synthetic (not gesture sequences) — skip opposite-direction check
const SYNTHETIC_PREFIXES = ["knob_tick", "symbol:"];

function isSyntheticKey(key: string): boolean {
  return SYNTHETIC_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Returns an error string if the combo contains consecutive opposite-direction
 * gestures on the same axis (always blocked by refractory period).
 * Skips validation for synthetic knob/symbol keys.
 */
export function validateCombo(combo: string): string | null {
  if (isSyntheticKey(combo)) return null;
  const parts = combo.split(",").map((g) => g.trim());
  for (let i = 0; i < parts.length - 1; i++) {
    if (OPPOSITE[parts[i]] === parts[i + 1]) {
      return (
        `"${combo}": position ${i + 1} ("${parts[i]}") and ${i + 2} ("${parts[i + 1]}") ` +
        `are opposite-direction gestures — refractory period will always block this combo`
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
