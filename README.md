# DoorCam

A Ring-style door camera app for ESP32-CAM with on-device person detection.

## How it works

- ESP32-CAM streams MJPEG video on port 81
- App polls `/capture` every 2s and runs SSD MobileNet v1 TFLite model on-device
- Detects people, estimates proximity by bounding box size
- Local push notification when someone is detected
- Tap Settings to change the ESP32 IP address

## Hardware

- ESP32-CAM (AI Thinker) with OV2640 sensor
- ESP32-CAM-MB programmer board (CH340 USB-serial)

## Firmware

See `../doorcam/CameraWebServer/`. Uses WiFiManager — on first boot creates a
`DoorCam-Setup` hotspot. Connect from your phone and enter your WiFi credentials.
They are saved to flash and used on every reboot.

## App stack

- React Native (Expo)
- `react-native-fast-tflite` — on-device inference
- `react-native-webview` — MJPEG stream
- `expo-notifications` — local push notifications
- `@react-native-async-storage/async-storage` — persisting ESP32 IP

## Model

SSD MobileNet v1 COCO (quantized) — detects 90 COCO classes, class 0 = person.
Proximity estimated from bounding box height relative to frame.
