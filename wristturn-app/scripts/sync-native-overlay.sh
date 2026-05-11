#!/usr/bin/env bash
# sync-native-overlay.sh
#
# Copies tracked native Android source files from native-overlay/ into the
# gitignored android/ tree. Run after `npx expo prebuild`, after a fresh
# `git clone`, or whenever the overlay sources change.
#
# Rationale: Expo's prebuild step generates android/ from app.json + the
# config-plugin tree. We override that with a custom BLE foreground service
# (BLEForegroundService.kt etc.) plus manifest entries for the service.
# Since android/ is gitignored, the source of truth lives under
# native-overlay/ and gets copied into place by this script.
#
# Safe to run multiple times — pure file copy, no transformations.

set -euo pipefail

# Resolve repo paths regardless of where the script is invoked from.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
OVERLAY="$APP_ROOT/native-overlay"
DEST="$APP_ROOT/android"

if [ ! -d "$OVERLAY" ]; then
  echo "sync-native-overlay: $OVERLAY missing — nothing to do" >&2
  exit 0
fi

if [ ! -d "$DEST" ]; then
  echo "sync-native-overlay: $DEST does not exist."                >&2
  echo "  Run \`npx expo prebuild\` first to create the android tree."  >&2
  exit 1
fi

# rsync would be cleaner but cp -R works everywhere without a dep.
# Per-file copy so we report each one.
count=0
while IFS= read -r -d '' src; do
  rel="${src#$OVERLAY/}"
  dst="$DEST/$rel"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  overlay → $rel"
  count=$((count + 1))
done < <(find "$OVERLAY" -type f -print0)

echo "sync-native-overlay: copied $count file(s) into android/"
