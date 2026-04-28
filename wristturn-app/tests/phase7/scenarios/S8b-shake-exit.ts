import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S8b — Shake Exit From Browsing
 *
 * Flow: idle → wait_awake → ready → browsing → ready
 *
 * In browsing, a shake gesture immediately exits back to ready.
 * No timer hold required — instant transition.
 */
export const scenario: Scenario = {
  id: "S8b",
  name: "Shake Exit From Browsing",
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
      // At 1018: timer fires browsing (1018-14=1004≥1000)
      { ts: 1018, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Shake gesture exits browsing → ready
      { ts: 1024, ev: ctx.events.gesture("shake") },
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
        { ts: 1024, value: "ready" },
      ]
    );
  },
};
