#pragma once
#include <U8g2lib.h>
#include <time.h>

// Everything a watch face needs to draw itself. Faces never touch the
// global display/settings objects directly — this keeps each face file
// self-contained and swappable.
struct WatchFaceContext {
  U8G2 &display;
  const struct tm &time;   // primary/local time, already resolved
  const char *tzLabel;     // primary zone's short label, e.g. "IST"
  const char *tzPosix;     // primary zone's POSIX TZ string (used to restore
                            // the global TZ env after a face computes a second
                            // zone's time via setenv/tzset — see Face_World.cpp)
  const char *tz2Label;    // secondary/world zone's short label, e.g. "LONDON"
  const char *tz2Posix;    // secondary/world zone's POSIX TZ string
};

typedef void (*WatchFaceRenderFn)(const WatchFaceContext &ctx);

struct WatchFaceDef {
  const char *id;             // stable key stored in flash, never shown to the user
  const char *name;           // shown in the web UI dropdown
  WatchFaceRenderFn render;
};
