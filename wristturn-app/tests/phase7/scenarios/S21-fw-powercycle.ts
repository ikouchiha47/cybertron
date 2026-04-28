import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S21 — Firmware Power-Cycle + Restore
 *
 * Flow: idle → wait_awake → ready
 *
 * Simulates: firmware lost baseline (RAM cleared on power-cycle),
 * but app still has stored baseline. On reconnect, app sends stored
 * baseline to firmware via send_baseline output.
 */
export const scenario: Scenario = {
  id: "S21",
  name: "Firmware Power-Cycle Restore",
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

    const inputs = ctx.hot("--C--L--------p", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 2 },
      L: { t: "baseline_load", baseline: storedBaseline, ts: 5 },
      p: { t: "pose", roll: 0, pitch: pitch + 5, yaw: 0, ts: 14 },
    });
    inputs.subscribe(machine.inputs$);

    const marble = "--i--w--------r";
    const state$ = machine.state$.pipe(
      skip(1),
      map((s: DiscSnapshot) => s.discState),
      distinctUntilChanged(),
    );
    ctx.expectObservable(state$).toBe(marble, {
      i: "idle",
      w: "wait_awake",
      r: "ready",
    });
  },
};
