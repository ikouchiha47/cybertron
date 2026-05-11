#pragma once
#include <stdint.h>

// LOG_EPOCH is the Unix-epoch seconds value the firmware adds millis()/1000 to
// when stamping log lines. Sourced in priority order:
//
//   1. COMPILE_EPOCH macro injected by `make build` via --build-property
//      (set to `date -u +%s` at build time → real UTC).
//   2. Fallback: parse __DATE__ / __TIME__ at compile time. These are filled
//      by the compiler with the build host's LOCAL time, not UTC, so the
//      stamp will be off by the host's TZ offset. Better than nothing for
//      Arduino-IDE builds where COMPILE_EPOCH isn't injected.
//
// Both paths give a sensible recent anchor; the previous fake 2011-11-11
// value was a leftover that drifted to 2052 due to a separate math bug.

#ifndef COMPILE_EPOCH
namespace _log_epoch {
  // __DATE__ = "Mmm DD YYYY"   (e.g. "May 10 2026" — note: " 1" for single-digit days)
  // __TIME__ = "HH:MM:SS"      (e.g. "14:32:07")
  constexpr int year() {
    return (__DATE__[7] - '0') * 1000 + (__DATE__[8] - '0') * 100 +
           (__DATE__[9] - '0') * 10  +  (__DATE__[10] - '0');
  }
  constexpr int month() {
    return (__DATE__[0]=='J' && __DATE__[1]=='a') ? 1 :
           (__DATE__[0]=='F') ? 2 :
           (__DATE__[0]=='M' && __DATE__[2]=='r') ? 3 :
           (__DATE__[0]=='A' && __DATE__[1]=='p') ? 4 :
           (__DATE__[0]=='M') ? 5 :
           (__DATE__[0]=='J' && __DATE__[2]=='n') ? 6 :
           (__DATE__[0]=='J') ? 7 :
           (__DATE__[0]=='A') ? 8 :
           (__DATE__[0]=='S') ? 9 :
           (__DATE__[0]=='O') ? 10 :
           (__DATE__[0]=='N') ? 11 : 12;
  }
  constexpr int day() {
    return ((__DATE__[4]==' ') ? 0 : (__DATE__[4]-'0')*10) + (__DATE__[5]-'0');
  }
  constexpr int hour()   { return (__TIME__[0]-'0')*10 + (__TIME__[1]-'0'); }
  constexpr int minute() { return (__TIME__[3]-'0')*10 + (__TIME__[4]-'0'); }
  constexpr int second() { return (__TIME__[6]-'0')*10 + (__TIME__[7]-'0'); }

  constexpr bool isLeap(int y) { return (y%4==0 && (y%100!=0 || y%400==0)); }

  // Cumulative days before month m (1-indexed) in year y. Single-expression
  // ternary chain so this stays C++11-constexpr-compatible.
  constexpr int daysBeforeMonth(int y, int m) {
    return (m<=1) ? 0 :
           (m==2) ? 31 :
           (m==3) ? (isLeap(y) ? 60  : 59 ) :
           (m==4) ? (isLeap(y) ? 91  : 90 ) :
           (m==5) ? (isLeap(y) ? 121 : 120) :
           (m==6) ? (isLeap(y) ? 152 : 151) :
           (m==7) ? (isLeap(y) ? 182 : 181) :
           (m==8) ? (isLeap(y) ? 213 : 212) :
           (m==9) ? (isLeap(y) ? 244 : 243) :
           (m==10)? (isLeap(y) ? 274 : 273) :
           (m==11)? (isLeap(y) ? 305 : 304) :
                    (isLeap(y) ? 335 : 334);
  }

  // Leap years strictly before year y, since 1970. Closed form so it stays
  // constexpr in C++11. Subtract leap-day count up to and including 1969.
  constexpr uint32_t leapYearsBefore(int y) {
    return (uint32_t)((y-1)/4) - (uint32_t)((y-1)/100) + (uint32_t)((y-1)/400) - 477UL;
  }

  constexpr uint32_t daysFromUnixEpoch(int y, int m, int d) {
    return (uint32_t)(y - 1970) * 365UL + leapYearsBefore(y) +
           (uint32_t)daysBeforeMonth(y, m) + (uint32_t)(d - 1);
  }

  constexpr uint32_t buildUnixEpoch() {
    return daysFromUnixEpoch(year(), month(), day()) * 86400UL +
           (uint32_t)hour() * 3600UL +
           (uint32_t)minute() * 60UL +
           (uint32_t)second();
  }
}
#define COMPILE_EPOCH (_log_epoch::buildUnixEpoch())
#endif

static constexpr uint32_t LOG_EPOCH = COMPILE_EPOCH;

inline void logTimestamp() {
  uint32_t totalSec = LOG_EPOCH + millis() / 1000;
  uint32_t s  = totalSec % 60; totalSec /= 60;
  uint32_t mi = totalSec % 60; totalSec /= 60;
  uint32_t h  = totalSec % 24; totalSec /= 24;
  uint32_t days = totalSec;     // days since 1970-01-01

  // Walk year forward from 1970, subtracting year length until `days` fits.
  uint32_t y = 1970;
  for (;;) {
    uint32_t diy = 365 + ((y%4==0 && (y%100!=0||y%400==0)) ? 1 : 0);
    if (days < diy) break;
    days -= diy;
    y++;
  }
  static const uint8_t dom[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  uint32_t mo = 0;
  for (;;) {
    uint8_t dim = dom[mo] + ((mo==1 && (y%4==0 && (y%100!=0||y%400==0))) ? 1 : 0);
    if (days < dim) break;
    days -= dim;
    mo++;
  }

  uint32_t ms = millis() % 1000;
  Serial.printf("[%04u-%02u-%02u %02u:%02u:%02u.%03u] ",
                (unsigned)y, (unsigned)(mo+1), (unsigned)(days+1),
                (unsigned)h, (unsigned)mi, (unsigned)s, (unsigned)ms);
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
