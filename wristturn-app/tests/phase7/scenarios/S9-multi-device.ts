import { skip, distinctUntilChanged, map } from "rxjs/operators";
import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { InputEvent, Baseline, DiscSnapshot } from "../../../src/core/events";

/**
 * S9 — Multiple wrist devices with independent baselines.
 * Device A first-time → calibrates → caches baseline.
 * Device B first-time → calibrates independently.
 * Device A reconnects → loads cached baseline → skips calibration.
 */
export const scenario: Scenario = {
  id: "S9",
  name: "Multiple wrist devices",
  kind: "disc",
  params: { pitchA: 50, pitchB: 60 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const { pitchA, pitchB } = ctx.params;

    const addrA = "AA:BB:CC:DD:EE:01";
    const addrB = "AA:BB:CC:DD:EE:02";
    const nameA = "Wrist A";
    const nameB = "Wrist B";

    const baseline = (pitch: number, addr: string, name: string): Baseline => ({
      roll: 0, pitch, yaw: 0, timestamp: 0, wristName: name, wristAddress: addr,
    });

    // Phase 1: Connect A (first-time, no baseline) → calibrate
    // Phase 2: Disconnect A, connect B (first-time) → calibrate
    // Phase 3: Disconnect B, reconnect A (cached baseline) → skip calibration
    ctx.sendEvents([
      // Device A: first-time calibration
      { ts: 0,  ev: ctx.events.connect(addrA, nameA) },
      { ts: 2,  ev: ctx.events.baselineLoad(null) },           // null → calibrating
      { ts: 4,  ev: ctx.events.pose(0, pitchA, 0) },
      { ts: 6,  ev: ctx.events.motion("stable") },             // completes cal → wait_awake
      { ts: 8,  ev: ctx.events.disconnect() },                  // back to idle

      // Device B: first-time calibration
      { ts: 10, ev: ctx.events.connect(addrB, nameB) },
      { ts: 12, ev: ctx.events.baselineLoad(null) },
      { ts: 14, ev: ctx.events.pose(0, pitchB, 0) },
      { ts: 16, ev: ctx.events.motion("stable") },             // completes cal → wait_awake
      { ts: 18, ev: ctx.events.disconnect() },                  // back to idle

      // Device A reconnects: cached baseline → no calibration
      { ts: 20, ev: ctx.events.connect(addrA, nameA) },
      { ts: 22, ev: ctx.events.baselineLoad(baseline(pitchA, addrA, nameA)) },
      { ts: 24, ev: ctx.events.pose(0, pitchA + 10, 0) },      // above baseline → ready
      // Timer fires browsing at 1024 (1024-24=1000≥1000)
      { ts: 1024, ev: ctx.events.pose(0, pitchA + 10, 0) },
    ]);

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged(),
      ),
      [
        { ts: 0,   value: "idle" },
        { ts: 2,   value: "calibrating" },
        { ts: 6,   value: "wait_awake" },
        { ts: 8,   value: "idle" },
        { ts: 12,  value: "calibrating" },
        { ts: 16,  value: "wait_awake" },
        { ts: 18,  value: "idle" },
        { ts: 22,  value: "wait_awake" },
        { ts: 24,  value: "ready" },
        { ts: 1024, value: "browsing" },
      ],
    );
  },
};
