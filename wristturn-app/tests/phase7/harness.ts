/**
 * TestHarness — RxJS recorded-transition tests for Phase 7 state machines.
 *
 * Old approach (marble strings) was brittle for long timers.
 * New approach: record actual emissions and compare to expected transition arrays.
 *
 * Usage:
 *   export const scenario: Scenario = {
 *     id: "S4",
 *     name: "Sleep While Browsing",
 *     kind: "disc",
 *     params: { baselinePitch: 50, sleepAfterMs: 30000 },
 *     createMachine: (clock) => new DiscStateMachine({ clock }),
 *     run(ctx) {
 *       const events = [
 *         { ts: 2,  ev: ctx.events.connect("AA:BB", "WT") },
 *         { ts: 5,  ev: ctx.events.baselineLoad(storedBaseline) },
 *         { ts: 14, ev: ctx.events.pose(0, 55, 0) },
 *         { ts: 1014, ev: ctx.events.pose(0, 55, 0) },
 *         { ts: 1016, ev: ctx.events.sleep() },
 *         { ts: 1018, ev: ctx.events.connect("AA:BB", "WT") },
 *         { ts: 1021, ev: ctx.events.baselineLoad(storedBaseline) },
 *         { ts: 1030, ev: ctx.events.pose(0, 55, 0) },
 *         { ts: 2030, ev: ctx.events.pose(0, 55, 0) },
 *       ];
 *       ctx.sendEvents(events);
 *
 *       ctx.expectRecorded(machine.state$.pipe(
 *         skip(1),
 *         map(s => (s as DiscSnapshot).discState),
 *         distinctUntilChanged()
 *       ), [
 *         { ts: 2,   value: "idle" },
 *         { ts: 5,   value: "wait_awake" },
 *         { ts: 14,  value: "ready" },
 *         { ts: 1014,value: "browsing" },
 *         { ts: 1016,value: "idle" },
 *         { ts: 1021,value: "wait_awake" },
 *         { ts: 1030,value: "ready" },
 *         { ts: 2030,value: "browsing" },
 *       ]);
 *     }
 *   };
 */

import { TestScheduler } from "rxjs/testing";
import { map } from "rxjs";
import type { Observable } from "rxjs";
import type { DiscStateMachine } from "../../src/core/DiscStateMachine";
import type { ActiveControlMachine } from "../../src/core/ActiveControlMachine";
import type { InputEvent, OutputEvent } from "../../src/core/events";

// ── Scenario interface ───────────────────────────────────────────────────
export type MachineKind = "disc" | "active" | "multi";

export interface Scenario {
  id: string;
  name: string;
  kind: MachineKind;
  params: Record<string, any>;
  createMachine(clock: () => number, params: Record<string, any>): DiscStateMachine | ActiveControlMachine;
  run(ctx: RunContext): void;
}

// ── Event builder helpers exposed to scenarios ───────────────────────────
export const events = {
  connect: (address: string, name: string, ts?: number): InputEvent =>
    ({ t: "connect", address, name, ts: ts ?? 0 }),
  disconnect: (ts?: number): InputEvent =>
    ({ t: "disconnect", ts: ts ?? 0 }),
  sleep: (ts?: number): InputEvent =>
    ({ t: "sleep", ts: ts ?? 0 }),
  pose: (roll: number, pitch: number, yaw: number, ts?: number): InputEvent =>
    ({ t: "pose", roll, pitch, yaw, ts: ts ?? 0 }),
  motion: (state: "uncalibrated" | "calibrating" | "stable" | "moving", ts?: number): InputEvent =>
    ({ t: "motion", state, ts: ts ?? 0 }),
  gesture: (name: string, ts?: number): InputEvent =>
    ({ t: "gesture", name, ts: ts ?? 0 }),
  baselineLoad: (baseline: any, ts?: number): InputEvent =>
    ({ t: "baseline_load", baseline, ts: ts ?? 0 }),
  userSkip: (ts?: number): InputEvent =>
    ({ t: "user_skip", ts: ts ?? 0 }),
  lockToggle: (locked: boolean, ts?: number): InputEvent =>
    ({ t: "lock_toggle", locked, ts: ts ?? 0 }),
  appState: (active: boolean, ts?: number): InputEvent =>
    ({ t: "app_state", active, ts: ts ?? 0 }),
  modeChange: (mode: "gesture" | "knob" | "symbol", ts?: number): InputEvent =>
    ({ t: "mode_change", mode, ts: ts ?? 0 }),
};

// ── RunContext — what the test gets inside scheduler.run ─────────────────
export interface RunContext {
  clock: () => number;
  hot: (marbles: string, values?: Record<string, InputEvent>) => Observable<InputEvent>;
  cold: (marbles: string, values?: Record<string, OutputEvent>) => Observable<OutputEvent>;
  expectObservable: <T>(actual: Observable<T>) => {
    toBe(expected: string, values?: Record<string, T>): void;
  };
  machine: DiscStateMachine | ActiveControlMachine;
  params: Record<string, any>;
  events: typeof events; // DSL helpers
  sendEvents(events: Array<{ ts: number; ev: InputEvent }>): void;
  expectRecorded<T>(actual: Observable<T>, expected: Array<{ ts: number; value: T }>, toleranceFrames?: number): void;
}

