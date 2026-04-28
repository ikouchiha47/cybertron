import { skip, distinctUntilChanged, map } from "rxjs/operators";
import type { Scenario, RunContext } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { InputEvent, Baseline, DiscSnapshot } from "../../../src/core/events";

/**
 * S22 — App kill & restart mid-session.
 * Machine 1: connects, calibrates, completes, browses.
 * Machine 1 is destroyed (app killed).
 * Machine 2: constructed fresh, connects, BaselineStore.load returns cached baseline,
 * so machine skips calibration and goes straight to wait_awake.
 *
 * This test verifies Machine 2 behavior: with persistent baseline, it skips calibration.
 */
export const scenario: Scenario = {
  id: "S22",
  name: "App kill and restart",
  kind: "disc",
  params: { baselinePitch: 50 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;
    const cachedBase: Baseline = {
      roll: 0, pitch, yaw: 0, timestamp: 0, wristName: "WT", wristAddress: "AA:BB",
    };

    // Simulate app restart: Machine 2 starts fresh, BaselineStore has cached baseline
    ctx.sendEvents([
      { ts: 0,    ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 2,    ev: ctx.events.baselineLoad(cachedBase) },
      { ts: 4,    ev: ctx.events.pose(0, pitch + 10, 0) },
      // Browse trigger after 1s (1004-4=1000≥1000)
      { ts: 1004, ev: ctx.events.pose(0, pitch + 10, 0) },
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0,    value: "idle" },
        { ts: 2,    value: "wait_awake" },
        { ts: 4,    value: "ready" },
        { ts: 1004, value: "browsing" },
      ],
    );
  },
};
