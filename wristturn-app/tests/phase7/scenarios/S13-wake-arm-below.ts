import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S13 — Wake With Arm Below Baseline
 *
 * Flow: idle → wait_awake (holds) → ready → browsing
 *
 * After connect with stored baseline, machine enters wait_awake.
 * Multiple pose events below baseline (pitch < stored - 5) keep it
 * in wait_awake. Only when arm rises above baseline does it transition
 * to ready, then auto-browse after 1s.
 */
export const scenario: Scenario = {
  id: "S13",
  name: "Wake With Arm Below Baseline",
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

    ctx.sendEvents([
      { ts: 2,  ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 5,  ev: ctx.events.baselineLoad(storedBaseline) },
      // Below-baseline poses: stay in wait_awake
      { ts: 8,  ev: ctx.events.pose(0, pitch - 10, 0) },
      { ts: 11, ev: ctx.events.pose(0, pitch - 8, 0) },
      { ts: 14, ev: ctx.events.pose(0, pitch - 6, 0) },
      // Above baseline → ready
      { ts: 20, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Timer fires browsing at 1024 (1024-20=1004≥1000)
      { ts: 1024, ev: ctx.events.pose(0, pitch + 5, 0) },
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged()
      ),
      [
        { ts: 2,   value: "idle" },
        { ts: 5,   value: "wait_awake" },
        { ts: 20,  value: "ready" },
        { ts: 1024, value: "browsing" },
      ]
    );
  },
};
