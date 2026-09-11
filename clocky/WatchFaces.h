#pragma once
#include "WatchFace.h"

// The registry of all available watch faces. To add a new face:
//   1. Create Face_YourName.h/.cpp implementing a renderYourNameFace() function
//      with signature WatchFaceRenderFn (see WatchFace.h).
//   2. #include "Face_YourName.h" in WatchFaces.cpp and add an entry to kWatchFaces.
// The web settings page and the on-device face list are both generated from
// this registry, so nothing else needs to change.
extern const WatchFaceDef kWatchFaces[];
extern const size_t kWatchFaceCount;

// Returns the index of the watch face with the given id, or 0 (the first
// registered face) if no match is found — e.g. after a face was removed
// from the registry but an old id is still saved in flash.
size_t watchFaceIndexForId(const char *id);
