import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S2 — Daily Use (Baseline Already Stored)
 *
 * Flow: idle → wait_awake → ready → browsing
 *
 * Connect with stored baseline skips calibration entirely.
 * Machine goes straight to wait_awake, then ready on next pose above baseline.
 * NO start_calibration output.
 */
export const scenario: Scenario = {
  id: "S2",
  name: "Daily Use",
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

    const inputs = ctx.hot("--C--L--------p 1s -q", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 2 },
      L: { t: "baseline_load", baseline: storedBaseline, ts: 5 },
      p: { t: "pose", roll: 0, pitch: pitch + 5, yaw: 0, ts: 14 },
      q: { t: "pose", roll: 0, pitch: pitch + 5, yaw: 0, ts: 1018 },
    });
    inputs.subscribe(machine.inputs$);

    // browsing at frame 1016 = 1001 dashes after r at frame 14
    const marble = "--i--w--------r" + "-".repeat(1001) + "b";
    const state$ = machine.state$.pipe(
      skip(1),
      map((s: DiscSnapshot) => s.discState),
      distinctUntilChanged(),
    );
    ctx.expectObservable(state$).toBe(marble, {
      i: "idle",
      w: "wait_awake",
      r: "ready",
      b: "browsing",
    });
  },
};
