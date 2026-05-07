/**
 * PoseSample — abstract input shape for position-domain gesture detection.
 *
 * This is the seam between the BLE/firmware boundary and the gesture-domain
 * code. HoldDetector and any future position-aware detector consumes
 * `PoseSample`; tests construct synthetic streams; the BLE adapter translates
 * `PKT.POSE_EXT` wire packets into `PoseSample` events at runtime.
 *
 * Keeping detectors decoupled from BLE means:
 *   - tests need no native module / device,
 *   - replay sessions can feed pre-recorded samples through the same path,
 *   - firmware schema changes touch the translator only, not the detectors.
 *
 * Per `wristturn-app/CLAUDE.md` target layout: this is part of `src/core/`,
 * which never imports React Native or BLE.
 */

export interface PoseDelta {
  roll:  number;
  pitch: number;
  yaw:   number;
}

export interface PoseSample {
  /** Pose delta from the active baseline, degrees per axis. */
  delta:      PoseDelta;
  /** Per-sample gyro magnitude in dps. Unsigned; range 0–6553 dps from wire. */
  gyroMagDps: number;
  /** Sample timestamp in ms (monotonic; caller's clock). */
  nowMs:      number;
}

/**
 * IPoseSensor — minimal source contract a detector subscribes to.
 *
 * Backed by `BLEServiceNative.onDelta` + `PKT.POSE_EXT` parser in production,
 * by a synthetic generator in tests, by a recorded session in replay mode.
 */
export interface IPoseSensor {
  onSample(cb: (s: PoseSample) => void): () => void;
}