// ── Recorded emission captured during test ───────────────────────────────
interface Recorded<T> {
  frame: number;  // virtual frame from TestScheduler
  value: T;
}

// ── Helper: build marble string from event array ─────────────────────────
function buildMarble(evts: Array<{ ts: number; ev: InputEvent }>): { marble: string; values: Record<string, InputEvent> } {
  if (evts.length === 0) return { marble: "|", values: {} };
  const totalFrames = evts[evts.length - 1].ts + 1;
  // Exclude RxJS marble special chars: | # ^ ! ( ) - and space
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const values: Record<string, InputEvent> = {};
  const marbleChars: string[] = new Array(totalFrames).fill("-");
  let charIdx = 0;
  for (const { ts, ev } of evts) {
    if (ts >= totalFrames) throw new Error(`Event at frame ${ts} exceeds total ${totalFrames}`);
    const ch = chars[charIdx++ % chars.length];
    values[ch] = ev;
    marbleChars[ts] = ch;
  }
  return { marble: marbleChars.join("") + "|", values };
}

// ── Helper: build marble + values from expected transition array ─────────
function buildExpectedMarble<T>(expected: Array<{ ts: number; value: T }>): {
  marble: string;
  values: Record<string, T>;
} {
  if (expected.length === 0) return { marble: "|", values: {} };
  const totalFrames = expected[expected.length - 1].ts + 1;
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const values: Record<string, T> = {};
  const marbleChars: string[] = new Array(totalFrames).fill("-");
  let charIdx = 0;
  for (const { ts, value } of expected) {
    if (ts >= totalFrames) throw new Error(`Expected transition at frame ${ts} exceeds total ${totalFrames}`);
    const ch = chars[charIdx++];
    values[ch] = value;
    marbleChars[ts] = ch;
  }
  // No trailing "|" — state$ (BehaviorSubject) never completes.
  // Add one extra frame at the end so TestScheduler sees a valid marble.
  return { marble: marbleChars.join("") + "-", values };
}

// ── Single scenario runner ──────────────────────────────────────────────
export function runScenario(scenario: Scenario, paramOverrides: Record<string, any> = {}): void {
  const params = { ...scenario.params, ...paramOverrides };

  const scheduler = new TestScheduler((actual: any, expected: any) => {
    const act = JSON.stringify(actual, null, 2);
    const exp = JSON.stringify(expected, null, 2);
    if (act !== exp) {
      throw new Error(`Assertion failed\nExpected:\n${exp}\nActual:\n${act}`);
    }
  });

  scheduler.run(({ hot, cold, expectObservable }: { hot: any; cold: any; expectObservable: any }) => {
    const clock = () => scheduler.now();
    const machine = scenario.createMachine(clock, params);

    // Build RunContext with DSL helpers + sendEvents/expectRecorded
    const ctx: RunContext = {
      clock,
      hot: (m, v) => hot(m, v as any),
      cold: (m, v) => cold(m, v as any),
      expectObservable: expectObservable as any,
      machine,
      params,
      events,
      sendEvents(evs) {
        // Inject the frame position into each event's ts field so the machine's
        // checkTimers(ev.ts) receives the correct virtual time.
        const withTs = evs.map(({ ts, ev }) => ({ ts, ev: { ...ev, ts } as InputEvent }));
        const { marble, values } = buildMarble(withTs);
        const source = hot(marble, values);
        source.subscribe(machine.inputs$);
      },
        expectRecorded(observable, expected, toleranceFrames = 1) {
        // Empty expected = assert no emissions at all
        if (expected.length === 0) {
          let count = 0;
          observable.subscribe({
            next: () => { count++; },
            error: (err: any) => { throw err; },
          });
          scheduler.flush();
          if (count > 0) {
            throw new Error(`Expected no emissions, but got ${count}`);
          }
          return;
        }

        // Build marble string from expected transitions and use expectObservable.
        // BehaviorSubject never completes, so use "!" (unsubscription) at the end.
        // The marble must cover all frames, so add one dash after the last emission.
        const { marble, values } = buildExpectedMarble(expected);
        expectObservable(observable).toBe(marble, values);
      },
    };

    scenario.run(ctx);
  });
}

// ── Multi-scenario runner ───────────────────────────────────────────────
export function runScenarios(scenarios: Scenario[], paramOverrides: Record<string, any> = {}): {
  passed: number;
  failed: number;
  errors: Array<{ id: string; error: Error }>;
} {
  let passed = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: Error }> = [];

  for (const s of scenarios) {
    try {
      runScenario(s, paramOverrides);
      passed++;
    } catch (e: any) {
      failed++;
      errors.push({ id: s.id, error: e });
    }
  }
  return { passed, failed, errors };
}
