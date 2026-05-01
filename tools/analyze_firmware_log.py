#!/usr/bin/env python3
"""
Firmware log analyzer for WristTurn firmware serial logs.

Usage:
    python3 tools/analyze_firmware_log.py tmp/logs.30.txt
    python3 tools/analyze_firmware_log.py tmp/logs.30.txt --summary
    python3 tools/analyze_firmware_log.py tmp/logs.30.txt --tag Cal Stab RV RVRate
"""

import re
import sys
import argparse
from collections import defaultdict
from datetime import datetime

LINE_RE = re.compile(r'^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] \[(\w+)\] (.+)$')

def parse_log(path):
    entries = []
    with open(path, encoding='utf-8', errors='replace') as f:
        for lineno, raw in enumerate(f, 1):
            raw = raw.rstrip()
            m = LINE_RE.match(raw)
            if m:
                ts_str, tag, msg = m.groups()
                try:
                    ts = datetime.strptime(ts_str, '%Y-%m-%d %H:%M:%S.%f')
                except ValueError:
                    ts = None
                entries.append({'lineno': lineno, 'ts': ts, 'ts_str': ts_str, 'tag': tag, 'msg': msg, 'raw': raw})
            else:
                entries.append({'lineno': lineno, 'ts': None, 'ts_str': '', 'tag': '?', 'msg': raw, 'raw': raw})
    return entries

def delta_s(a, b):
    if a and b:
        return abs((b - a).total_seconds())
    return None

def summarize(entries, args):
    tags = defaultdict(list)
    for e in entries:
        tags[e['tag']].append(e)

    print(f"\n=== FILE: {args.file} — {len(entries)} lines ===\n")

    # Timeline of key events
    key_tags = {'Cal', 'Stab', 'Arm', 'Reports', 'GravPose', 'RV', 'RVRate', 'Baseline', 'Sleep'}
    if args.tags:
        key_tags = set(args.tags)

    print("── Key events ──")
    for e in entries:
        if e['tag'] in key_tags:
            print(f"  {e['ts_str']}  [{e['tag']}] {e['msg']}")

    print()

    # Rotation vector rate analysis
    rv_entries = tags.get('RV', []) + tags.get('RVRate', [])
    if rv_entries:
        print("── Rotation vector rate ──")
        for e in rv_entries:
            print(f"  {e['ts_str']}  {e['msg']}")
        print()

    # Calibration timeline
    cal_entries = tags.get('Cal', [])
    if cal_entries:
        print("── Calibration ──")
        cleared = None
        captured = None
        for e in cal_entries:
            print(f"  {e['ts_str']}  {e['msg']}")
            if 'cleared' in e['msg']:
                cleared = e['ts']
            if 'captured' in e['msg']:
                captured = e['ts']
        if cleared and captured:
            dt = delta_s(cleared, captured)
            print(f"  → Time from clear to capture: {dt:.1f}s")
        elif captured and entries[0]['ts']:
            dt = delta_s(entries[0]['ts'], captured)
            print(f"  → Time from start to capture: {dt:.1f}s")
        print()

    # Arm/disarm events
    arm_entries = tags.get('Arm', [])
    if arm_entries:
        print("── Arm/disarm ──")
        for e in arm_entries:
            print(f"  {e['ts_str']}  {e['msg']}")
        print()

    # Stability transitions
    stab_entries = tags.get('Stab', [])
    if stab_entries:
        print("── Stability transitions ──")
        prev = None
        for e in stab_entries:
            m = re.search(r'stab=(\d)', e['msg'])
            stab = int(m.group(1)) if m else '?'
            labels = {0:'unknown',1:'table',2:'stationary',3:'stable',4:'motion'}
            dt = f"  (+{delta_s(prev['ts'], e['ts']):.1f}s)" if prev and e['ts'] else ""
            print(f"  {e['ts_str']}  stab={stab} ({labels.get(stab,'?')}){dt}")
            prev = e
        print()

    # GravPose transitions
    grav_entries = tags.get('GravPose', [])
    if grav_entries:
        print("── GravPose ──")
        for e in grav_entries:
            print(f"  {e['ts_str']}  {e['msg']}")
        print()

    # Tag summary
    print("── Tag counts ──")
    for tag, elist in sorted(tags.items(), key=lambda x: -len(x[1])):
        print(f"  [{tag}] {len(elist)}")

def filter_tags(entries, tags):
    for e in entries:
        if e['tag'] in tags:
            print(e['raw'])

def main():
    parser = argparse.ArgumentParser(description='Analyze WristTurn firmware logs')
    parser.add_argument('file', help='Log file path')
    parser.add_argument('--summary', action='store_true', default=True, help='Print summary (default)')
    parser.add_argument('--tags', nargs='+', help='Only show these tags')
    args = parser.parse_args()

    entries = parse_log(args.file)

    if args.tags and not args.summary:
        filter_tags(entries, set(args.tags))
    else:
        summarize(entries, args)

if __name__ == '__main__':
    main()
