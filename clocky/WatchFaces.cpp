#include "WatchFaces.h"
#include <string.h>

#include "Face_Classic.h"
#include "Face_World.h"
// Add new faces here, e.g.:
// #include "Face_YourName.h"

const WatchFaceDef kWatchFaces[] = {
  { "classic", "Classic", renderClassicFace },
  { "world", "World dual-time", renderWorldFace },
};
const size_t kWatchFaceCount = sizeof(kWatchFaces) / sizeof(kWatchFaces[0]);

size_t watchFaceIndexForId(const char *id) {
  for (size_t i = 0; i < kWatchFaceCount; i++) {
    if (strcmp(kWatchFaces[i].id, id) == 0) return i;
  }
  return 0;
}
