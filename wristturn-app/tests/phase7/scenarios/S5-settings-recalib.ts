import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S5 — Settings Recalibrate
 *
 * Flow: idle → wait_awake → ready → idle → calibrating
 *
 * Connect with baseline, reach ready state.
 * Disconnect returns to idle.
 * Reconnect with cleared store (baseline_load: null) triggers recalibration.
 */
export const scenario: Scenario = {
  id: "S5",
  name: "Settings Recalibrate",
  kind: "disc",
  params: { baselinePitch: 50 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;
    const storedBaseline: Baseline = {
      roll: 0,
      pitch,
      yaw: 0,
      timestamp: 0,
      wristName: "WT",
      wristAddress: "AA:BB",
    };

    const inputs = ctx.hot("--C--L--------p-------D------C--l", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 2 },
      L: { t: "baseline_load", baseline: storedBaseline, ts: 5 },
      p: { t: "pose", roll: 0, pitch: pitch + 5, yaw: 0, ts: 14 },
      D: { t: "disconnect", ts: 22 },
      l: { t: "baseline_load", baseline: null, ts: 32 },
    });
    inputs.subscribe(machine.inputs$);

    // With distinctUntilChanged: idle at 29 is filtered (same as idle at 22)
    const marble = "--i--w--------r-------i---------c";
    const state$ = machine.state$.pipe(
      skip(1),
      map((s: DiscSnapshot) => s.discState),
      distinctUntilChanged(),
    );
    ctx.expectObservable(state$).toBe(marble, {
      i: "idle",
      w: "wait_awake",
      r: "ready",
      c: "calibrating",
    });
  },
};
