import type { Scenario } from "../harness";
import { ActiveControlMachine } from "../../../src/core/ActiveControlMachine";
import type { ACSnapshot, Baseline, OutputEvent } from "../../../src/core/events";
import { map, skip, distinctUntilChanged } from "rxjs/operators";

/**
 * S6 — Knob Mode Session Calibration
 *
 * ActiveControlMachine in knob mode with homeBaseline should:
 * - Start in "session_calibrating" state immediately
 * - When pose + motion:stable arrive → complete calibration
 * - Transition to "active" state
 * - Emit "save_baseline" and "send_baseline" outputs
 */
export const scenario: Scenario = {
  id: "S6",
  name: "Knob Mode Session Calibration",
  kind: "active",
  params: { homeBaselinePitch: 50, initialMode: "knob" },
  createMachine: (clock, params) => {
    const homeBaseline: Baseline = {
      roll: 0,
      pitch: params.homeBaselinePitch,
      yaw: 0,
      timestamp: 0,
      wristName: "WT",
      wristAddress: "AA:BB",
    };
    return new ActiveControlMachine({
      clock,
      homeBaseline,
      initialMode: params.initialMode as "gesture" | "knob" | "symbol",
    });
  },
  run(ctx) {
    const machine = ctx.machine as ActiveControlMachine;

    // Marble: C at 0, p at 3, m at 7
    const inputs = ctx.hot("C--p---m", {
      C: { t: "connect", address: "AA:BB", name: "WT", ts: 0 },
      p: { t: "pose", roll: 0, pitch: 50, yaw: 0, ts: 3 },
      m: { t: "motion", state: "stable", ts: 7 },
    });
    inputs.subscribe(machine.inputs$);

    // State: session_calibrating (from constructor) → active at frame 7
    // The constructor calls startSessionCalibration() which publishes state
    // Then test subscribes and gets current state (session_calibrating) at frame 0
    // skip(1) should skip this, leaving only the frame 7 transition to active
    // But TestScheduler records all emissions including the one from subscription
    const state$ = machine.state$.pipe(
      map((s: ACSnapshot) => s.acState),
      distinctUntilChanged(),
    );
    // Expected: frame 0 = session_calibrating (from subscription to BehaviorSubject),
    // frame 7 = active (from motion:stable completing calibration)
    ctx.expectObservable(state$).toBe("s------a", {
      s: "session_calibrating",
      a: "active",
    });

    // hasSessionBaseline: false (initial) → true at frame 7
    const hasBaseline$ = machine.state$.pipe(
      map((s: ACSnapshot) => s.hasSessionBaseline),
      distinctUntilChanged(),
    );
    ctx.expectObservable(hasBaseline$).toBe("f------t", {
      f: false,
      t: true,
    });

    // Outputs: start_calibration (from constructor, before subscription, NOT captured),
    // save_baseline and send_baseline at frame 7
    const outputs$ = machine.outputs$.pipe(
      map((o: OutputEvent) => o.t),
    );
    ctx.expectObservable(outputs$).toBe("-------(bc)", {
      b: "save_baseline",
      c: "send_baseline",
    });
  },
};
