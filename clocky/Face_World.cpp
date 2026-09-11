#include "Face_World.h"
#include <ctype.h>
#include <stdlib.h>

// Small sun (day) / crescent moon (night) glyph centered at (x, y).
// Ray offsets are capped at 4px and the caller must keep y >= 4 — u8g2's
// coordinate type is unsigned, so a negative y (e.g. y=2, ray to y-4=-2)
// silently wraps to a huge value instead of clipping, drawing garbage
// across the whole screen.
static void drawDayNightIcon(U8G2 &display, int x, int y, bool isDay) {
  if (isDay) {
    display.drawDisc(x, y, 2);
    display.drawLine(x - 4, y, x - 2, y);
    display.drawLine(x + 2, y, x + 4, y);
    display.drawLine(x, y - 4, x, y - 2);
    display.drawLine(x, y + 2, x, y + 4);
  } else {
    display.drawDisc(x, y, 2);
    display.setDrawColor(0);
    display.drawDisc(x + 1, y - 1, 2);
    display.setDrawColor(1);
  }
}

// ctx.time is already the primary/local zone. To also show the secondary
// "world" zone, we temporarily point the C library's TZ env at it, ask for
// the same epoch instant in that zone, then switch back — configTzTime()
// already keeps ctx.tzPosix as the "real" global TZ the rest of the app
// expects, so this must always restore it before returning.
static struct tm computeSecondaryTime(const WatchFaceContext &ctx) {
  time_t now = time(nullptr);
  struct tm secondary;
  setenv("TZ", ctx.tz2Posix, 1);
  tzset();
  localtime_r(&now, &secondary);
  setenv("TZ", ctx.tzPosix, 1);
  tzset();
  return secondary;
}

// zone         icon (small, centered)
// hh:mm              mm/dd   <- world time + date
// -----------------------------------
// hh:mm                zone <- local time (big), zone label top-right
//                        ss <- local seconds
// mm/dd                 day <- local date + day
void renderWorldFace(const WatchFaceContext &ctx) {
  U8G2 &display = ctx.display;
  const struct tm &local = ctx.time;
  struct tm world = computeSecondaryTime(ctx);

  char worldTime[6], worldDate[6];
  strftime(worldTime, sizeof(worldTime), "%H:%M", &world);
  strftime(worldDate, sizeof(worldDate), "%m/%d", &world);

  char localTime[6], localDate[6], localDay[4], localSec[3];
  strftime(localTime, sizeof(localTime), "%H:%M", &local);
  strftime(localDate, sizeof(localDate), "%m/%d", &local);
  strftime(localDay, sizeof(localDay), "%a", &local);
  strftime(localSec, sizeof(localSec), "%S", &local);
  for (int i = 0; localDay[i]; i++) localDay[i] = toupper(localDay[i]);

  display.clearBuffer();

  // --- Section 1: secondary/world zone (small), y 0-22 ---
  // Zone label on the left, day/night icon centered — matches the layout
  // pattern used by the Classic face's top row.
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(2, 9, ctx.tz2Label);
  drawDayNightIcon(display, 64, 6, world.tm_hour >= 6 && world.tm_hour < 18);

  display.setFont(u8g2_font_7x14B_tf);
  display.drawStr(2, 20, worldTime);

  display.setFont(u8g2_font_6x10_tf);
  int worldDateW = display.getStrWidth(worldDate);
  display.drawStr(126 - worldDateW, 20, worldDate);

  display.drawHLine(0, 23, 128);

  // --- Section 2: local zone (big), y 23-64 ---
  // ctx.tzLabel is guaranteed <=4 chars (see Timezones.h — real zone
  // abbreviations like "IST"/"EST", not city names), so it always fits
  // this narrow corner column without truncation.
  display.setFont(u8g2_font_logisoso20_tn);
  display.drawStr(0, 46, localTime);

  display.setFont(u8g2_font_6x10_tf);
  int localLabelW = display.getStrWidth(ctx.tzLabel);
  display.drawStr(126 - localLabelW, 34, ctx.tzLabel);
  int localSecW = display.getStrWidth(localSec);
  display.drawStr(126 - localSecW, 44, localSec);

  display.setFont(u8g2_font_7x14B_tf);
  display.drawStr(2, 62, localDate);
  int localDayW = display.getStrWidth(localDay);
  display.drawStr(126 - localDayW, 62, localDay);

  display.sendBuffer();
}
