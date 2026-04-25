ANDROID_HOME := $(HOME)/Library/Android/sdk
JAVA_HOME    := $(shell asdf where java)
GRADLE       := ANDROID_HOME=$(ANDROID_HOME) JAVA_HOME=$(JAVA_HOME) ./android/gradlew
APK          := android/app/build/outputs/apk/debug/app-debug.apk

export ANDROID_HOME
export JAVA_HOME

.PHONY: build install run prebuild clean logs start launch metro tunnel test

# Full rebuild + install
all: build install

# Regenerate android/ from app.json (run after changing permissions/plugins)
prebuild:
	npx expo prebuild --platform android

# Compile APK
build:
	$(GRADLE) -p android app:assembleDebug

# Install APK on connected device
install:
	adb install -r $(APK)

# Build + install in one shot
deploy: build install

# Re-establish adb reverse tunnel (run if Metro says "No apps connected")
tunnel:
	adb start-server
	adb reverse tcp:8081 tcp:8081
	@echo "Tunnel ready"

# Launch app on connected device + set up Metro tunnel
launch:
	adb start-server
	adb shell am start -n com.anonymous.wristturnapp/.MainActivity
	adb reverse tcp:8081 tcp:8081

# Start Metro bundler (background) + tunnel
metro:
	npx expo start --port 8081 &
	sleep 6
	adb reverse tcp:8081 tcp:8081

# Start Metro bundler
start:
	npx expo start

# Stream device logs (filtered)
logs:
	adb logcat | grep -E "wristturn|AndroidTV|mDNS|ReactNative.*Error|FATAL"

# Clean build cache
clean:
	$(GRADLE) -p android clean

# Run core unit tests (pure TypeScript, no device required)
test:
	bun src/gestures/__tests__/MotionClassifier.test.ts
	bun src/ble/__tests__/StatePacket.test.ts

# Full wipe — node_modules + native cache + rebuild from scratch
nuke:
	rm -rf node_modules android/app/.cxx android/app/build android/.gradle
	npm install --legacy-peer-deps
	$(MAKE) build install

device.logs:
	adb logcat -d --pid=$(adb shell pidof com.anonymous.wristturnapp 2>/dev/null | tr -d '\r')
