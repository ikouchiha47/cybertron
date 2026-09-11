// Clocky — ESP32 + 1.3" I2C OLED digital watch clock
// Web-based settings server lives in WebPortal.cpp/.h (separate tab/file).

#include <Wire.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <WiFiManager.h>   // tzapu/WiFiManager
#include <time.h>

#include "Config.h"
#include "OtaAuth.h"
#include "WebPortal.h"
#include "WatchFaces.h"

U8G2_SH1106_128X64_NONAME_F_HW_I2C display(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);

static bool lastButtonState = HIGH;
static unsigned long lastNtpSync = 0;
const unsigned long NTP_RESYNC_MS = 60UL * 60UL * 1000UL; // hourly

// Logs an error and halts on startup-critical failures (display/WiFi wiring).
// A dead display can't show an error, so this always reports over Serial too.
static void assertOrHalt(bool condition, const char *message) {
  if (condition) return;
  Serial.print("[FATAL] ");
  Serial.println(message);
  while (true) {
    Serial.print("[FATAL] ");
    Serial.println(message);
    delay(2000);
  }
}

// Scans the I2C bus and returns true if a device answers at OLED_ADDR.
static bool i2cDeviceFound(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static void applyTimezone() {
  configTzTime(currentTz.c_str(), NTP_SERVER_1, NTP_SERVER_2, NTP_SERVER_3);
}

static void handleButton() {
  bool state = digitalRead(BUTTON_PIN);
  if (lastButtonState == HIGH && state == LOW) {
    size_t idx = watchFaceIndexForId(currentFaceId.c_str());
    idx = (idx + 1) % kWatchFaceCount;
    currentFaceId = kWatchFaces[idx].id;
    persistFaceSelection();
  }
  lastButtonState = state;
}

void setup() {
  Serial.begin(115200);
  delay(300); // give the serial monitor time to attach
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Wire.begin(OLED_SDA, OLED_SCL);

  Serial.println("[BOOT] Scanning I2C bus for OLED...");
  bool oledFound = i2cDeviceFound(OLED_ADDR);
  if (!oledFound) {
    // Do a full bus scan too, so a wrong-address module still gets logged.
    Serial.println("[ERROR] No device at configured OLED_ADDR. Scanning full bus:");
    for (uint8_t addr = 1; addr < 127; addr++) {
      if (i2cDeviceFound(addr)) {
        Serial.printf("  -> found device at 0x%02X (update OLED_ADDR in Config.h if this is your OLED)\n", addr);
      }
    }
  }
  assertOrHalt(oledFound, "OLED not responding on I2C. Check SDA=IO21, SCL=IO22, VCC=3V3, GND wiring.");

  display.begin();
  display.setContrast(255);

  display.clearBuffer();
  display.setFont(u8g2_font_7x14B_tf);
  display.drawStr(2, 30, "Connecting WiFi...");
  display.sendBuffer();

  WiFiManager wm;
  bool wifiConnected = wm.autoConnect(WIFI_AP_NAME);
  if (!wifiConnected) {
    Serial.println("[ERROR] WiFi did not connect (no saved network / setup portal timed out).");
  } else {
    Serial.print("[BOOT] WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
  }
  assertOrHalt(wifiConnected, "WiFi not connected. Join the 'Clocky-Setup' AP and configure your network.");

  otaAuthBegin();   // loads RSA public key from NVS (prompts via serial if not set)
  webPortalBegin(); // loads saved TZ/face from flash, starts settings web server
  applyTimezone();

  struct tm bootTime;
  bool ntpOk = getLocalTime(&bootTime, 10000); // wait up to 10s for first sync
  for (int attempt = 2; !ntpOk && attempt <= 3; attempt++) {
    Serial.printf("[WARN] NTP sync attempt %d failed, retrying...\n", attempt - 1);
    applyTimezone();
    ntpOk = getLocalTime(&bootTime, 10000);
  }
  if (!ntpOk) {
    Serial.println("[ERROR] NTP sync failed after 3 attempts. Check internet connectivity / firewall for UDP 123.");
  } else {
    Serial.println("[BOOT] NTP sync OK.");
  }
  lastNtpSync = millis();
}

void loop() {
  handleButton();
  webPortalLoop();

  if (settingsDirty) {
    applyTimezone();
    settingsDirty = false;
  }

  if (millis() - lastNtpSync > NTP_RESYNC_MS) {
    applyTimezone();
    lastNtpSync = millis();
  }

  struct tm timeInfo;
  if (getLocalTime(&timeInfo)) {
    size_t idx = watchFaceIndexForId(currentFaceId.c_str());
    WatchFaceContext ctx{
      display, timeInfo,
      currentTzLabel.c_str(), currentTz.c_str(),
      currentTz2Label.c_str(), currentTz2.c_str()
    };
    kWatchFaces[idx].render(ctx);
  } else {
    Serial.println("[WARN] getLocalTime() failed this cycle (NTP not yet synced?).");
  }

  delay(200);
}
