package com.doorcam.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * Decodes MJPEG/JPEG frames into mutable ARGB_8888 bitmaps whose long side is
 * approximately [targetLongSide] pixels, reusing the previously decoded bitmap
 * as `inBitmap` whenever its dimensions still match.
 *
 * One instance per camera. Not thread-safe: all calls must happen on the single
 * pipeline thread (the bitmap handed out is retained and returned to the caller
 * again on the next decode, so callers must not retain or recycle it).
 */
class FrameDecoder(private val targetLongSide: Int = TARGET_LONG_SIDE) {

    companion object {
        const val TARGET_LONG_SIDE = 320
    }

    private var reusable: Bitmap? = null

    /** Last decoded width/height, or 0 when nothing has been decoded yet. */
    var lastWidth: Int = 0
        private set
    var lastHeight: Int = 0
        private set

    /**
     * Decodes [jpeg]. Returns null when the bytes are not a decodable image.
     * The returned bitmap is owned by this decoder and reused on the next call.
     */
    fun decode(jpeg: ByteArray): Bitmap? {
        if (jpeg.isEmpty()) return null

        // Pass 1: read the source dimensions only.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        } catch (_: Throwable) {
            return null
        }
        val srcW = bounds.outWidth
        val srcH = bounds.outHeight
        if (srcW <= 0 || srcH <= 0) return null

        val sample = computeInSampleSize(srcW, srcH, targetLongSide)
        val targetW = (srcW + sample - 1) / sample
        val targetH = (srcH + sample - 1) / sample

        val previous = reusable
        val canReuse = previous != null &&
            !previous.isRecycled &&
            previous.isMutable &&
            previous.width == targetW &&
            previous.height == targetH

        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inMutable = true
            if (canReuse) inBitmap = previous
        }

        val decoded: Bitmap? = try {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, options)
        } catch (t: Throwable) {
            android.util.Log.w("DoorCam", "[engine] frame decode failed: ${t.message}")
            null
        }
        if (decoded == null) return null

        // Recycle a displaced bitmap: either Android ignored inBitmap and
        // allocated a new one, or the previous buffer no longer fits.
        if (previous != null && previous !== decoded && !previous.isRecycled) {
            previous.recycle()
        }

        reusable = decoded
        lastWidth = decoded.width
        lastHeight = decoded.height
        return decoded
    }

    /** Recycles the retained bitmap. Safe to call more than once. */
    fun release() {
        val b = reusable
        reusable = null
        if (b != null && !b.isRecycled) b.recycle()
        lastWidth = 0
        lastHeight = 0
    }

    private fun computeInSampleSize(w: Int, h: Int, target: Int): Int {
        val longSide = maxOf(w, h)
        var sample = 1
        while (longSide / (sample * 2) >= target) {
            sample *= 2
        }
        return sample
    }
}
