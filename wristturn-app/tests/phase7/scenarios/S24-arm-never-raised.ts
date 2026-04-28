import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S24 — Arm Never Raised After Connect
 *
 * Flow: idle → wait_awake (long hold) → idle
 *
 * After connect with stored baseline, machine enters wait_awake.
 * Arm stays below baseline for entire 5-minute session. No auto-browse
 * occurs. A sleep event eventually returns to idle.
 */
export const scenario: Scenario = {
  id: "S24",
  name: "Arm Never Raised After Connect",
  kind: "disc",
  params: { baselinePitch: 50, sleepAfterMs: 300_000 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;
    const sleepAfter = ctx.params.sleepAfterMs;
    const storedBaseline: Baseline = {
      roll: 0,
      pitch,
      yaw: 0,
      timestamp: 0,
      wristName: "WT",
      wristAddress: "AA:BB",
    };

    const belowPoseTs = 14;
    const sleepTs = belowPoseTs + sleepAfter; // 300014

    ctx.sendEvents([
      { ts: 2,       ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 5,       ev: ctx.events.baselineLoad(storedBaseline) },
      { ts: belowPoseTs, ev: ctx.events.pose(0, pitch - 10, 0) }, // below, stays wait_awake
      { ts: sleepTs, ev: ctx.events.sleep() },                     // sleep → idle
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged()
      ),
      [
        { ts: 2,       value: "idle" },
        { ts: 5,       value: "wait_awake" },
        { ts: sleepTs, value: "idle" },
      ]
    );
  },
};
