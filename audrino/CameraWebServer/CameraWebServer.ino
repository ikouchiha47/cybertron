#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <Preferences.h>

// ===========================
// Select camera model in board_config.h
// ===========================
#include "board_config.h"

void startCameraServer();
void setupLedFlash();

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_UXGA;
  config.pixel_format = PIXFORMAT_JPEG;  // for streaming
  //config.pixel_format = PIXFORMAT_RGB565; // for face detection/recognition
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  // if PSRAM IC present, init with UXGA resolution and higher JPEG quality
  //                      for larger pre-allocated frame buffer.
  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.jpeg_quality = 20;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
      // Limit the frame size when PSRAM is not available
      config.frame_size = FRAMESIZE_SVGA;
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  } else {
    // Best option for face detection/recognition
    config.frame_size = FRAMESIZE_240X240;
#if CONFIG_IDF_TARGET_ESP32S3
    config.fb_count = 2;
#endif
  }

#if defined(CAMERA_MODEL_ESP_EYE)
  pinMode(13, INPUT_PULLUP);
  pinMode(14, INPUT_PULLUP);
#endif

  // camera init
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
    s->set_sharpness(s, 1);
    s->set_raw_gma(s, 1);   // hardware gamma on — matches camera status defaults
  }
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_HVGA);  // 480x320, framesize=6 from /status
  }

#if defined(CAMERA_MODEL_M5STACK_WIDE) || defined(CAMERA_MODEL_M5STACK_ESP32CAM)
  s->set_vflip(s, 1);
  s->set_hmirror(s, 1);
#endif

#if defined(CAMERA_MODEL_ESP32S3_EYE)
  s->set_vflip(s, 1);
#endif

// Setup LED FLash if LED pin is defined in camera_pins.h
#if defined(LED_GPIO_NUM)
  setupLedFlash();
#endif

  // WiFiManager: on first boot starts "DoorCam-Setup" hotspot.
  // Connect from your phone, enter WiFi credentials — saved to flash.
  // To reconfigure: hold reset for 3s (or call wm.resetSettings()).
  WiFi.setSleep(false);

  Preferences prefs;

  // --- Phase 1: try saved credentials (normal boot, fast) ---
  WiFi.begin();
  bool connected = WiFi.waitForConnectResult(8000) == WL_CONNECTED;
  if (connected) {
    Serial.println("WiFi connected (saved credentials)");
  }

  // --- Phase 2: SmartConfig (phone broadcasts SSID+pass, all cameras pick it up) ---
  if (!connected) {
    Serial.println("Starting SmartConfig — use ESP-TOUCH app on your phone (60s timeout)...");
    WiFi.beginSmartConfig();
    int elapsed = 0;
    while (!WiFi.smartConfigDone() && elapsed < 60000) {
      delay(500);
      elapsed += 500;
    }
    if (WiFi.smartConfigDone()) {
      if (WiFi.waitForConnectResult(8000) == WL_CONNECTED) {
        connected = true;
        Serial.println("WiFi connected via SmartConfig");
      }
    } else {
      WiFi.stopSmartConfig();
      Serial.println("SmartConfig timed out — falling back to portal");
    }
  }

  // --- Phase 3: WiFiManager captive portal (last resort, single camera setup) ---
  if (!connected) {
    WiFiManager wm;
    char apName[32];
    snprintf(apName, sizeof(apName), "DoorCam-%06llX", ESP.getEfuseMac() & 0xFFFFFF);

    // Custom field to set OTA password during portal provisioning
    WiFiManagerParameter ota_pass_param("ota_pass", "OTA Password", "", 32, "type='password'");
    wm.addParameter(&ota_pass_param);

    connected = wm.autoConnect(apName);
    if (!connected) {
      Serial.println("WiFi connection failed — restarting");
      delay(3000);
      ESP.restart();
    }
    Serial.println("WiFi connected via portal");

    // Save OTA password to NVS if entered in portal
    if (strlen(ota_pass_param.getValue()) > 0) {
      prefs.begin("doorcam", false);
      prefs.putString("ota_pass", ota_pass_param.getValue());
      prefs.end();
      Serial.println("OTA password saved to NVS");
    }
  }

  // Read OTA password from NVS
  prefs.begin("doorcam", true);
  String otaPass = prefs.getString("ota_pass", "");
  prefs.end();

  // Use last 3 bytes of MAC as unique suffix e.g. "doorcam-a1b2c3.local"
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  String suffix = mac.substring(mac.length() - 6);
  suffix.toLowerCase();
  String hostname = "doorcam-" + suffix;

  if (MDNS.begin(hostname.c_str())) {
    MDNS.addService("doorcam", "tcp", 80);
    MDNS.addServiceTxt("doorcam", "tcp", "id",          mac.c_str());
    MDNS.addServiceTxt("doorcam", "tcp", "stream_port", "81");
    MDNS.addServiceTxt("doorcam", "tcp", "model",       "esp32-cam");
    Serial.print("mDNS started — reachable at http://");
    Serial.print(hostname);
    Serial.println(".local");
  }

  // OTA — reuses the mDNS hostname so it shows as "doorcam-a1b2c3" in Arduino IDE
  ArduinoOTA.setHostname(hostname.c_str());
  if (otaPass.length() > 0) {
    ArduinoOTA.setPassword(otaPass.c_str());
  }
  ArduinoOTA
    .onStart([]()  { Serial.println("OTA start"); })
    .onEnd([]()    { Serial.println("OTA end — rebooting"); })
    .onProgress([](unsigned int p, unsigned int t) {
      Serial.printf("OTA %u%%\n", p / (t / 100));
    })
    .onError([](ota_error_t e) { Serial.printf("OTA error %u\n", e); });
  ArduinoOTA.begin();
  Serial.println("OTA ready");

  startCameraServer();

  Serial.print("Camera Ready! Use 'http://");
  Serial.print(WiFi.localIP());
  Serial.println("' to connect");
}

void loop() {
  ArduinoOTA.handle();
  delay(1000);
}
