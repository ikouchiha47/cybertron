/**
 * DSL helpers for building marble test input events.
 *
 * Quick builder for common event types.
 * Scenarios call ctx.hot("C--p--m--|", { C, p, m }) with these.
 */

import type { InputEvent } from "../../src/core/events";

export const events = {
  connect: (address: string, name: string, ts: number = 0): InputEvent =>
    ({ t: "connect", address, name, ts }),

  disconnect: (ts: number = 0): InputEvent =>
    ({ t: "disconnect", ts }),

  sleep: (ts: number = 0): InputEvent =>
    ({ t: "sleep", ts }),

  pose: (roll: number, pitch: number, yaw: number, ts: number = 0): InputEvent =>
    ({ t: "pose", roll, pitch, yaw, ts }),

  motion: (state: "uncalibrated" | "calibrating" | "stable" | "moving", ts: number = 0): InputEvent =>
    ({ t: "motion", state, ts }),

  gesture: (name: string, ts: number = 0): InputEvent =>
    ({ t: "gesture", name, ts }),

  baselineLoad: (baseline: any, ts: number = 0): InputEvent =>
    ({ t: "baseline_load", baseline, ts }),

  userSkip: (ts: number = 0): InputEvent =>
    ({ t: "user_skip", ts }),

  lockToggle: (locked: boolean, ts: number = 0): InputEvent =>
    ({ t: "lock_toggle", locked, ts }),

  appState: (active: boolean, ts: number = 0): InputEvent =>
    ({ t: "app_state", active, ts }),

  modeChange: (mode: "gesture" | "knob" | "symbol", ts: number = 0): InputEvent =>
    ({ t: "mode_change", mode, ts }),
};
