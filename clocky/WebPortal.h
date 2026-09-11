#pragma once
#include <Arduino.h>

// Starts the settings web server. Call once after WiFi is connected.
void webPortalBegin();

// Must be called from loop() if using ESPAsyncWebServer this is a no-op,
// kept for symmetry / future non-async fallback.
void webPortalLoop();

// Current settings, loaded from flash at boot and updated live by the portal.
extern String currentTz;    // primary/local timezone (POSIX TZ string)
extern String currentTzLabel;  // short label for the primary zone, e.g. "LOCAL"
extern String currentTz2;   // secondary/world timezone (POSIX TZ string)
extern String currentTz2Label; // short label for the secondary zone, e.g. "LONDON" (reserved for a future dual-timezone face)
extern String currentFaceId; // id of the active watch face, see WatchFaces.h registry

// True once the settings page (or the physical button) has changed something
// the main loop should re-apply (e.g. a new timezone requires re-calling
// configTzTime).
extern volatile bool settingsDirty;

// Persists the current currentFaceId to flash. Call after changing it
// outside of the web portal (e.g. from the physical face-toggle button).
void persistFaceSelection();
