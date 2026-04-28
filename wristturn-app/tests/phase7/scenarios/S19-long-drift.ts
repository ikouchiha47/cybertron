import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { DiscSnapshot, Baseline } from "../../../src/core/events";
import { skip, distinctUntilChanged, map } from "rxjs/operators";

/**
 * S19 — Long Drift Session
 *
 * Flow: idle → wait_awake → ready → browsing (hold for 10 min)
 *
 * Simulates a 10-minute virtual browsing session with periodic pose
 * updates. State must stay browsing throughout with no spurious state_change.
 * Uses 3 representative poses instead of 30,000.
 */
export const scenario: Scenario = {
  id: "S19",
  name: "Long Drift Session",
  kind: "disc",
  params: { baselinePitch: 50, sessionDurationMs: 600_000 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;
    const duration = ctx.params.sessionDurationMs;
    const storedBaseline: Baseline = {
      roll: 0,
      pitch,
      yaw: 0,
      timestamp: 0,
      wristName: "WT",
      wristAddress: "AA:BB",
    };

    // 3 representative poses: start, middle, end of session
    ctx.sendEvents([
      { ts: 2,    ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 5,    ev: ctx.events.baselineLoad(storedBaseline) },
      { ts: 14,   ev: ctx.events.pose(0, pitch + 5, 0) },
      // Timer fires browsing at 1018 (1018-14=1004≥1000)
      { ts: 1018, ev: ctx.events.pose(0, pitch + 5, 0) },
      // Mid-session pose
      { ts: Math.floor(duration / 2), ev: ctx.events.pose(0, pitch + 5, 0) },
      // End-of-session pose
      { ts: duration - 100, ev: ctx.events.pose(0, pitch + 5, 0) },
    ]);

    // After distinctUntilChanged(), only state transitions are recorded.
    // All poses keep state at "browsing" — no further emissions.
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
