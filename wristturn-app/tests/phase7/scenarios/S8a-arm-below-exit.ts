import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S8a — Arm Below Baseline Exit (3s hold)
 *
 * Flow: idle → wait_awake → ready → browsing → ready
 *
 * In browsing, arm below baseline (pitch < stored - 5) for 3s triggers
 * exit back to ready. Verifies the BELOW_BASELINE_EXIT_MS timer.
 */
export const scenario: Scenario = {
  id: "S8a",
  name: "Arm Below Baseline Exit",
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

    // connect → baseline_load → pose above → timer fires browsing at next event
    // pose below (starts 3s timer) → pose below again at 4022 (3004ms later → exit)
    ctx.sendEvents([
      { ts: 2,    ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 5,    ev: ctx.events.baselineLoad(storedBaseline) },
      { ts: 14,   ev: ctx.events.pose(0, pitch + 5, 0) },
      // At 1018: timer check fires browsing (1018-14=1004≥1000), then pose below starts arm-below timer
      { ts: 1018, ev: ctx.events.pose(0, pitch - 10, 0) },
      // At 4022: arm-below timer check fires ready (4022-1018=3004≥3000)
      { ts: 4022, ev: ctx.events.pose(0, pitch - 10, 0) },
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
        { ts: 4022, value: "ready" },
      ]
    );
  },
};
