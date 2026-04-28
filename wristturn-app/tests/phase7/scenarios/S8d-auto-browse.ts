import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S8d — Auto-Browse After 1s in Ready
 *
 * Flow: idle → wait_awake → ready → browsing
 *
 * After entering ready, staying above baseline for 1s automatically
 * transitions to browsing without any gesture input.
 */
export const scenario: Scenario = {
  id: "S8d",
  name: "Auto-Browse After 1s",
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
      { ts: 2,    ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 5,    ev: ctx.events.baselineLoad(storedBaseline) },
      { ts: 14,   ev: ctx.events.pose(0, pitch + 5, 0) },
      // Timer fires browsing at 1018 (1018-14=1004≥1000)
      { ts: 1018, ev: ctx.events.pose(0, pitch + 5, 0) },
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged()
      ),
      [
        { ts: 2,    value: "idle" },
        { ts: 5,    value: "wait_awake" },
        { ts: 14,   value: "ready" },
        { ts: 1018, value: "browsing" },
      ]
    );
  },
};
