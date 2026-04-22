# WristTurn App — Claude instructions

## Android builds

Always build and install the **release** APK:

```bash
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

Release signing is fully configured in `android/app/build.gradle` with `my-release-key.keystore`.

**Debug builds**: only if the user explicitly asks for a debug build. Confirm with the user before proceeding — debug and release APKs have different signatures, so switching requires an `adb uninstall` first (which clears paired device data like Android TV certificates).
