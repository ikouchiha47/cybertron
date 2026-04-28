import { skip, distinctUntilChanged, map } from "rxjs/operators";
import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot } from "../../../src/core/events";

/**
 * S12 — Calibration interruption.
 * Device connects → starts calibrating → user disconnects before stable →
 * machine resets. On reconnect, calibration restarts fresh.
 */
export const scenario: Scenario = {
  id: "S12",
  name: "Calibration interruption",
  kind: "disc",
  params: { baselinePitch: 50 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;

    ctx.sendEvents([
      { ts: 0,  ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 2,  ev: ctx.events.baselineLoad(null) },     // null → calibrating
      { ts: 4,  ev: ctx.events.pose(0, 50, 0) },
      { ts: 6,  ev: ctx.events.disconnect() },            // resets to idle
      { ts: 8,  ev: ctx.events.connect("AA:BB", "WT") },  // reconnect
      { ts: 10, ev: ctx.events.baselineLoad(null) },      // null → calibrating again
      { ts: 12, ev: ctx.events.pose(0, 50, 0) },          // caches pose
      { ts: 14, ev: ctx.events.motion("stable") },        // completes cal → wait_awake
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0,  value: "idle" },
        { ts: 2,  value: "calibrating" },
        { ts: 6,  value: "idle" },
        { ts: 10, value: "calibrating" },
        { ts: 14, value: "wait_awake" },
      ],
    );
  },
};
