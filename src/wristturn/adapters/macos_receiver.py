"""
WristTurn macOS receiver
Listens for BLE gestures from the XIAO and fires keyboard shortcuts.

  turn_right  →  Ctrl+Right Arrow  (next desktop)
  turn_left   →  Ctrl+Left Arrow   (previous desktop)

Install deps:
  pip install bleak pyautogui

Run:
  python macos_receiver.py

macOS accessibility permission required:
  System Settings → Privacy & Security → Accessibility → allow Terminal (or your Python)
"""

import asyncio
import pyautogui
from bleak import BleakScanner, BleakClient

DEVICE_NAME     = "WristTurn"
GESTURE_CHAR_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214"

ACTION = {
    "turn_right": lambda: pyautogui.hotkey("ctrl", "right"),
    "turn_left":  lambda: pyautogui.hotkey("ctrl", "left"),
}

def on_gesture(_, data: bytearray):
    gesture = data.decode("utf-8").rstrip("\x00 ")
    print(f"gesture: {gesture}")
    action = ACTION.get(gesture)
    if action:
        action()

async def main():
    print("Scanning for WristTurn...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15)
    if device is None:
        print(f"Could not find '{DEVICE_NAME}'. Make sure the device is on and advertising.")
        return

    print(f"Found: {device.address}  Connecting...")
    async with BleakClient(device) as client:
        print("Connected. Waiting for gestures (Ctrl+C to quit)...")
        await client.start_notify(GESTURE_CHAR_UUID, on_gesture)
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nDone.")
