"""
analyse_wake_cycle.py — sleep/wake cycle analysis for wristturn firmware logs.

Usage:
    python3 tools/analyse_wake_cycle.py tmp/logs.NN.txt

Output sections:
  1. Sleep/wake cycle table (sleep time, wake time, actual sleep duration)
  2. Drain event summary (what event IDs fire during MIN_SLEEP_MS window)
  3. Wake-cause breakdown (re-sleep ack vs real shake)
"""

import re
import sys
from collections import Counter
from datetime import datetime


def parse_ts(line):
    m = re.search(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]", line)
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S.%f") if m else None


if len(sys.argv) > 1:
    with open(sys.argv[1]) as f:
        lines = f.readlines()
else:
    lines = sys.stdin.readlines()

# ── 1. Sleep/wake cycles ──────────────────────────────────────────────────────
cycles = []
current = {}

for line in lines:
    ts = parse_ts(line)
    if not ts:
        continue
    if "inactivity timeout" in line:
        current = {"sleep_at": ts}
    elif "BNO085 SH-2 sleep" in line and current:
        current["sleeping_at"] = ts
        m = re.search(r"INT=(\d)", line)
        current["int_after_sleep"] = int(m.group(1)) if m else -1
    elif "waking" in line and "restoring" in line and current:
        current["wake_at"] = ts
        current["slept_for"] = (ts - current.get("sleeping_at", ts)).total_seconds()
    elif "reports restored" in line and current.get("wake_at"):
        current["restored_at"] = ts
        cycles.append(current)
        current = {}

print(f"Total sleep/wake cycles: {len(cycles)}")
print()
for i, c in enumerate(cycles):
    slept = c.get("slept_for", 0)
    sleep_at = c.get("sleep_at", c.get("sleeping_at", "?"))
    wake_at = c.get("wake_at", "?")
    int_flag = c.get("int_after_sleep", -1)
    int_str = f"  INT_after_sleep={int_flag}" if int_flag != -1 else ""
    print(
        f"Cycle {i+1:3d}: sleep={sleep_at.strftime('%H:%M:%S') if hasattr(sleep_at,'strftime') else sleep_at}"
        f"  wake={wake_at.strftime('%H:%M:%S') if hasattr(wake_at,'strftime') else wake_at}"
        f"  slept={slept:.1f}s{int_str}"
    )

# ── 2. Drain event ID breakdown ───────────────────────────────────────────────
print()
print("── Drain event IDs (during MIN_SLEEP_MS window) ──")
drain_ids = Counter()
for line in lines:
    m = re.search(r"\[Sleep\] drain\[\d+\] event=0x([0-9A-Fa-f]+)", line)
    if m:
        drain_ids[f"0x{m.group(1).upper()}"] += 1

KNOWN = {"0x19": "SH2_SHAKE_DETECTOR", "0x00": "unknown/ack", "0xFB": "meta"}
for eid, count in drain_ids.most_common():
    label = KNOWN.get(eid, "")
    print(f"  {eid}  {label:25s}  {count} events")

if not drain_ids:
    print("  (none — drain[] lines not found; may be older firmware)")

# ── 3. Drain cycle summary ────────────────────────────────────────────────────
print()
print("── Drain cycle summary ──")
total_drain_cycles = 0
for line in lines:
    if "drain cycle=" in line:
        m = re.search(r"drain cycle=(\d+)", line)
        if m:
            total_drain_cycles = max(total_drain_cycles, int(m.group(1)))
print(f"  Max drainCycles per sleep entry: {total_drain_cycles}")

# ── 4. Wake-cause breakdown ───────────────────────────────────────────────────
print()
print("── Wake causes (after MIN_SLEEP_MS) ──")
wake_causes = Counter()
for line in lines:
    if "INT pin LOW after MIN_SLEEP_MS" in line:
        m = re.search(r"drainCycles=(\d+) drainHubOn=(\d)", line)
        if m:
            dc, dho = int(m.group(1)), int(m.group(2))
            if dho:
                wake_causes["hub-was-awake (from drain)"] += 1
            elif dc == 0:
                wake_causes["clean-wake (no prior drain)"] += 1
            else:
                wake_causes["drain-then-resleep-ack"] += 1
        else:
            wake_causes["unknown"] += 1
for cause, count in wake_causes.most_common():
    print(f"  {cause}: {count}")

# ── 5. 0x19 inter-event spacing ──────────────────────────────────────────────
print()
print("── SH2_SHAKE_DETECTOR (0x19) inter-event spacing ──")
drain_times = []
for line in lines:
    m = re.search(r"\[Sleep\] drain\[\d+\] event=0x19", line)
    if m:
        ts = parse_ts(line)
        if ts:
            drain_times.append(ts)

if len(drain_times) > 1:
    gaps = [(drain_times[i] - drain_times[i-1]).total_seconds() * 1000
            for i in range(1, len(drain_times))]
    print(f"  Count: {len(drain_times)}")
    print(f"  Avg gap: {sum(gaps)/len(gaps):.1f} ms  (shake detector report interval)")
    print(f"  Min/Max: {min(gaps):.0f} / {max(gaps):.0f} ms")
else:
    print("  Not enough events to compute spacing.")
