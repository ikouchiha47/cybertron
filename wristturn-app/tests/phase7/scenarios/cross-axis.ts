import type { Scenario } from "../harness";
import { ActiveControlMachine } from "../../../src/core/ActiveControlMachine";
import type { ACSnapshot, Baseline, InputEvent, OutputEvent } from "../../../src/core/events";
import { distinctUntilChanged, map } from "rxjs/operators";

/**
 * cross-axis — Contamination Check
 *
 * ActiveControlMachine in gesture mode with homeBaseline should:
 * - NOT trigger armBelowTimerActive when only roll changes
 * - pitch stays at baseline (50 >= 50-20=30)
 * - No navigate_back output
 */
export const scenario: Scenario = {
  id: "cross-axis",
  name: "Cross-Axis Contamination Check",
  kind: "active",
  params: { homeBaselinePitch: 50 },
  createMachine: (clock, params) => {
    const homeBaseline: Baseline = {
      roll: 0,
      pitch: params.homeBaselinePitch,
      yaw: 0,
      timestamp: 0,
      wristName: "WT",
      wristAddress: "AA:BB",
    };
    return new ActiveControlMachine({
      clock,
      homeBaseline,
      initialMode: "gesture",
    });
  },
  run(ctx) {
    const machine = ctx.machine as ActiveControlMachine;

    // 4 poses with roll varying but pitch at baseline (not below threshold)
    ctx.sendEvents([
      { ts: 1000, ev: ctx.events.pose(0, 50, 0) },
      { ts: 2000, ev: ctx.events.pose(90, 50, 0) },
      { ts: 3000, ev: ctx.events.pose(-90, 50, 0) },
      { ts: 4000, ev: ctx.events.pose(90, 50, 0) },
    ]);

    // State stays "active" — just the initial emission
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.acState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0, value: "active" },
      ],
    );

    // armBelowTimerActive stays false — just the initial emission
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.armBelowTimerActive),
        distinctUntilChanged(),
      ),
      [
        { ts: 0, value: false },
      ],
    );

    // No outputs at all
    ctx.expectRecorded(
      machine.outputs$.pipe(
        map((o: OutputEvent) => o.t),
      ),
      [],
    );
  },
};
