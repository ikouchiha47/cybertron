import type { Scenario } from "../harness";
import { ActiveControlMachine } from "../../../src/core/ActiveControlMachine";
import type { ACSnapshot, Baseline, InputEvent, OutputEvent } from "../../../src/core/events";
import { distinctUntilChanged, map } from "rxjs/operators";

/**
 * snap-back — Timer Cancellation
 *
 * ActiveControlMachine in gesture mode with homeBaseline should:
 * - t=1000: pose pitch=25 (below threshold 30) → armBelowTimerActive=true
 * - t=15000: pose pitch=55 (above threshold) → armBelowTimerActive=false (timer cancelled)
 * - t=35000: no navigate_back should have occurred
 * - No navigate_back output at all
 */
export const scenario: Scenario = {
  id: "snap-back",
  name: "Timer Cancellation on Snap Back",
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

    ctx.sendEvents([
      { ts: 1000,  ev: ctx.events.pose(0, 25, 0) },   // below threshold → armBelowTimerActive=true
      { ts: 15000, ev: ctx.events.pose(0, 55, 0) },   // above → cancels timer, armBelowTimerActive=false
      { ts: 35000, ev: ctx.events.pose(0, 25, 0) },   // below again → armBelowTimerActive=true
    ]);

    // State stays "active" throughout — no navigate_back fired
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.acState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0, value: "active" },
      ],
    );

    // armBelowTimerActive: false(initial) → true(1000) → false(15000) → true(35000)
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.armBelowTimerActive),
        distinctUntilChanged(),
      ),
      [
        { ts: 0,     value: false },
        { ts: 1000,  value: true },
        { ts: 15000, value: false },
        { ts: 35000, value: true },
      ],
    );

    // No navigate_back output — timer was cancelled before timeout
    ctx.expectRecorded(
      machine.outputs$.pipe(
        map((o: OutputEvent) => o.t),
      ),
      [],
    );
  },
};
