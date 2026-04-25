/**
 * Preset symbol templates for $P recognizer.
 * Points represent (x=roll, y=pitch, z=yaw) Euler trajectories in degrees,
 * sampled at ~50Hz during a reference air-drawing.
 *
 * These are synthetic reference shapes. Real recordings should replace these
 * during hardware testing — use SessionRecorder to capture and refine.
 *
 * Each symbol has 2 variants registered to improve recognition across users.
 */

import type { Point3D } from "./PointCloudRecognizer";

function line(x0: number, y0: number, x1: number, y1: number, n = 16): Point3D[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x0 + (x1 - x0) * (i / (n - 1)),
    y: y0 + (y1 - y0) * (i / (n - 1)),
    z: 0,
  }));
}

function arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number, n = 24): Point3D[] {
  const start = (startDeg * Math.PI) / 180;
  const end   = (endDeg   * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    const a = start + (end - start) * (i / (n - 1));
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: 0 };
  });
}

// ── Symbol definitions ───────────────────────────────────────────────────────

// M: zigzag, drawn left to right — down-up-down-up
const M_v1: Point3D[] = [
  ...line(-30, 0, -15, -20), // left stem down
  ...line(-15, -20, 0, 0),   // up to center
  ...line(0, 0, 15, -20),    // down to right valley
  ...line(15, -20, 30, 0),   // right stem up
];

// M: single continuous zigzag, slightly different rhythm
const M_v2: Point3D[] = [
  ...line(-25, 5, -10, -25),
  ...line(-10, -25, 5, 5),
  ...line(5, 5, 20, -25),
  ...line(20, -25, 35, 5),
];

// Z: top horizontal, diagonal, bottom horizontal
const Z_v1: Point3D[] = [
  ...line(-20, 20, 20, 20),  // top bar left→right
  ...line(20, 20, -20, -20), // diagonal right→left
  ...line(-20, -20, 20, -20),// bottom bar left→right
];

const Z_v2: Point3D[] = [
  ...line(-25, 25, 25, 25),
  ...line(25, 25, -25, -25),
  ...line(-25, -25, 25, -25),
];

// O: circle clockwise
const O_v1: Point3D[] = arc(0, 0, 20, 0, 360, 32);
const O_v2: Point3D[] = arc(0, 0, 15, 90, 450, 32);  // start from top

// V: two lines meeting at bottom
const V_v1: Point3D[] = [
  ...line(-20, 20, 0, -20),  // left arm down
  ...line(0, -20, 20, 20),   // right arm up
];

const V_v2: Point3D[] = [
  ...line(-25, 25, 0, -25),
  ...line(0, -25, 25, 25),
];

// L: vertical down + horizontal right
const L_v1: Point3D[] = [
  ...line(0, 20, 0, -20),   // vertical down
  ...line(0, -20, 20, -20), // horizontal right
];

const L_v2: Point3D[] = [
  ...line(-5, 25, -5, -20),
  ...line(-5, -20, 20, -20),
];

// C: left-facing arc
const C_v1: Point3D[] = arc(0, 0, 20, 45, 315, 24);
const C_v2: Point3D[] = arc(0, 0, 18, 30, 330, 24);

// Arrow left: horizontal right-to-left + arrowhead
const ARROW_LEFT_v1: Point3D[] = [
  ...line(20, 0, -20, 0),    // shaft
  ...line(-20, 0, -8, 10),   // top barb
  ...line(-20, 0, -8, -10),  // bottom barb
];

const ARROW_LEFT_v2: Point3D[] = [
  ...line(25, 0, -25, 0),
  ...line(-25, 0, -12, 12),
  ...line(-25, 0, -12, -12),
];

// Arrow right
const ARROW_RIGHT_v1: Point3D[] = [
  ...line(-20, 0, 20, 0),
  ...line(20, 0, 8, 10),
  ...line(20, 0, 8, -10),
];

const ARROW_RIGHT_v2: Point3D[] = [
  ...line(-25, 0, 25, 0),
  ...line(25, 0, 12, 12),
  ...line(25, 0, 12, -12),
];

// ── Exports ──────────────────────────────────────────────────────────────────

export interface SymbolPreset {
  name: string;    // symbol id, e.g. "M"
  label: string;   // display name
  variants: Point3D[][];
}

export const PRESET_SYMBOLS: SymbolPreset[] = [
  { name: "M",           label: "M",           variants: [M_v1, M_v2] },
  { name: "Z",           label: "Z",           variants: [Z_v1, Z_v2] },
  { name: "O",           label: "O",           variants: [O_v1, O_v2] },
  { name: "V",           label: "V",           variants: [V_v1, V_v2] },
  { name: "L",           label: "L",           variants: [L_v1, L_v2] },
  { name: "C",           label: "C",           variants: [C_v1, C_v2] },
  { name: "arrow_left",  label: "← Arrow",     variants: [ARROW_LEFT_v1,  ARROW_LEFT_v2]  },
  { name: "arrow_right", label: "→ Arrow",     variants: [ARROW_RIGHT_v1, ARROW_RIGHT_v2] },
];
