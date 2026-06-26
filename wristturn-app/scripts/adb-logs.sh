#!/usr/bin/env bash
#
# Live tail of WristTurn-relevant adb logs.
#
# Usage:
#   ./scripts/adb-logs.sh                       # follow live, default filter
#   ./scripts/adb-logs.sh raw                   # follow live, no filtering
#   ./scripts/adb-logs.sh dump                  # last 500 filtered lines, exit
#   ./scripts/adb-logs.sh grep PAT              # narrow with extra grep
#   ./scripts/adb-logs.sh -s <SERIAL> [mode]    # pick device by serial
#   ./scripts/adb-logs.sh -l                    # list devices and exit
#
# Or set ANDROID_SERIAL=<id> in your env. The script auto-picks if exactly
# one device is connected.

set -euo pipefail

PKG="com.anonymous.wristturnapp"

# ── Parse flags ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--serial) export ANDROID_SERIAL="$2"; shift 2 ;;
    -l|--list)
      adb devices -l
      exit 0 ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0 ;;
    *) break ;;
  esac
done

# ── Pick a device (portable to bash 3.2 — macOS default) ─────────────────────
DEVICE_LIST=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
DEVICE_COUNT=$(printf '%s\n' "$DEVICE_LIST" | grep -c .)
if [[ $DEVICE_COUNT -eq 0 ]]; then
  echo "No adb devices connected. Plug one in or run: adb start-server" >&2
  exit 1
fi
if [[ $DEVICE_COUNT -gt 1 && -z "${ANDROID_SERIAL:-}" ]]; then
  echo "Multiple devices:" >&2
  adb devices -l | sed 's/^/  /' >&2
  echo "Pick one with: ./scripts/adb-logs.sh -s <SERIAL>" >&2
  echo "      or set:  ANDROID_SERIAL=<SERIAL> ./scripts/adb-logs.sh" >&2
  exit 1
fi

# ── Wait for the app process so we can filter by PID ─────────────────────────
SOLE_DEVICE=$(printf '%s\n' "$DEVICE_LIST" | head -n1)
echo "[adb-logs] device=${ANDROID_SERIAL:-$SOLE_DEVICE} pkg=${PKG}" >&2
PID=""
for i in 1 2 3 4 5; do
  PID=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' || true)
  [[ -n "$PID" ]] && break
  echo "[adb-logs] waiting for ${PKG} to start... ($i/5)" >&2
  sleep 1
done

# ── Default filter ───────────────────────────────────────────────────────────
# Restrict to JS console + native module logs we care about.
DEFAULT_GREP='ReactNativeJS|WristTurn|AndroidTVModule|FATAL EXCEPTION|AndroidRuntime'

MODE="${1:-follow}"
case "$MODE" in
  raw)
    if [[ -n "$PID" ]]; then
      exec adb logcat --pid="$PID"
    else
      exec adb logcat
    fi
    ;;
  dump)
    if [[ -n "$PID" ]]; then
      adb logcat -d --pid="$PID" | grep -E "$DEFAULT_GREP" | tail -500
    else
      adb logcat -d | grep -E "$DEFAULT_GREP" | tail -500
    fi
    ;;
  grep)
    EXTRA="${2:?grep needs a pattern}"
    if [[ -n "$PID" ]]; then
      exec adb logcat --pid="$PID" | grep --line-buffered -E "$DEFAULT_GREP" | grep --line-buffered -iE "$EXTRA"
    else
      exec adb logcat | grep --line-buffered -E "$DEFAULT_GREP" | grep --line-buffered -iE "$EXTRA"
    fi
    ;;
  follow|*)
    if [[ -n "$PID" ]]; then
      exec adb logcat --pid="$PID" | grep --line-buffered -E "$DEFAULT_GREP"
    else
      echo "[adb-logs] app not running yet — tailing without PID filter" >&2
      exec adb logcat | grep --line-buffered -E "$DEFAULT_GREP"
    fi
    ;;
esac
