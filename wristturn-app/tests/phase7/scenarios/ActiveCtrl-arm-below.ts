import type { Scenario } from "../harness";
import { ActiveControlMachine } from "../../../src/core/ActiveControlMachine";
import type { ACSnapshot, Baseline, InputEvent, OutputEvent } from "../../../src/core/events";
import { distinctUntilChanged, map } from "rxjs/operators";

/**
 * ActiveCtrl-arm-below — 30s Timeout
 *
 * ActiveControlMachine in gesture mode with homeBaseline should:
 * - Start in "active" state with hasSessionBaseline=true
 * - When pitch < baseline - 20 for 30s → armBelowTimerActive=true
 * - After 30s with pitch still below → navigate_back
 * - State transitions to "exiting"
 */
export const scenario: Scenario = {
  id: "ActiveCtrl-arm-below",
  name: "Arm Below 30s Timeout",
  kind: "active",
  params: { homeBaselinePitch: 50, initialMode: "gesture" },
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
      initialMode: params.initialMode as "gesture" | "knob" | "symbol",
    });
  },
  run(ctx) {
    const machine = ctx.machine as ActiveControlMachine;
    const basePitch = ctx.params.homeBaselinePitch; // 50, threshold = 30
    const belowPitch = basePitch - 25; // 25, well below threshold

    ctx.sendEvents([
      { ts: 1000,  ev: ctx.events.pose(0, belowPitch, 0) },  // starts arm-below timer
      { ts: 31000, ev: ctx.events.pose(0, belowPitch, 0) },  // 30s later → navigate_back → exiting
    ]);

    // Initial "active" from constructor, then "exiting" at 31000
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.acState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0,    value: "active" },
        { ts: 31000, value: "exiting" },
      ],
    );

    // armBelowTimerActive: false(initial) → true(1000) → false(31000)
    ctx.expectRecorded(
      machine.state$.pipe(
        map((s: ACSnapshot) => s.armBelowTimerActive),
        distinctUntilChanged(),
      ),
      [
        { ts: 0,     value: false },
        { ts: 1000,  value: true },
        { ts: 31000, value: false },
      ],
    );

    // Outputs: navigate_back at ts=31000
    ctx.expectRecorded(
      machine.outputs$.pipe(
        map((o: OutputEvent) => o.t),
      ),
      [
        { ts: 31000, value: "navigate_back" },
      ],
    );
  },
};
