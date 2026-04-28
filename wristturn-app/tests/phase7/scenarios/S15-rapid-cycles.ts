import { skip, distinctUntilChanged, map } from "rxjs/operators";
import type { Scenario, RunContext } from "../harness";
import { DiscStateMachine } from "../../../src/core/DiscStateMachine";
import type { InputEvent, Baseline, DiscSnapshot } from "../../../src/core/events";

/**
 * S15 — Rapid connect/disconnect cycles.
 * N rapid connect/disconnect cycles. Each cycle is clean — no state leakage.
 * Final state after cycles equals single clean-connect state.
 */
export const scenario: Scenario = {
  id: "S15",
  name: "Rapid connect/disconnect",
  kind: "disc",
  params: { cycleCount: 3 },
  createMachine: (clock) => new DiscStateMachine({ clock }),
  run(ctx) {
    const machine = ctx.machine as DiscStateMachine;
    const N = ctx.params.cycleCount;
    const pitch = 50;
    const cachedBase: Baseline = {
      roll: 0, pitch, yaw: 0, timestamp: 0, wristName: "WT", wristAddress: "AA:BB",
    };

    // Build event sequence: N cycles of connect→baseline→pose→disconnect
    // Then final connect→baseline→pose→browse-trigger
    const evts: Array<{ ts: number; ev: InputEvent }> = [];
    for (let i = 0; i < N; i++) {
      const base = i * 4;
      evts.push({ ts: base,     ev: ctx.events.connect("AA:BB", "WT") });
      evts.push({ ts: base + 1, ev: ctx.events.baselineLoad(cachedBase) });
      evts.push({ ts: base + 2, ev: ctx.events.pose(0, pitch + 10, 0) });
      evts.push({ ts: base + 3, ev: ctx.events.disconnect() });
    }
    // Final connect → browse
    const fb = N * 4;
    evts.push({ ts: fb,       ev: ctx.events.connect("AA:BB", "WT") });
    evts.push({ ts: fb + 1,   ev: ctx.events.baselineLoad(cachedBase) });
    evts.push({ ts: fb + 2,   ev: ctx.events.pose(0, pitch + 10, 0) });
    evts.push({ ts: fb + 1002, ev: ctx.events.pose(0, pitch + 10, 0) }); // timer fires (1002-14=988... hmm)

    // Actually, let me compute: final pose above is at fb+2=14. Timer needs 1000ms.
    // So browsing fires at next event after ts >= 14+1000=1014.
    // Let's use ts=1014.
    evts[evts.length - 1] = { ts: 1014, ev: ctx.events.pose(0, pitch + 10, 0) };

    ctx.sendEvents(evts);

    // After distinctUntilChanged(), consecutive same states collapse:
    // Each cycle: idle→wait_awake→ready→idle
    // Connect after disconnect emits same "idle" → filtered
    const expected = [
      { ts: 0,  value: "idle" },
      { ts: 1,  value: "wait_awake" },
      { ts: 2,  value: "ready" },
      { ts: 3,  value: "idle" },
      { ts: 5,  value: "wait_awake" },
      { ts: 6,  value: "ready" },
      { ts: 7,  value: "idle" },
      { ts: 9,  value: "wait_awake" },
      { ts: 10, value: "ready" },
      { ts: 11, value: "idle" },
      { ts: 13, value: "wait_awake" },
      { ts: 14, value: "ready" },
      { ts: 1014, value: "browsing" },
    ];

    ctx.expectRecorded(
      machine.state$.pipe(
        skip(1),
        map((s: DiscSnapshot) => s.discState),
        distinctUntilChanged(),
      ),
      expected,
    );
  },
};
