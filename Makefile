.PHONY: daemon

# Start macOS daemon (HTTP POST /command + WebSocket on port 9876)
daemon:
	cd writstturn_adapter && uv run wristturn
