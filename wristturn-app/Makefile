ANDROID_HOME := $(HOME)/Library/Android/sdk
JAVA_HOME    := $(shell asdf where java)
GRADLE       := ANDROID_HOME=$(ANDROID_HOME) JAVA_HOME=$(JAVA_HOME) ./android/gradlew
APK          := android/app/build/outputs/apk/debug/app-debug.apk

export ANDROID_HOME
export JAVA_HOME

.PHONY: build install run prebuild clean logs start

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

# Start Metro bundler
start:
	npx expo start

# Stream device logs (filtered)
logs:
	adb logcat | grep -E "wristturn|AndroidTV|mDNS|ReactNative.*Error|FATAL"

# Clean build cache
clean:
	$(GRADLE) -p android clean

# Full wipe — node_modules + native cache + rebuild from scratch
nuke:
	rm -rf node_modules android/app/.cxx android/app/build android/.gradle
	npm install --legacy-peer-deps
	$(MAKE) build install
