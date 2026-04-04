"""
Preprocess raw session JSON files into unified [T x 6] feature arrays.

Each sample has either {kind:"imu", roll, pitch, yaw} or {kind:"gyro", x, y, z}.
This script interpolates both streams onto a common 20ms grid and outputs
a single array per session: [roll, pitch, yaw, gx, gy, gz] at each timestep.

Output: captures/<label>/<id>.npy  (shape [T, 6], float32)
Also writes a manifest.json listing all processed sessions.

Usage:
    uv run python -m wristturn.collector.preprocess --dir v3
    uv run python -m wristturn.collector.preprocess --dir v3 --grid-ms 20
"""

import argparse
import json
import numpy as np
from pathlib import Path

CAPTURES_DIR = Path(__file__).parent / "captures"
GRID_MS      = 20   # interpolation step in ms


def interpolate(ts: list[float], vals: list[list[float]], grid: np.ndarray) -> np.ndarray:
    """Interpolate multi-channel signal onto grid. Returns [len(grid), channels]."""
    ts_arr = np.array(ts, dtype=float)
    out = np.zeros((len(grid), len(vals[0])), dtype=np.float32)
    for ch in range(len(vals[0])):
        ch_vals = np.array([v[ch] for v in vals], dtype=float)
        out[:, ch] = np.interp(grid, ts_arr, ch_vals)
    return out


def process_session(session: dict, grid_ms: int = GRID_MS) -> np.ndarray | None:
    """
    Returns float32 array of shape [T, 6] or None if insufficient data.
    Channels: roll, pitch, yaw, gx, gy, gz
    """
    samples = session.get("samples", [])

    imu  = [(s["t"], s["roll"],  s["pitch"], s["yaw"])
            for s in samples if s.get("kind") == "imu" or "roll" in s and s.get("kind") != "gyro"]
    gyro = [(s["t"], s["x"], s["y"], s["z"])
            for s in samples if s.get("kind") == "gyro"]

    if not imu or not gyro:
        return None

    imu_t,  imu_v  = [r[0] for r in imu],  [list(r[1:]) for r in imu]
    gyro_t, gyro_v = [r[0] for r in gyro], [list(r[1:]) for r in gyro]

    t_start = max(min(imu_t),  min(gyro_t))
    t_end   = min(max(imu_t),  max(gyro_t))

    if t_end - t_start < grid_ms * 2:
        return None

    grid = np.arange(t_start, t_end, grid_ms, dtype=float)

    imu_interp  = interpolate(imu_t,  imu_v,  grid)   # [T, 3]
    gyro_interp = interpolate(gyro_t, gyro_v, grid)   # [T, 3]

    return np.concatenate([imu_interp, gyro_interp], axis=1).astype(np.float32)


def run(rel_dir: str, grid_ms: int = GRID_MS):
    root = (CAPTURES_DIR / rel_dir).resolve()
    if not root.is_dir():
        print(f"[Error] not a directory: {root}")
        return

    manifest = []
    total = 0

    for label_dir in sorted(root.iterdir()):
        if not label_dir.is_dir():
            continue
        json_files = sorted(label_dir.glob("*.json"))
        if not json_files:
            continue

        for jf in json_files:
            session = json.loads(jf.read_text())
            arr = process_session(session, grid_ms)
            if arr is None:
                print(f"[Skip] {label_dir.name}/{jf.stem} — missing imu or gyro")
                continue

            out_path = jf.with_suffix(".npy")
            np.save(out_path, arr)
            manifest.append({
                "label": label_dir.name,
                "id":    session.get("id", jf.stem),
                "file":  str(out_path.relative_to(CAPTURES_DIR)),
                "shape": list(arr.shape),
            })
            total += 1
            print(f"[OK] {label_dir.name}/{jf.stem}  shape={arr.shape}")

    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. {total} sessions → {manifest_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir",     default="",  help="subdir under captures/ (e.g. v3)")
    ap.add_argument("--grid-ms", default=20,  type=int, help="interpolation step in ms")
    args = ap.parse_args()
    run(args.dir, args.grid_ms)
