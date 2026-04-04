"""
WristTurn IMU Collector
-----------------------
BLE → asyncio queue → background JSON saver
Browser controls recording (record / pause / stop).

Usage:
    uv run wristturn-collect
    open http://localhost:8080

Firmware raw-mode: write 0x01 to char 19B10014-... to stream continuous
raw|roll|pitch|yaw. Falls back to gesture-event roll/pitch/yaw extraction
if raw mode char is absent.
"""

import asyncio
import json
import time
from pathlib import Path
from typing import Optional

from aiohttp import web
from bleak import BleakScanner, BleakClient

# ── BLE UUIDs ─────────────────────────────────────────────────────────────────
GESTURE_CHAR_UUID  = "19b10001-e8f2-537e-4f6c-d104768a1214"
RAW_MODE_CHAR_UUID = "19b10014-e8f2-537e-4f6c-d104768a1214"
DEVICE_NAME_HINTS  = ("wristturn", "xiao")

# Set True to auto-detect motion windows and save them without manual record/stop.
# False = manual recording only (Record / Pause / Stop from the browser).
AUTO_CAPTURE = False

# BLE connection state — tracked so new WS clients get current status immediately
ble_connected = False
ble_device_name = ""

CAPTURES_DIR = Path(__file__).parent / "captures"
CAPTURES_DIR.mkdir(exist_ok=True)

# ── WebSocket registry ────────────────────────────────────────────────────────
ws_clients: set[web.WebSocketResponse] = set()


async def broadcast(msg: dict):
    data = json.dumps(msg)
    dead = set()
    for ws in ws_clients:
        try:
            await ws.send_str(data)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


# ── Recording state ───────────────────────────────────────────────────────────
# States: "idle" | "recording" | "paused"
rec_state   = "idle"
rec_id: Optional[str]    = None
rec_label: Optional[str] = None
rec_start_t: float       = 0.0
rec_sample_count: int    = 0

# Queue items:
#   {"_cmd": "start", "id": ..., "label": ..., "started": ...}  — new session
#   {"_cmd": "stop"}                                             — flush & save
#   {"t": ..., "roll": ..., "pitch": ..., "yaw": ...}           — IMU sample
save_queue: asyncio.Queue = asyncio.Queue()


async def saver_task():
    """Drain save_queue in the background. Never blocks the BLE callback."""
    session_meta: dict = {}
    session_samples: list[dict] = []

    while True:
        item = await save_queue.get()

        if "_cmd" not in item:
            # Regular IMU sample
            session_samples.append(item)

        elif item["_cmd"] == "start":
            session_meta    = {k: v for k, v in item.items() if k != "_cmd"}
            session_samples = []
            print(f"[Saver] session started: {session_meta['id']}")

        elif item["_cmd"] == "label":
            session_meta["label"] = item["label"]

        elif item["_cmd"] == "stop":
            if session_meta and session_samples:
                await _flush(session_meta, session_samples)
            session_meta    = {}
            session_samples = []

        save_queue.task_done()


async def _flush(meta: dict, samples: list[dict]):
    label    = (meta.get("label") or "unlabelled").strip().replace(" ", "_")
    out_dir  = CAPTURES_DIR / label
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{meta['id']}.json"

    payload = {**meta, "samples": samples}
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"[Saver] saved {len(samples)} samples → {out_path}")
    await broadcast({
        "type":    "saved",
        "id":      meta["id"],
        "label":   label,
        "samples": len(samples),
        "path":    str(out_path),
    })


# ── BLE ───────────────────────────────────────────────────────────────────────
def parse_ble_payload(data: bytearray) -> Optional[tuple[float, float, float]]:
    """Return (roll, pitch, yaw) from ASCII payload, or None."""
    try:
        raw = data.decode("utf-8", errors="ignore").strip().rstrip("\x00")
    except Exception:
        return None
    if not raw or raw in ("ping", "idle"):
        return None
    parts = raw.split("|")
    if len(parts) == 4:
        try:
            return (float(parts[1]), float(parts[2]), float(parts[3]))
        except ValueError:
            pass
    return None


async def on_ble_notify(_sender, data: bytearray):
    global rec_sample_count

    parsed = parse_ble_payload(data)
    if parsed is None:
        return

    roll, pitch, yaw = parsed
    await broadcast({"type": "sample", "roll": roll, "pitch": pitch, "yaw": yaw})

    if rec_state == "recording":
        rec_sample_count += 1
        t_ms = int((time.monotonic() - rec_start_t) * 1000)
        save_queue.put_nowait({"t": t_ms, "roll": roll, "pitch": pitch, "yaw": yaw})
        if rec_sample_count % 50 == 0:
            await broadcast({"type": "rec_progress", "samples": rec_sample_count, "elapsed_ms": t_ms})


