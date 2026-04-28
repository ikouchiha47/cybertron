import type { Scenario } from "../harness";
import { ActiveControlMachine } from "../../../src/core/ActiveControlMachine";
import type { ACSnapshot, Baseline, OutputEvent } from "../../../src/core/events";
import { distinctUntilChanged, map } from "rxjs/operators";

/**
 * S20 — Knob Mode Without Completion (abandon)
 *
 * ActiveControlMachine in knob mode without homeBaseline should:
 * - Start in "session_calibrating" state immediately
 * - Emit "start_calibration" output
 * - user_skip → back to "active" state (no baseline saved)
 * - No "save_baseline" or "send_baseline" outputs
 */
export const scenario: Scenario = {
  id: "S20",
  name: "Knob Mode Abandon Calibration",
  kind: "active",
  params: { initialMode: "knob" },
  createMachine: (clock, params) => {
    return new ActiveControlMachine({
      clock,
      homeBaseline: null,
      initialMode: params.initialMode as "gesture" | "knob" | "symbol",
    });
  },
  run(ctx) {
    const machine = ctx.machine as ActiveControlMachine;

    ctx.sendEvents([
      { ts: 1, ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 7, ev: ctx.events.userSkip() },
    ]);

    // Without skip(1): initial "session_calibrating" from constructor,
    // then "active" from user_skip. Intermediate publishes of same state
    // are filtered by distinctUntilChanged.
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.acState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0, value: "session_calibrating" },
        { ts: 7, value: "active" },
      ],
    );

    // hasSessionBaseline stays false throughout
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.hasSessionBaseline),
        distinctUntilChanged(),
      ),
      [
        { ts: 0, value: false },
      ],
    );
  },
};
