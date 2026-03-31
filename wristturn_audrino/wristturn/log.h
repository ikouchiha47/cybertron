#pragma once
#include <stdint.h>

// Fake epoch: 2011-11-11 00:00:00 UTC = Unix timestamp 1320969600
// Add millis()/1000 to get a wall-clock-ish timestamp
static const uint32_t LOG_EPOCH = 1320969600UL;

inline void logTimestamp() {
  uint32_t t = LOG_EPOCH + millis() / 1000;
  uint32_t s = t % 60; t /= 60;
  uint32_t m = t % 60; t /= 60;
  uint32_t h = t % 24; t /= 24;
  // days since epoch → date (simple, no DST/leap-year accuracy needed for logs)
  uint32_t days = t;
  uint32_t y = 2011; uint32_t diy;
  while (days >= (diy = 365 + (y%4==0 && (y%100!=0||y%400==0)))) { days -= diy; y++; }
  static const uint8_t dom[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  uint8_t mo = 0;
  while (days >= dom[mo] + (mo==1 && (y%4==0&&(y%100!=0||y%400==0)))) {
    days -= dom[mo] + (mo==1 && (y%4==0&&(y%100!=0||y%400==0))); mo++;
  }
  uint32_t ms = millis() % 1000;
  Serial.printf("[%04u-%02u-%02u %02u:%02u:%02u.%03u] ", y, mo+1, (unsigned)days+1, h, m, s, ms);
}

// ── Log levels ───────────────────────────────────────────────────────────────
#define LOG_LEVEL_OFF   0
#define LOG_LEVEL_ERROR 1
#define LOG_LEVEL_INFO  2
#define LOG_LEVEL_DEBUG 3

// Set active level here
#ifndef LOG_LEVEL
#define LOG_LEVEL LOG_LEVEL_INFO
#endif

// ── Macros ───────────────────────────────────────────────────────────────────
// Levels are cumulative:
//   DEBUG  → prints DEBUG + INFO + ERROR
//   INFO   → prints INFO  + ERROR
//   ERROR  → prints ERROR only
//   OFF    → prints nothing

#if LOG_LEVEL >= LOG_LEVEL_ERROR
  #define LOG_E(fmt, ...) do { logTimestamp(); Serial.print("E "); Serial.printf(fmt "\n", ##__VA_ARGS__); } while(0)
#else
  #define LOG_E(fmt, ...) do {} while(0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_INFO
  #define LOG_I(fmt, ...) do { logTimestamp(); Serial.printf(fmt "\n", ##__VA_ARGS__); } while(0)
#else
  #define LOG_I(fmt, ...) do {} while(0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_DEBUG
  #define LOG_D(fmt, ...) do { logTimestamp(); Serial.print("D "); Serial.printf(fmt "\n", ##__VA_ARGS__); } while(0)
#else
  #define LOG_D(fmt, ...) do {} while(0)
#endif
