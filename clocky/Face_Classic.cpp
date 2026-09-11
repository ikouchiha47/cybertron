#include "Face_Classic.h"
#include <ctype.h>

// Small sun (day) / crescent moon (night) glyph centered at (x, y).
static void drawDayNightIcon(U8G2 &display, int x, int y, bool isDay) {
  if (isDay) {
    display.drawDisc(x, y, 2);
    display.drawLine(x - 4, y - 4, x - 3, y - 3);
    display.drawLine(x + 3, y - 3, x + 4, y - 4);
    display.drawLine(x - 3, y + 3, x - 4, y + 4);
    display.drawLine(x + 3, y + 3, x + 4, y + 4);
  } else {
    display.drawDisc(x, y, 3);
    display.setDrawColor(0);
    display.drawDisc(x + 2, y - 1, 3);
    display.setDrawColor(1);
  }
}

// zone (icon) mm/dd
// -----------------
//       time
// -----------------
// day          sec
void renderClassicFace(const WatchFaceContext &ctx) {
  U8G2 &display = ctx.display;
  const struct tm &t = ctx.time;

  char timeBuf[6];
  char dateBuf[6];
  char dayBuf[4];
  char secBuf[3];
  strftime(timeBuf, sizeof(timeBuf), "%H:%M", &t);
  strftime(dateBuf, sizeof(dateBuf), "%m/%d", &t);
  strftime(dayBuf, sizeof(dayBuf), "%a", &t);
  strftime(secBuf, sizeof(secBuf), "%S", &t);
  for (int i = 0; dayBuf[i]; i++) dayBuf[i] = toupper(dayBuf[i]);

  display.clearBuffer();

  // Row 1: zone label (left), day/night icon (center), date (right)
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(2, 8, ctx.tzLabel);
  drawDayNightIcon(display, 64, 6, t.tm_hour >= 6 && t.tm_hour < 18);
  int dateW = display.getStrWidth(dateBuf);
  display.drawStr(126 - dateW, 8, dateBuf);

  display.drawHLine(0, 12, 128);

  // Row 2: big centered time
  display.setFont(u8g2_font_logisoso28_tn);
  int timeW = display.getStrWidth(timeBuf);
  display.drawStr((128 - timeW) / 2, 43, timeBuf);

  display.drawHLine(0, 47, 128);

  // Row 3: day (left), seconds (right)
  display.setFont(u8g2_font_7x14B_tf);
  display.drawStr(2, 62, dayBuf);
  int secW = display.getStrWidth(secBuf);
  display.drawStr(126 - secW, 62, secBuf);

  display.sendBuffer();
}
