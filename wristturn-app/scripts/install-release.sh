#!/usr/bin/env bash
# install-release.sh
#
# Installs the release APK, relaunches the app fresh, then seeds the
# device-simulator's running fleet into the app's saved-devices list via
# rune://add-device deep links (see App.tsx's handleDeepLink). This exists
# because a release build's AsyncStorage isn't writable via adb without
# root/debuggable access — deep links are the one channel that reaches the
# app's own storage from the outside.
#
# Assumes:
#   - device-simulator is running on this Mac (bun index.ts ...)
#   - the phone reaches this Mac at SIM_HOST (default: the Mac's ZeroTier IP —
#     set SIM_HOST=<ip> to override, e.g. for a plain LAN IP)
#
# Usage: scripts/install-release.sh [SIM_HOST]

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
APK="$APP_ROOT/android/app/build/outputs/apk/release/app-release.apk"
PKG="com.psytrix.app"
SIM_HOST="${1:-192.168.192.131}"
SIM_PORTS=(9200 9201 9202 9203 9204 9205 9206)

if [ ! -f "$APK" ]; then
  echo "install-release: $APK not found — run 'cd android && ./gradlew assembleRelease' first." >&2
  exit 1
fi

echo "== Installing $APK =="
adb install -r "$APK"

echo "== Relaunching fresh =="
adb shell am force-stop "$PKG"
sleep 1
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 2   # let the app finish mounting App.tsx's Linking listener before we fire links at it

echo "== Seeding simulator devices from $SIM_HOST =="
seeded=0
for p in "${SIM_PORTS[@]}"; do
  info=$(curl -s -m 2 "http://${SIM_HOST}:${p}/" || true)
  if [ -z "$info" ]; then
    echo "  :$p — not reachable, skipping"
    continue
  fi
  name=$(echo "$info" | jq -r '.name // empty')
  category=$(echo "$info" | jq -r '.category // empty')
  if [ -z "$name" ]; then
    echo "  :$p — no name in response, skipping"
    continue
  fi
  label="${name} (${category})"
  url="rune://add-device?host=${SIM_HOST}&port=${p}&name=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$label")&transport=http"
  adb shell am start -a android.intent.action.VIEW -d "'$url'" >/dev/null
  echo "  :$p — seeded \"$label\""
  seeded=$((seeded + 1))
  sleep 0.3   # avoid flooding the app with intents faster than it can process them
done

echo "== Done. $seeded device(s) seeded. =="
