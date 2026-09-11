#pragma once

// ---- Display (1.3" I2C OLED, SH1106 128x64) ----
#define OLED_SDA        21   // IO21
#define OLED_SCL        22   // IO22
#define OLED_ADDR       0x3C

// ---- Face-toggle button (optional, active LOW, uses internal pullup) ----
#define BUTTON_PIN      4    // IO4

// ---- Persistent storage namespace/keys ----
#define PREF_NAMESPACE  "clocky"
#define KEY_TZ          "tz"
#define KEY_TZ_LABEL    "tzLabel"
#define KEY_TZ2         "tz2"
#define KEY_TZ2_LABEL   "tz2Label"
#define KEY_FACE        "face"

// Defaults used only until the user picks something on the web UI —
// after that, the saved choice lives in flash (NVS) and these are ignored.
#define DEFAULT_TZ        "IST-5:30"
#define DEFAULT_TZ_LABEL  "IST"
#define DEFAULT_TZ2       "EST5EDT,M3.2.0,M11.1.0"
#define DEFAULT_TZ2_LABEL "EST"
#define DEFAULT_FACE_ID   "classic"

// Multiple servers as fallback — some networks (mobile hotspots especially)
// block or drop pool.ntp.org, so try a couple of well-known alternates too.
#define NTP_SERVER_1    "pool.ntp.org"
#define NTP_SERVER_2    "time.google.com"
#define NTP_SERVER_3    "time.cloudflare.com"

#define WIFI_AP_NAME    "Clocky-Setup"

// Reachable at http://<MDNS_HOSTNAME>.local once connected to WiFi
#define MDNS_HOSTNAME   "clocky"

