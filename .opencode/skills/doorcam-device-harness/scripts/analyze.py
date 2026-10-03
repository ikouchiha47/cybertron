#!/usr/bin/env python3
"""Analyze a DoorCam capture dir produced by capture.sh.

Detects the bounding-box overlay color per frame (teal = score>=threshold,
orange = below-threshold candidate), tracks its position, and correlates with
the engine's `person confirmed` / `person lost` log lines.

usage: analyze.py <capture_dir>
"""
import glob
import os
import re
import sys

try:
    from PIL import Image
except Exception:
    print("ERROR: Pillow (PIL) not installed. pip install pillow", file=sys.stderr)
    sys.exit(1)


# Overlay colors (see CameraTile.tsx): '#4a9' and '#fa0'.
def classify(r, g, b):
    if 30 <= r <= 120 and 130 <= g <= 210 and 110 <= b <= 200 and g > r + 40:
        return "teal"
    if 200 <= r <= 255 and 130 <= g <= 210 and 0 <= b <= 100:
        return "orange"
    return None


# Scan region as fractions of the screen (skip status bar + nav + header).
Y0, Y1 = 0.45, 0.95


def find_box(path):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    px = im.load()
    if px is None:
        return None
    best = None
    for color in ("teal", "orange"):
        minx, miny, maxx, maxy, cnt = W, H, 0, 0, 0
        for y in range(int(H * Y0), int(H * Y1), 2):
            for x in range(0, W, 2):
                pix = px[x, y]
                if not isinstance(pix, tuple) or len(pix) < 3:
                    continue
                r, g, b = int(pix[0]), int(pix[1]), int(pix[2])
                if classify(r, g, b) == color:
                    cnt += 1
                    if x < minx:
                        minx = x
                    if y < miny:
                        miny = y
                    if x > maxx:
                        maxx = x
                    if y > maxy:
                        maxy = y
        if cnt > 30:
            best = (color, (minx + maxx) // 2, (miny + maxy) // 2, maxx - minx, maxy - miny, cnt)
            if color == "teal":
                break  # prefer teal
    return best


def parse_log(path):
    events = []
    if not os.path.exists(path):
        return events
    for line in open(path, errors="ignore"):
        m = re.search(r"(\d\d:\d\d:\d\d)\.\d+.*\[engine\] (person confirmed|person lost)", line)
        if m:
            events.append((m.group(1), m.group(2)))
    return events


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cap = sys.argv[1]
    files = sorted(glob.glob(os.path.join(cap, "f*.png")))
    if not files:
        print(f"no frames in {cap}")
        sys.exit(1)

    import time as _t

    print(f"{'frame':6} {'t+':>7} {'box':>7} {'cx':>6} {'cy':>6} {'w':>5} {'h':>5}")
    t0 = os.path.getmtime(files[0])
    teal_frames = []
    for f in files:
        name = os.path.basename(f)[:-4]
        rel = os.path.getmtime(f) - t0
        b = find_box(f)
        if b and b[0] == "teal":
            teal_frames.append((rel, b[1], b[2]))
        if b:
            print(f"{name:6} {rel:7.2f} {b[0]:>7} {b[1]:>6} {b[2]:>6} {b[3]:>5} {b[4]:>5}")
        else:
            print(f"{name:6} {rel:7.2f} {'no':>7}")

    print("\n=== summary ===")
    if teal_frames:
        first, last = teal_frames[0][0], teal_frames[-1][0]
        xs = [c[1] for c in teal_frames]
        ys = [c[2] for c in teal_frames]
        travel = max(max(xs) - min(xs), max(ys) - min(ys))
        print(f"teal box: {len(teal_frames)} frames, t+{first:.2f}s .. t+{last:.2f}s "
              f"(lifetime {last-first:.2f}s), center travel {travel}px")
        print("  -> center travel < ~15px across many frames = FROZEN/stale overlay"
              if travel < 15 and len(teal_frames) >= 4 else
              "  -> box is moving (tracking)")
    else:
        print("no teal box detected in any frame")

    events = parse_log(os.path.join(cap, "logcat.txt"))
    if events:
        print("\n=== engine events ===")
        for t, e in events:
            print(f"  {t}  {e}")


if __name__ == "__main__":
    main()
