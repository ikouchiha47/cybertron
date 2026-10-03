package com.doorcam.app

import android.graphics.Bitmap

/**
 * A single raw person detection, with an axis-aligned box normalized to [0, 1]
 * relative to the frame that was passed to [PersonDetector.detect].
 *
 * (x1, y1) is the top-left corner, (x2, y2) the bottom-right corner.
 */
data class RawDetection(
    val score: Float,
    val x1: Float,
    val y1: Float,
    val x2: Float,
    val y2: Float,
)

/**
 * Synchronous person detector abstraction.
 *
 * Implementations are NOT thread-safe: every call to [detect] must happen on the
 * single pipeline thread that created the detector (MediaPipe tasks have thread
 * affinity). [ready] may be read from any thread.
 */
interface PersonDetector {
    /** True once the underlying model has loaded successfully; never throws. */
    val ready: Boolean

    /**
     * Runs inference on [bitmap]. [width] / [height] are the bitmap dimensions
     * (passed explicitly to avoid repeated getters). Returns an empty list on
     * failure; must never throw for a bad/failed frame.
     */
    fun detect(bitmap: Bitmap, width: Int, height: Int): List<RawDetection>

    /** Releases native resources. Safe to call more than once. */
    fun close()
}
