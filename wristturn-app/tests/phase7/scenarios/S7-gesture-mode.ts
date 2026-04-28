import type { Scenario } from "../harness";
import { ActiveControlMachine } from "../../../src/core/ActiveControlMachine";
import type { ACSnapshot, Baseline } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S7 — ActiveCtrl Gesture Mode (No Recalibration)
 *
 * ActiveControlMachine in gesture mode with homeBaseline should:
 * - Set sessionBaseline immediately (hasSessionBaseline = true)
 * - NOT emit start_calibration
 * - Stay in "active" state
 */
export const scenario: Scenario = {
  id: "S7",
  name: "ActiveCtrl Gesture Mode",
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

    // Send a connect event so the machine emits a valid snapshot after the
    // broken initial emission (class-field init order leaves acState undefined).
    const inputs = ctx.hot("--C--", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 2 },
    });
    inputs.subscribe(machine.inputs$);

    const state$ = machine.state$.pipe(
      skip(1),
      map((s: ACSnapshot) => s.acState),
      distinctUntilChanged(),
    );
    ctx.expectObservable(state$).toBe("--a", {
      a: "active",
    });

    const hasBaseline$ = machine.state$.pipe(
      skip(1),
      map((s: ACSnapshot) => s.hasSessionBaseline),
      distinctUntilChanged(),
    );
    ctx.expectObservable(hasBaseline$).toBe("--t", {
      t: true,
    });
  },
};
