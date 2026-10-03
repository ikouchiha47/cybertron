# DoorCam — Agent / Deployment Guide

## Prerequisites

| Tool | Install |
|------|---------|
| Node.js 18+ | `brew install node` |
| Java 17 (JDK) | `brew install --cask temurin@17` |
| Android SDK | Android Studio → SDK Manager → API 34 |
| ADB | Included with Android SDK (`platform-tools`) |
| Expo CLI | `npm install -g expo-cli` |

Add to shell profile:
```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools
```

---

## Build

### Debug APK
```sh
cd android
./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

### Release APK
```sh
cd android
./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```

---

## Deploy to Device

### Verify device is connected
```sh
adb devices
# Should list your device, e.g.:
# 192.168.1.x:5555   device   (TCP/IP)
# XXXXXXXXX          device   (USB)
```

### Connect over Wi-Fi (TCP/IP)
```sh
adb tcpip 5555
adb connect <DEVICE_IP>:5555
```

### Install (first time)
```sh
adb install android/app/build/outputs/apk/debug/app-debug.apk
# or for release:
adb install android/app/build/outputs/apk/release/app-release.apk
```

### Reinstall (upgrade, keep data)
```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

### Full uninstall + reinstall (clear all data, required for notification channel changes)
```sh
adb uninstall com.doorcam.app
adb install android/app/build/outputs/apk/release/app-release.apk
```

### Launch app
```sh
adb shell am start -n com.doorcam.app/.MainActivity
```

---

## One-liner: build + deploy debug
```sh
cd android && ./gradlew assembleDebug && cd .. && \
  adb install -r android/app/build/outputs/apk/debug/app-debug.apk && \
  adb shell am start -n com.doorcam.app/.MainActivity
```

---

## Debug Commands

### Logcat — DoorCam logs only
```sh
adb logcat -s DoorCam:V ReactNativeJS:V
```

### Logcat — person detection + notifications
```sh
adb logcat | grep -E "\[DoorCam\]|NotificationChannel|ExpoNotif"
```

### Logcat — clear + watch from now
```sh
adb logcat -c && adb logcat | grep "\[DoorCam\]"
```

### Inspect notification channels
```sh
adb shell dumpsys notification | grep -A 20 "doorcam"
```
Key fields to check:
- `mAudioAttributes` — must **not** be null for correct sound selection
- `mUserLockedFields` — if `20`, user has overridden sound; uninstall to reset

### Check which channels exist
```sh
adb shell dumpsys notification | grep "NotificationRecord\|channel="
```

### Force-stop the app
```sh
adb shell am force-stop com.doorcam.app
```

### Clear app data (resets channels, DB, preferences)
```sh
adb shell pm clear com.doorcam.app
```

### Pull captured video from device
```sh
adb pull /sdcard/Android/data/com.doorcam.app/files/ ./captured/
```

### Pull SQLite DB
```sh
adb pull /data/data/com.doorcam.app/databases/doorcam.db ./doorcam.db
# Note: requires root or debuggable build
```

---

## Notification Channel Notes

- **Channel ID**: `doorcam-v2`
- Android notification channel sound settings are **immutable** after creation.
- If the channel shows ringtone instead of notification sound: **uninstall the app** to clear the channel, then reinstall.
- Vivo/Funtouch OS may persist user-locked channel settings even across uninstalls. To fully reset: go to Settings → Apps → DoorCam → Notifications → delete channel manually, then reinstall.
- The `doorcam` channel (without `-v2`) is the old channel; it is deleted on app startup via `deleteNotificationChannelAsync('doorcam')`.

---

## Package Info

| Field | Value |
|-------|-------|
| Package name | `com.doorcam.app` |
| Main activity | `com.doorcam.app.MainActivity` |
| DB file | `doorcam.db` |
| Capture dir | `/sdcard/Android/data/com.doorcam.app/files/events/` |
| Notification channel | `doorcam-v2` |
