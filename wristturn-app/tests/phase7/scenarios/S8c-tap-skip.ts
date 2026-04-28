import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S8c — Tap Skips 1s Wait in Ready
 *
 * Flow: idle → wait_awake → ready → browsing
 *
 * In ready state, a tap gesture immediately transitions to browsing
 * without waiting for the 1s auto-browse timer.
 */
export const scenario: Scenario = {
  id: "S8c",
  name: "Tap Skips Auto-Browse Wait",
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
      { ts: 14, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Tap gesture in ready → browsing immediately (before 1s timer)
      { ts: 18, ev: ctx.events.gesture("tap") },
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged()
      ),
      [
        { ts: 2,  value: "idle" },
        { ts: 5,  value: "wait_awake" },
        { ts: 14, value: "ready" },
        { ts: 18, value: "browsing" },
      ]
    );
  },
};