async def ble_loop():
    global ble_connected, ble_device_name
    while True:
        print("[BLE] scanning...")
        try:
            device = await BleakScanner.find_device_by_filter(
                lambda d, _: any(h in (d.name or "").lower() for h in DEVICE_NAME_HINTS),
                timeout=15.0,
            )
        except Exception as e:
            print(f"[BLE] scan error: {e}")
            await asyncio.sleep(3)
            continue

        if device is None:
            print("[BLE] not found, retrying...")
            await asyncio.sleep(2)
            continue

        print(f"[BLE] found: {device.name} ({device.address})")
        try:
            async with BleakClient(device, timeout=15.0) as client:
                ble_connected = True
                ble_device_name = device.name or ""
                await broadcast({"type": "status", "connected": True, "device": ble_device_name})
                try:
                    await client.write_gatt_char(RAW_MODE_CHAR_UUID, bytes([0x01]))
                    print("[BLE] raw mode enabled")
                except Exception:
                    print("[BLE] raw mode char absent — using gesture events")

                await client.start_notify(GESTURE_CHAR_UUID, on_ble_notify)
                print("[BLE] streaming")

                while client.is_connected:
                    await asyncio.sleep(1)

        except Exception as e:
            print(f"[BLE] error: {e}")

        ble_connected = False
        ble_device_name = ""
        print("[BLE] disconnected, retrying in 2s...")
        await broadcast({"type": "status", "connected": False})
        await asyncio.sleep(2)


# ── WebSocket + HTTP ──────────────────────────────────────────────────────────
HTML_PATH = Path(__file__).parent / "index.html"


async def handle_index(request):
    return web.FileResponse(HTML_PATH)


async def handle_ws(request):
    global rec_state, rec_id, rec_label, rec_start_t, rec_sample_count

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients.add(ws)
    print(f"[WS] client connected ({len(ws_clients)} total)")

    # Send current state to new client
    await ws.send_str(json.dumps({"type": "status", "connected": ble_connected, "device": ble_device_name}))
    await ws.send_str(json.dumps({"type": "rec_state", "state": rec_state, "id": rec_id}))

    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            cmd  = data.get("type")

            if cmd == "record_start":
                if rec_state != "idle":
                    continue
                rec_id           = f"rec_{int(time.time() * 1000)}"
                rec_label        = data.get("label") or ""
                rec_start_t      = time.monotonic()
                rec_sample_count = 0
                rec_state        = "recording"
                save_queue.put_nowait({
                    "_cmd":    "start",
                    "id":      rec_id,
                    "label":   rec_label,
                    "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
                })
                await broadcast({"type": "rec_state", "state": "recording", "id": rec_id})
                print(f"[Rec] start  id={rec_id}  label={rec_label!r}")

            elif cmd == "record_pause":
                if rec_state == "recording":
                    rec_state = "paused"
                    await broadcast({"type": "rec_state", "state": "paused", "id": rec_id})
                    print(f"[Rec] paused  samples_so_far={rec_sample_count}")

            elif cmd == "record_resume":
                if rec_state == "paused":
                    rec_state = "recording"
                    await broadcast({"type": "rec_state", "state": "recording", "id": rec_id})
                    print(f"[Rec] resumed")

            elif cmd == "relabel":
                # Rename saved file to new label directory
                session_id = data.get("id", "")
                new_label  = (data.get("label") or "unlabelled").strip().replace(" ", "_")
                for json_file in CAPTURES_DIR.rglob(f"{session_id}.json"):
                    payload = json.loads(json_file.read_text())
                    payload["label"] = new_label
                    new_dir = CAPTURES_DIR / new_label
                    new_dir.mkdir(exist_ok=True)
                    new_path = new_dir / json_file.name
                    new_path.write_text(json.dumps(payload, indent=2))
                    if json_file != new_path:
                        json_file.unlink()
                        # Remove old label dir if empty
                        try:
                            json_file.parent.rmdir()
                        except OSError:
                            pass
                    print(f"[Relabel] {session_id} → {new_label}")
                    break

            elif cmd == "record_stop":
                if rec_state in ("recording", "paused"):
                    # Update label if provided at stop time
                    if data.get("label"):
                        rec_label = data["label"]
                        # patch the start command's label in the queue is tricky,
                        # so send a label-update item the saver will apply before flush
                        save_queue.put_nowait({"_cmd": "label", "label": rec_label})
                    save_queue.put_nowait({"_cmd": "stop"})
                    old_id    = rec_id
                    rec_state = "idle"
                    rec_id    = None
                    await broadcast({"type": "rec_state", "state": "idle", "id": old_id,
                                    "samples": rec_sample_count})
                    print(f"[Rec] stop  total_samples={rec_sample_count}")

    except Exception as e:
        print(f"[WS] error: {e}")
    finally:
        ws_clients.discard(ws)

    return ws


async def handle_captures(request):
    result = {}
    for d in sorted(CAPTURES_DIR.iterdir()):
        if d.is_dir():
            result[d.name] = len(list(d.glob("*.json")))
    return web.json_response(result)


async def handle_session(request):
    """Return samples for a single recording session by id."""
    session_id = request.match_info["id"]
    for json_file in CAPTURES_DIR.rglob(f"{session_id}.json"):
        return web.json_response(json.loads(json_file.read_text()))
    return web.Response(status=404)


async def main():
    # Start background saver
    asyncio.create_task(saver_task())

    app = web.Application()
    app.router.add_get("/",               handle_index)
    app.router.add_get("/ws",             handle_ws)
    app.router.add_get("/captures",       handle_captures)
    app.router.add_get("/session/{id}",   handle_session)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "localhost", 8080).start()
    print("[HTTP] http://localhost:8080")

    await ble_loop()


def run():
    asyncio.run(main())


if __name__ == "__main__":
    run()
