#pragma once

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
  #define LOG_E(fmt, ...) do { Serial.print("[ERROR] "); Serial.printf(fmt "\n", ##__VA_ARGS__); } while(0)
#else
  #define LOG_E(fmt, ...) do {} while(0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_INFO
  #define LOG_I(fmt, ...) do { Serial.printf(fmt "\n", ##__VA_ARGS__); } while(0)
#else
  #define LOG_I(fmt, ...) do {} while(0)
#endif

#if LOG_LEVEL >= LOG_LEVEL_DEBUG
  #define LOG_D(fmt, ...) do { Serial.print("[DEBUG] "); Serial.printf(fmt "\n", ##__VA_ARGS__); } while(0)
#else
  #define LOG_D(fmt, ...) do {} while(0)
#endif
