import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S23 — Baseline Clear + Immediate Reconnect
 *
 * Flow: idle → calibrating → wait_awake → ready → browsing → idle → calibrating → wait_awake
 *
 * First connect with no baseline: full calibration cycle.
 * Disconnect, then reconnect with cleared store: second calibration cycle.
 * Verifies the machine can handle consecutive calibrations.
 */
export const scenario: Scenario = {
  id: "S23",
  name: "Baseline Clear Reconnect",
  kind: "disc",
  params: { baselinePitch: 50 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;
    const inputs = ctx.hot("--C--L--a--b--------p 1s -q---D--C--l--x--y", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 2 },
      L: { t: "baseline_load", baseline: null, ts: 5 },
      a: { t: "pose", roll: 0, pitch, yaw: 0, ts: 8 },
      b: { t: "motion", state: "stable", ts: 11 },
      p: { t: "pose", roll: 0, pitch, yaw: 0, ts: 20 },
      q: { t: "pose", roll: 0, pitch, yaw: 0, ts: 1024 },
      D: { t: "disconnect", ts: 1028 },
      l: { t: "baseline_load", baseline: null, ts: 1034 },
      x: { t: "pose", roll: 0, pitch, yaw: 0, ts: 1037 },
      y: { t: "motion", state: "stable", ts: 1040 },
    });
    inputs.subscribe(machine.inputs$);

    // browsing at 1022, idle at 1026, calibrating at 1032, wait_awake at 1038
    const afterReady = "-".repeat(1001) + "b---i-----c-----w";
    const marble = "--i--c-----w--------r" + afterReady;
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
