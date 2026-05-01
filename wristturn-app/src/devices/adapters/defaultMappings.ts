import type { ComboMap } from "../../types";

export const ANDROIDTV_DEFAULT_MAPPING: ComboMap = {
  // Gesture mode
  "turn_right":            "dpad_right",
  "turn_left":             "dpad_left",
  "pitch_up":              "dpad_up",
  "pitch_down":            "dpad_down",
  "yaw_left,yaw_left,yaw_left": "back",
  "tap":                   "dpad_center",
  "turn_right,turn_right": "ff",
  "turn_left,turn_left":   "rewind",
  "tap,tap":               "open_netflix",
  // tap,tap,tap is reserved for mode-cycling (not mapped to a command)
  // Knob mode
  "knob_tick+":            "volume_up",
  "knob_tick-":            "volume_down",
  // Symbol mode
  "symbol:arrow_right":    "media_next",
  "symbol:arrow_left":     "media_prev",
  "symbol:V":              "volume_up",
  "symbol:O":              "dpad_center",
  "symbol:Z":              "back",
};

export const MACDAEMON_DEFAULT_MAPPING: ComboMap = {
  // Gesture mode
  "turn_right":  "ctrl_right",
  "turn_left":   "ctrl_left",
  "pitch_up":    "volume_up",
  "pitch_down":  "volume_down",
  "tap":         "media_play",
  "tap,tap":     "media_next",
  // Knob mode
  "knob_tick+":  "volume_up",
  "knob_tick-":  "volume_down",
  // Symbol mode
  "symbol:M":    "media_next",
  "symbol:Z":    "ctrl_left",
  "symbol:arrow_right": "media_next",
  "symbol:arrow_left":  "media_prev",
};
