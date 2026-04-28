import type { Scenario, RunContext } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S4 — Sleep While Browsing
 *
 * Flow: idle → wait_awake → ready → browsing → idle(sleep) → wait_awake → ready → browsing
 *
 * Connect with stored baseline, raise arm to browse, sleep to idle,
 * reconnect and browse again. Verifies sleep disarms and resets cleanly.
 */
export const scenario: Scenario = {
  id: "S4",
  name: "Sleep While Browsing",
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

    // Input timeline (frame-accurate, no marble string)
    ctx.sendEvents([
      { ts: 2,  ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 5,  ev: ctx.events.baselineLoad(storedBaseline) },
      { ts: 14, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Held above baseline → browse after 1s (14+1000)
      { ts: 1014, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Sleep → idle
      { ts: 1016, ev: ctx.events.sleep() },
      // Reconnect
      { ts: 1018, ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 1021, ev: ctx.events.baselineLoad(storedBaseline) },
      { ts: 1030, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Second browse after 1s
      { ts: 2030, ev: ctx.events.pose(0, pitch + 5, 0) },
    ]);

    // Expected state transitions (after skip(1) and distinctUntilChanged)
    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged()
      ),
      [
        { ts: 2,   value: "idle" },
        { ts: 5,   value: "wait_awake" },
        { ts: 14,  value: "ready" },
        { ts: 1014,value: "browsing" },
        { ts: 1016,value: "idle" },
        { ts: 1021,value: "wait_awake" },
        { ts: 1030,value: "ready" },
        { ts: 2030,value: "browsing" },
      ]
    );
  },
};
