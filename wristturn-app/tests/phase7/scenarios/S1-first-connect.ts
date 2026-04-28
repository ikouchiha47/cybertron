import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S1 — First-Time Setup (No Baseline Stored)
 *
 * Flow: idle → calibrating → wait_awake → ready → browsing
 *
 * Connect with no stored baseline triggers calibration.
 * After calibration completes (pose + motion:stable), machine enters wait_awake.
 * Pose above baseline transitions to ready, then 1s later to browsing.
 */
export const scenario: Scenario = {
  id: "S1",
  name: "First-Time Setup",
  kind: "disc",
  params: { baselinePitch: 50 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;
    const inputs = ctx.hot("--C--L--a--b--------c 1s -d", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 2 },
      L: { t: "baseline_load", baseline: null, ts: 5 },
      a: { t: "pose", roll: 0, pitch, yaw: 0, ts: 8 },
      b: { t: "motion", state: "stable", ts: 11 },
      c: { t: "pose", roll: 0, pitch, yaw: 0, ts: 20 },
      d: { t: "pose", roll: 0, pitch, yaw: 0, ts: 1024 },
    });
    inputs.subscribe(machine.inputs$);

    // browsing at frame 1022 = 1001 dashes after r at frame 20
    const marble = "--i--c-----w--------r" + "-".repeat(1001) + "b";
    const state$ = machine.state$.pipe(
      skip(1),
      map((s: DiscSnapshot) => s.discState),
      distinctUntilChanged(),
    );
    ctx.expectObservable(state$).toBe(marble, {
      i: "idle",
      c: "calibrating",
      w: "wait_awake",
      r: "ready",
      b: "browsing",
    });
  },
};
