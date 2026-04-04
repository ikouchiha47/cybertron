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
