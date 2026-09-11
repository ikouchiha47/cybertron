# Clocky

A G-Shock GBD-200-inspired digital clock running on an ESP32, with WiFi time
sync (NTP) and a browser-based settings page for timezone and watch-face
selection.

## Hardware

- ESP32 MiniKit / D1 mini32 board
- 1.3" I2C OLED display (SH1106 driver, 128x64)
- Optional push button for physical watch-face toggling

### Wiring

| OLED pin | ESP32 pin | Notes |
|---|---|---|
| VCC | 3V3 | do not use 5V/VIN |
| GND | GND | any GND pin |
| SCL | IO22 | I2C clock |
| SDA | IO21 | I2C data |

| Button pin | ESP32 pin | Notes |
|---|---|---|
| One leg | IO4 | configured `INPUT_PULLUP` |
| Other leg | GND | button pulls the pin LOW when pressed |

## Firmware

Located in [`clocky/`](clocky/):

- `clocky.ino` — main sketch: WiFi connect, NTP + timezone, OLED rendering, watch-face dispatch, button handling, startup diagnostics
- `Config.h` — pin numbers and constants
- `WebPortal.h` / `WebPortal.cpp` — the settings web server (timezone + watch-face selection), served by the ESP32 itself
- `Timezones.h` — the timezone table (POSIX TZ string + IANA name per zone) used by both the web UI and browser auto-detect
- `WatchFace.h` — the watch-face plugin interface (`WatchFaceContext`, `WatchFaceDef`)
- `WatchFaces.h` / `WatchFaces.cpp` — the watch-face registry; add a new face by creating `Face_YourName.h/.cpp` and adding one line here
- `Face_Classic.h` / `Face_Classic.cpp` — single-zone watch face (zone/icon/date row, big time, day/seconds row)
- `Face_World.h` / `Face_World.cpp` — dual-timezone watch face: small "world" zone up top (uses the **World timezone** web UI setting), big local time below with zone label + seconds. Each face file is self-contained, including its own copy of the small day/night icon helper.

### Required libraries (Arduino IDE Library Manager)

Install these via **Sketch → Include Library → Manage Libraries** (Ctrl/Cmd+Shift+I) before building. After installing, re-open the sketch or hit Verify again if the IDE doesn't pick them up immediately.

| Library | Author | Search name in Library Manager | Used for |
|---|---|---|---|
| U8g2 | oliver (olikraus) | `U8g2` | OLED rendering |
| WiFiManager | tzapu | `WiFiManager` | Captive-portal WiFi setup (no hardcoded SSID/password) |
| ESPAsyncWebServer | ESP32Async | `ESP Async WebServer` | Settings web server |
| AsyncTCP | ESP32Async | `Async TCP` | Dependency of ESPAsyncWebServer |

> **Important:** install the **ESP32Async** fork specifically (`ESP Async WebServer` / `Async TCP`), not the older `me-no-dev/ESPAsyncWebServer` and `me-no-dev/AsyncTCP` (or the ESP8266-only `ESPAsyncTCP`). The old versions call `mbedtls_md5_*_ret` functions that were removed from newer ESP32 core versions and will fail to compile with errors like `'mbedtls_md5_starts_ret' was not declared in this scope`. If you have both installed, Arduino may pick the wrong one and warn about "Multiple libraries found" — delete the old ones from your `Arduino/libraries/` folder so only the ESP32Async versions remain.

### Board setup

- Board: **ESP32 Dev Module** (or the closest match for your MiniKit variant)
- Select the correct serial port for your board

### First boot

1. Flash the sketch.
2. Open the Serial Monitor at **115200 baud** — boot diagnostics print here (see below).
3. On first boot (or after a WiFi reset), the ESP32 starts an access point named **`Clocky-Setup`**. Connect to it from your phone/laptop and follow the captive portal to join your WiFi network.
4. Once connected, the device syncs time over NTP and starts displaying the clock.
5. To change timezone or watch face, open **http://clocky.local** in a browser on a device on the same network (mDNS — no need to look up the IP). If your network/router doesn't support mDNS (rare, but some routers and most iOS-less Android devices without a mDNS-aware app can have trouble), find the IP address printed in Serial Monitor and use that instead.

### Timezone

The ESP32 has no GPS and can't know your location on its own. WiFi + NTP only gets it the correct **UTC instant** — the timezone offset/DST rule is a separate, explicit choice.

The settings page pre-fills the "Local timezone" dropdown using your **browser's own timezone** (`Intl.DateTimeFormat`) — this runs entirely client-side, with no external API call and nothing sent anywhere until you hit Save. If your city isn't in the dropdown, the page shows the raw IANA name your browser reported so you can pick the closest match manually.

The timezone list in `Timezones.h` covers every UTC offset and DST rule currently in use worldwide (not literally all ~450 IANA names, since `configTzTime()` only supports one present-day rule — most of the extra IANA names are historical aliases that behave identically today).

Whatever you pick is saved to flash (NVS) immediately and survives reboots/power loss — the `DEFAULT_TZ` constants in `Config.h` are only used before you've ever touched the web UI.

### Startup diagnostics

The firmware logs to Serial and halts (repeating the error every 2s) if:

- The OLED doesn't respond on the I2C bus at the configured address (`0x3C`) — a full bus scan is printed to help find the correct address if your module differs.
- WiFi fails to connect / the setup portal times out.

It also logs (without halting) if NTP sync fails at boot, or if a later time read fails.

## Troubleshooting

**`fatal error: U8g2lib.h: No such file or directory`** (or similar for `WiFiManager.h` / `ESPAsyncWebServer.h`) — the corresponding library isn't installed yet. See [Required libraries](#required-libraries-arduino-ide-library-manager) above.
