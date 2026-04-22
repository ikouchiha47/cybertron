"""
WristTurn macOS receiver
Listens for BLE gestures from the XIAO and fires keyboard shortcuts.

Single gestures:
  turn_right  →  Ctrl+Right Arrow  (next desktop)
  turn_left   →  Ctrl+Left Arrow   (previous desktop)

Combo gestures (up to 3, fired after COMBO_TIMEOUT_S of silence):
  R, R        →  next space (double flick)
  L, L        →  prev space (double flick)
  R, L        →  ...
  L, R, L     →  ...  (define your own in COMBO_ACTIONS)

Cancel: if no gesture arrives within COMBO_TIMEOUT_S the buffer clears.

macOS accessibility permission required:
  System Settings → Privacy & Security → Accessibility → allow Terminal (or your Python)
"""

import asyncio
import pyautogui
from bleak import BleakScanner, BleakClient

DEVICE_NAME       = "WristTurn"
GESTURE_CHAR_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214"
BATTERY_CHAR_UUID = "00002a19-0000-1000-8000-00805f9b34fb"  # standard BLE Battery Level

COMBO_TIMEOUT_S = 0.8   # seconds to wait for next gesture before firing
COMBO_MAX_LEN   = 3     # maximum gestures in a combo

# ── Action tables ─────────────────────────────────────────────────────────────
# Key: tuple of gesture strings.
# Single-gesture tuples are the fallback when no combo matches.

ACTIONS: dict[tuple[str, ...], callable] = {
    # single — roll
    ("turn_right",):  lambda: pyautogui.hotkey("ctrl", "right"),
    ("turn_left",):   lambda: pyautogui.hotkey("ctrl", "left"),

    # single — pitch
    ("pitch_up",):    lambda: print("action: pitch_up"),
    ("pitch_down",):  lambda: print("action: pitch_down"),

    # single — yaw
    ("yaw_left",):    lambda: print("action: yaw_left"),
    ("yaw_right",):   lambda: print("action: yaw_right"),

    # single — shake / tap / step
    ("shake",):       lambda: print("action: shake"),
    ("tap",):         lambda: print("action: tap"),
    ("step",):        lambda: print("action: step"),

    # double
    ("turn_right", "turn_right"): lambda: print("combo: RR"),
    ("turn_left",  "turn_left"):  lambda: print("combo: LL"),
    ("turn_right", "turn_left"):  lambda: print("combo: RL"),
    ("turn_left",  "turn_right"): lambda: print("combo: LR"),

    # triple
    ("turn_right", "turn_right", "turn_right"): lambda: print("combo: RRR"),
    ("turn_left",  "turn_left",  "turn_left"):  lambda: print("combo: LLL"),
    ("turn_right", "turn_left",  "turn_right"): lambda: print("combo: RLR"),
    ("turn_left",  "turn_right", "turn_left"):  lambda: print("combo: LRL"),
}

# ── Combo queue ───────────────────────────────────────────────────────────────

class ComboQueue:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop    = loop
        self._buffer: list[str] = []
        self._timer:  asyncio.TimerHandle | None = None

    def push(self, gesture: str):
        if len(self._buffer) >= COMBO_MAX_LEN:
            self._flush()          # buffer full — fire immediately

        self._buffer.append(gesture)
        print(f"  buffer: {self._buffer}")

        if self._timer:
            self._timer.cancel()

        # restart the silence timer — fires _flush after COMBO_TIMEOUT_S
        self._timer = self._loop.call_later(COMBO_TIMEOUT_S, self._flush)

    def _flush(self):
        if self._timer:
            self._timer.cancel()
            self._timer = None

        combo = tuple(self._buffer)
        self._buffer.clear()

        if not combo:
            return

        action = ACTIONS.get(combo)
        if action:
            print(f"firing: {combo}")
            action()
        else:
            print(f"no action for combo: {combo}")

# ── BLE ───────────────────────────────────────────────────────────────────────

async def main():
    loop = asyncio.get_running_loop()
    queue = ComboQueue(loop)

    def on_gesture(_, data: bytearray):
        raw = data.decode("utf-8").rstrip("\x00 ").strip()
        if not raw:
            return  # ignore empty payloads

        parts = raw.split("|")
        gesture = parts[0].strip()
        if not gesture:
            return  # ignore if gesture name is empty after split

        if len(parts) == 4:                          # turn_*/pitch_*/yaw_* with axes
            roll, pitch, yaw = parts[1], parts[2], parts[3]
            print(f"gesture: {gesture}  roll={roll}  pitch={pitch}  yaw={yaw}")
        elif len(parts) == 2:                        # step|N or shake|N
            print(f"gesture: {gesture}  value={parts[1]}")
        else:
            print(f"gesture: {gesture}")

        # step is a counter event — fire its action directly, skip combo queue
        if gesture == "step":
            action = ACTIONS.get(("step",))
            if action:
                action()
            return

        queue.push(gesture)

    def on_battery(_, data: bytearray):
        pct = data[0]
        bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
        print(f"[Battery] {bar} {pct}%")

    print("Scanning for WristTurn...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15)
    if device is None:
        print(f"Could not find '{DEVICE_NAME}'. Is it on and advertising?")
        return

    print(f"Found: {device.address}  Connecting...")
    async with BleakClient(device) as client:
        print("Connected. Waiting for gestures (Ctrl+C to quit)...")

        # read battery level immediately on connect
        try:
            batt_data = await client.read_gatt_char(BATTERY_CHAR_UUID)
            pct = batt_data[0]
            bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
            print(f"[Battery] {bar} {pct}%")
            await client.start_notify(BATTERY_CHAR_UUID, on_battery)
        except Exception:
            pass  # battery service not available — ignore

        await client.start_notify(GESTURE_CHAR_UUID, on_gesture)
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nDone.")
