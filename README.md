# DoorCam

A Ring-style door camera app for ESP32-CAM with on-device person detection.

## How it works

- ESP32-CAM streams MJPEG video on port 81
- A Kotlin native bridge (`MjpegStreamView`) opens a single connection to the
  stream, renders frames directly to a `TextureView`, and emits one frame per
  second to JS for inference
- SSD MobileNet v1 TFLite runs on-device to detect people
- Proximity estimated from bounding box height (far / close / very close)
- Local push notification when someone is detected

## Hardware

- ESP32-CAM (AI Thinker) with OV3660 sensor
- ESP32-CAM-MB programmer board (CH340 USB-serial)

## Firmware

See `../doorcam/CameraWebServer/`. Uses WiFiManager — on first boot creates a
`DoorCam-Setup` hotspot. Connect from your phone and enter your WiFi credentials.
Saved to flash and used on every reboot.

### WiFi provisioning for multiple cameras

The captive portal works fine for one camera but is painful when adding more.
Two better options:

**SmartConfig (easiest — provisions all cameras at once)**

The phone broadcasts SSID + password over UDP. Every powered-on unconfigured
ESP32 in range captures it simultaneously — one action, N cameras done.

```cpp
WiFi.beginSmartConfig();
while (!WiFi.smartConfigDone()) { delay(500); }
// credentials captured; connect and save to NVS
```

Use Espressif's "ESP-TOUCH" app on Android/iOS, or implement the SmartConfig
send in the React Native app. All cameras must be powered on before you send.

Docs: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_smartconfig.html

**BLE provisioning (best UX — integrates into the app)**

Camera advertises over BLE when unconfigured. The app scans, finds it, sends
SSID + password over BLE. Camera connects, stops advertising, never needs a
hotspot. This is what Hue / Nest etc. use.

ESP-side: Espressif's `esp_prov` BLE provisioning library.
App-side: `react-native-ble-plx`.

**Why not mesh (ESP-Mesh / ESP-MDF)**

Mesh works for low-bandwidth sensors. For MJPEG video it's the wrong tool:
only the root node connects to the router, so every camera's stream has to
traverse the mesh to reach your phone. The root becomes a bandwidth bottleneck
immediately and latency stacks per hop. Keep every camera directly on the LAN.

### OTA firmware updates

No need to remove the camera to flash. Add `ArduinoOTA` to the firmware and
push updates over WiFi from your laptop while the camera stays mounted.

**Firmware changes** (`CameraWebServer.ino`):

```cpp
#include <ArduinoOTA.h>

// in setup(), after WiFi connects:
ArduinoOTA.setHostname("doorcam-1");   // change per camera
ArduinoOTA.setPassword("doorcam");     // change to something real
ArduinoOTA
  .onStart([]()   { Serial.println("OTA start"); })
  .onEnd([]()     { Serial.println("OTA end"); })
  .onProgress([](unsigned int p, unsigned int t) {
    Serial.printf("OTA %u%%\n", p / (t / 100));
  })
  .onError([](ota_error_t e) { Serial.printf("OTA error %u\n", e); });
ArduinoOTA.begin();

// in loop():
ArduinoOTA.handle();
```

**Partition scheme** — in Arduino IDE set:
`Tools → Partition Scheme → Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)`
This splits the flash into two app slots so a new image is written to the
inactive slot and only activated on successful boot.

**To flash wirelessly:**

```bash
# by IP
python espota.py -i 192.168.0.126 -p 3232 -a doorcam -f firmware.bin

# or Arduino IDE: Tools → Port will show "doorcam-1 at 192.168.0.126"
# just select it and hit Upload as normal
```

Each camera needs a unique `setHostname` so they appear as separate network
ports in the IDE (`doorcam-1`, `doorcam-2`, etc.).

## App stack

- React Native (Expo)
- `react-native-fast-tflite` — on-device inference
- Kotlin `MjpegStreamView` native bridge — single-connection MJPEG display + frame tee
- `expo-notifications` — local push notifications
- `@react-native-async-storage/async-storage` — persisting ESP32 IP

## Model

SSD MobileNet v1 COCO (quantized uint8, 300×300 input) — class 0 = person.
Proximity from bounding box height. YOLOv8n TFLite also available in
`assets/models/` and `src/hooks/usePersonDetectionYolo.ts` but SSD performs
better in practice for this camera.

## Night mode

Tap the **G** button in the header to enable hardware gamma on the ESP32
(`/control?var=raw_gma&val=1`). Also lowers detection threshold for IR conditions.

## Next steps — custom model training

The current SSD MobileNet and YOLOv8n models are both pretrained on COCO
(daylight, varied scenes). Detection degrades at night and on partial bodies
(just a head appearing at the door) because no door-camera footage was in the
training data.

To fix this properly:

1. **Collect footage** — record MJPEG frames from the ESP32 at different times
   of day and night. The `MjpegFrame` events already give you base64 JPEGs every
   second — log them to storage when motion is suspected.

2. **Label** — use [Label Studio](https://labelstud.io) or
   [Roboflow](https://roboflow.com) to draw bounding boxes around people in the
   collected frames. Export in YOLO format.

3. **Fine-tune YOLOv8n** — start from the pretrained weights and fine-tune on
   your labelled door-camera dataset:
   ```
   yolo train model=yolov8n.pt data=doorcam.yaml epochs=50 imgsz=320
   ```

4. **Export** — run `scripts/export_yolov8n.py` on the fine-tuned weights to
   get a new TFLite model, drop it into `assets/models/yolov8n.tflite`, and
   swap `MonitorScreen.tsx` back to `usePersonDetectionYolo`.

The calibration images used during the initial export (coco8 — zoo animals and
food) were useless for this use case. A door-camera dataset, even 200-300
labelled frames, would likely outperform the generic pretrained model
significantly for night conditions.
