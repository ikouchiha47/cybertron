import { skip, distinctUntilChanged, map } from "rxjs/operators";
import type { Scenario } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { InputEvent, Baseline, DiscSnapshot } from "../../../src/core/events";

/**
 * S14 — Reconnect after settings clear.
 * User clears baseline in settings while still connected.
 * Machine continues normally. Only on disconnect → reconnect does it see
 * the cleared baseline and enter calibration.
 */
export const scenario: Scenario = {
  id: "S14",
  name: "Reconnect after settings clear",
  kind: "disc",
  params: { baselinePitch: 50 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const pitch = ctx.params.baselinePitch;

    const cachedBase: Baseline = {
      roll: 0, pitch, yaw: 0, timestamp: 0, wristName: "WT", wristAddress: "AA:BB",
    };

    ctx.sendEvents([
      // Phase 1: Connect with cached baseline → browse
      { ts: 0,   ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 2,   ev: ctx.events.baselineLoad(cachedBase) },
      { ts: 4,   ev: ctx.events.pose(0, pitch + 10, 0) },
      // Timer fires browsing at 1004 (1004-4=1000≥1000)
      { ts: 1004, ev: ctx.events.pose(0, pitch + 10, 0) },
      { ts: 1006, ev: ctx.events.disconnect() },

      // Phase 2: Reconnect with cleared (null) baseline → calibration
      { ts: 1008, ev: ctx.events.connect("AA:BB", "WT") },
      { ts: 1010, ev: ctx.events.baselineLoad(null) },       // null → calibrating
      { ts: 1012, ev: ctx.events.pose(0, pitch, 0) },
      { ts: 1014, ev: ctx.events.motion("stable") },         // completes cal → wait_awake
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
        { ts: 1006, value: "idle" },
        { ts: 1010, value: "calibrating" },
        { ts: 1014, value: "wait_awake" },
      ],
    );
  },
};
