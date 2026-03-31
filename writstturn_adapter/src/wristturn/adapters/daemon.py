"""
WristTurn macOS daemon

Accepts commands from the Expo app and fires keyboard shortcuts via pyautogui.

Transports (same port):
  • WebSocket  ws://<host>:<port>     JSON: {"command": "ctrl_left"}
  • HTTP POST  http://<host>:<port>/command   body: {"command": "ctrl_left"}
  • HTTP GET   http://<host>:<port>/          → 200 OK  (health / HttpAdapter connect check)

Advertises via mDNS as  _wristturn-daemon._tcp  port 9876

Usage:
  pip install aiohttp pyautogui zeroconf
  python wristturn_daemon.py [--port 9876]
"""

import asyncio
import json
import argparse
import socket
import logging
from collections.abc import Callable
import pyautogui
import Quartz
from aiohttp import web
from zeroconf import ServiceInfo
from zeroconf.asyncio import AsyncZeroconf

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("wristturn")

# NX media key constants (IOKit/hidsystem/ev_keymap.h)
NX_KEYTYPE_SOUND_UP   = 0
NX_KEYTYPE_SOUND_DOWN = 1
NX_KEYTYPE_MUTE       = 7
NX_KEYTYPE_PLAY       = 16
NX_KEYTYPE_NEXT       = 17
NX_KEYTYPE_PREVIOUS   = 18

def _media_key(key_type: int) -> None:
    """Post a hardware media key event — layout/Fn-key independent."""
    from AppKit import NSEvent, NSSystemDefined
    def post(down: bool) -> None:
        flags = 0xA00 if down else 0xB00
        data1 = (key_type << 16) | flags
        ev = NSEvent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(
            NSSystemDefined, (0, 0), 0xA00, 0, 0, 0, 8, data1, -1
        )
        Quartz.CGEventPost(Quartz.kCGSessionEventTap, ev.CGEvent())
    post(True)
    post(False)


COMMANDS: dict[str, Callable[[], None]] = {
    # Desktop switching — ctrl+arrow is the standard macOS binding, no alternative API
    "ctrl_left":   lambda: pyautogui.hotkey("ctrl", "left"),
    "ctrl_right":  lambda: pyautogui.hotkey("ctrl", "right"),
    # Media keys posted as hardware events — layout/Fn-key independent
    "volume_up":   lambda: _media_key(NX_KEYTYPE_SOUND_UP),
    "volume_down": lambda: _media_key(NX_KEYTYPE_SOUND_DOWN),
    "mute":        lambda: _media_key(NX_KEYTYPE_MUTE),
    "media_play":  lambda: _media_key(NX_KEYTYPE_PLAY),
    "media_next":  lambda: _media_key(NX_KEYTYPE_NEXT),
    "media_prev":  lambda: _media_key(NX_KEYTYPE_PREVIOUS),
}


def dispatch(cmd: str) -> bool:
    action = COMMANDS.get(cmd)
    if action:
        log.info("→ %s", cmd)
        action()
        return True
    log.warning("unknown command: %s", cmd)
    return False


# ── HTTP handlers ──────────────────────────────────────────────────────────────

async def handle_root(request: web.Request):
    # React Native WebSocket connects to the root path — handle upgrade here too
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await handle_ws(request)
    return web.Response(text="ok")


async def handle_command(request: web.Request) -> web.Response:
    try:
        msg = await request.json()
        cmd = msg.get("command", "")
        if dispatch(cmd):
            return web.Response(text="ok")
        return web.Response(status=400, text=f"unknown command: {cmd}")
    except (json.JSONDecodeError, Exception) as e:
        return web.Response(status=400, text=str(e))


# ── WebSocket handler ──────────────────────────────────────────────────────────

async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    addr = request.remote
    log.info("ws connected: %s", addr)
    async for msg in ws:
        try:
            data = json.loads(msg.data)
            dispatch(data.get("command", ""))
        except (json.JSONDecodeError, Exception):
            log.warning("bad ws message: %s", msg.data)
    log.info("ws disconnected: %s", addr)
    return ws


# ── mDNS ──────────────────────────────────────────────────────────────────────

async def register_mdns(port: int):
    # gethostbyname often returns 127.0.0.1 on macOS — use a UDP trick instead
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
    finally:
        s.close()
    info = ServiceInfo(
        "_wt-daemon._tcp.local.",
        "WristTurn Daemon._wt-daemon._tcp.local.",
        addresses=[socket.inet_aton(local_ip)],
        port=port,
        properties={"commands": ",".join(COMMANDS.keys())},
    )
    zc = AsyncZeroconf()
    await zc.async_register_service(info)
    log.info("mDNS registered  %s:%d", local_ip, port)
    return zc, info


# ── main ───────────────────────────────────────────────────────────────────────

async def main(port: int):
    zc, info = await register_mdns(port)
    try:
        app = web.Application()
        app.router.add_get("/",        handle_root)   # WS upgrade or health check
        app.router.add_post("/command", handle_command)
        app.router.add_get("/ws",      handle_ws)

        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", port)
        await site.start()
        log.info("listening on :%d  (HTTP + WebSocket)  Ctrl+C to quit", port)
        await asyncio.Future()
    finally:
        await zc.async_unregister_service(info)
        await zc.async_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.port))
    except KeyboardInterrupt:
        log.info("stopped.")
