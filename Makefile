.PHONY: daemon

# Start macOS daemon (HTTP POST /command + WebSocket on port 9876)
daemon:
	cd writstturn_adapter && uv run wristturn

app.release:
	cd ./wristturn-app/android && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk 
