import type { ComboMap } from "../../types";

// Defaults seeded on first device-connect. Same-axis repeats (e.g.
// `turn_right,turn_right`) are no longer valid combos — auto-repeat (Hold)
// owns same-axis repetition. Use `hold:<token>` for sustained-press actions.
// Knob_tick± vocabulary has been removed; volume actions go via flicks.

export const ANDROIDTV_DEFAULT_MAPPING: ComboMap = {
  "turn_right":            "dpad_right",
  "turn_left":              "dpad_left",
  "pitch_up":               "dpad_up",
  "pitch_down":             "dpad_down",
  "yaw_left,yaw_left,yaw_left": "back",
  "tap":                    "dpad_center",
  "hold:turn_right":        "ff",
  "hold:turn_left":         "rewind",
  "tap,tap":                "open_netflix",
  // Symbol mode (reachable via Settings toggle)
  "symbol:arrow_right":     "media_next",
  "symbol:arrow_left":      "media_prev",
  "symbol:V":               "volume_up",
  "symbol:O":               "dpad_center",
  "symbol:Z":               "back",
};

export const MACDAEMON_DEFAULT_MAPPING: ComboMap = {
  "turn_right":  "ctrl_right",
  "turn_left":   "ctrl_left",
  "pitch_up":    "volume_up",
  "pitch_down":  "volume_down",
  "tap":         "media_play",
  "tap,tap":     "media_next",
  "hold:pitch_up":   "volume_up",
  "hold:pitch_down": "volume_down",
  // Symbol mode
  "symbol:M":           "media_next",
  "symbol:Z":           "ctrl_left",
  "symbol:arrow_right": "media_next",
  "symbol:arrow_left":  "media_prev",
};
