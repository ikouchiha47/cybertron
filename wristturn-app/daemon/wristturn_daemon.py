"""
WristTurn macOS daemon

Listens for commands from the Expo app over WebSocket and fires
keyboard shortcuts via pyautogui.

Advertises itself on the local network via mDNS as:
  _wristturn-daemon._tcp  port 9876

Usage:
  pip install websockets pyautogui zeroconf
  python wristturn_daemon.py [--port 9876]
"""

import asyncio
import json
import argparse
import socket
import logging
import pyautogui
import websockets
from zeroconf import ServiceInfo, Zeroconf

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("wristturn")

COMMANDS = {
    "ctrl_left":   lambda: pyautogui.hotkey("ctrl", "left"),
    "ctrl_right":  lambda: pyautogui.hotkey("ctrl", "right"),
    "volume_up":   lambda: pyautogui.hotkey("fn", "F12"),
    "volume_down": lambda: pyautogui.hotkey("fn", "F11"),
    "mute":        lambda: pyautogui.hotkey("fn", "F10"),
    "media_play":  lambda: pyautogui.hotkey("fn", "F8"),
    "media_next":  lambda: pyautogui.hotkey("fn", "F9"),
    "media_prev":  lambda: pyautogui.hotkey("fn", "F7"),
}


async def handle(ws):
    addr = ws.remote_address
    log.info("connected: %s", addr)
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                cmd = msg.get("command", "")
                action = COMMANDS.get(cmd)
                if action:
                    log.info("→ %s", cmd)
                    action()
                else:
                    log.warning("unknown command: %s", cmd)
            except (json.JSONDecodeError, KeyError):
                log.warning("bad message: %s", raw)
    except websockets.ConnectionClosed:
        pass
    log.info("disconnected: %s", addr)


def register_mdns(port: int) -> tuple[Zeroconf, ServiceInfo]:
    local_ip = socket.gethostbyname(socket.gethostname())
    info = ServiceInfo(
        "_wristturn-daemon._tcp.local.",
        "WristTurn Daemon._wristturn-daemon._tcp.local.",
        addresses=[socket.inet_aton(local_ip)],
        port=port,
        properties={"commands": ",".join(COMMANDS.keys())},
    )
    zc = Zeroconf()
    zc.register_service(info)
    log.info("mDNS registered on %s:%d", local_ip, port)
    return zc, info


async def main(port: int):
    zc, info = register_mdns(port)
    try:
        async with websockets.serve(handle, "0.0.0.0", port):
            log.info("listening on ws://0.0.0.0:%d  (Ctrl+C to quit)", port)
            await asyncio.Future()
    finally:
        zc.unregister_service(info)
        zc.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.port))
    except KeyboardInterrupt:
        log.info("stopped.")
