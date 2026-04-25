/**
 * $P Point Cloud recognizer — 3D variant.
 * Based on: Vatavu, Anthony, Wobbrock. "Gestures as Point Clouds" (ICMI 2012).
 *
 * Stroke-order and direction independent. Works with as few as 1 training sample.
 * Points are normalized to a unit bounding box before matching.
 */

export interface Point3D { x: number; y: number; z: number; }

export interface Template {
  name: string;
  points: Point3D[]; // already normalized
}

export interface RecognizeResult {
  name: string;
  score: number;  // 0–1, higher = better match
  matched: boolean;
}

const RESAMPLE_N = 32;
const SCORE_THRESHOLD = 0.65;

// ── Normalisation ─────────────────────────────────────────────────────────────

function resample(pts: Point3D[], n: number): Point3D[] {
  const totalLen = pathLength(pts);
  const interval = totalLen / (n - 1);
  let D = 0;
  const resampled: Point3D[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (D + d >= interval) {
      const t = (interval - D) / d;
      const p: Point3D = {
        x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
        z: pts[i - 1].z + t * (pts[i].z - pts[i - 1].z),
      };
      resampled.push(p);
      pts = [p, ...pts.slice(i)];
      i = 1;
      D = 0;
    } else {
      D += d;
    }
  }
  while (resampled.length < n) resampled.push(pts[pts.length - 1]);
  return resampled.slice(0, n);
}

function scaleToBoundingBox(pts: Point3D[]): Point3D[] {
  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  const maxY = Math.max(...pts.map(p => p.y));
  const minZ = Math.min(...pts.map(p => p.z));
  const maxZ = Math.max(...pts.map(p => p.z));
  const sx = maxX - minX || 1;
  const sy = maxY - minY || 1;
  const sz = maxZ - minZ || 1;
  return pts.map(p => ({
    x: (p.x - minX) / sx,
    y: (p.y - minY) / sy,
    z: (p.z - minZ) / sz,
  }));
}

function translateToCentroid(pts: Point3D[]): Point3D[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  return pts.map(p => ({ x: p.x - cx, y: p.y - cy, z: p.z - cz }));
}

export function normalize(pts: Point3D[]): Point3D[] {
  return translateToCentroid(scaleToBoundingBox(resample(pts, RESAMPLE_N)));
}

// ── Distance ──────────────────────────────────────────────────────────────────

function dist(a: Point3D, b: Point3D): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function pathLength(pts: Point3D[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}

/** Greedy nearest-neighbour cloud distance (stroke-order independent). */
function cloudDistance(pts: Point3D[], template: Point3D[]): number {
  const n = pts.length;
  const matched = new Uint8Array(n);
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < n; i++) {
      if (matched[i]) continue;
      const d = dist(p, template[i]);
      if (d < best) { best = d; bestIdx = i; }
    }
    matched[bestIdx] = 1;
    sum += best;
  }
  return sum / n;
}

// ── Recognizer ────────────────────────────────────────────────────────────────

export class PointCloudRecognizer {
  private templates: Template[] = [];

  addTemplate(name: string, rawPoints: Point3D[]): void {
    this.templates.push({ name, points: normalize(rawPoints) });
  }

  recognize(rawPoints: Point3D[]): RecognizeResult {
    if (this.templates.length === 0 || rawPoints.length < 4) {
      return { name: "unknown", score: 0, matched: false };
    }
    const candidate = normalize(rawPoints);
    let bestDist = Infinity;
    let bestName = "unknown";
    for (const t of this.templates) {
      const d = cloudDistance(candidate, t.points);
      if (d < bestDist) { bestDist = d; bestName = t.name; }
    }
    // Score: map distance to 0–1 (lower distance = higher score)
    // Empirical: distances typically in 0.1–0.6 range for good/bad matches
    const score = Math.max(0, 1 - bestDist / 0.5);
    return { name: bestName, score, matched: score >= SCORE_THRESHOLD };
  }

  hasTemplates(): boolean { return this.templates.length > 0; }
}
