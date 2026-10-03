package com.doorcam.app

import android.graphics.Bitmap
import kotlin.math.abs
import kotlin.math.max

/**
 * Cheap per-camera motion gate.
 *
 * Runs on the already-decoded bitmap (no extra JPEG decode): it samples the
 * frame into a small grayscale grid, compares it against an exponential-moving
 * background, and reports whether the frame is worth running inference on.
 *
 * Features:
 *  - adaptive threshold derived from a rolling noise floor
 *  - forced keyframe every [keyframeIntervalMs] so a stationary-but-present
 *    person is still re-evaluated
 *  - lower effective threshold for dark / IR frames
 *
 * Not thread-safe: all calls must happen on the engine's single pipeline thread.
 */
class MotionGate(
    private val gridW: Int = GRID_W,
    private val gridH: Int = GRID_H,
    private val keyframeIntervalMs: Long = KEYFRAME_INTERVAL_MS,
) {

    data class Result(val motion: Boolean, val night: Boolean, val meanLuma: Double)

    private val gray = FloatArray(gridW * gridH)
    private val background = FloatArray(gridW * gridH)
    private var backgroundReady = false
    private var noiseFloor = INITIAL_NOISE_FLOOR
    private var lastKeyframeAt = 0L

    private var pixels = IntArray(0)
    private var srcW = 0
    private var srcH = 0

    fun reset() {
        backgroundReady = false
        noiseFloor = INITIAL_NOISE_FLOOR
        lastKeyframeAt = 0L
    }

    fun process(bitmap: Bitmap, ts: Long): Result {
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return Result(motion = true, night = false, meanLuma = 0.0)

        if (srcW != w || srcH != h || pixels.size != w * h) {
            pixels = IntArray(w * h)
            srcW = w
            srcH = h
        }
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        var lumaSum = 0.0
        for (gy in 0 until gridH) {
            val sy = (((gy + 0.5) * h) / gridH).toInt().coerceIn(0, h - 1)
            for (gx in 0 until gridW) {
                val sx = (((gx + 0.5) * w) / gridW).toInt().coerceIn(0, w - 1)
                val p = pixels[sy * w + sx]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                val luma = 0.299 * r + 0.587 * g + 0.114 * b
                gray[gy * gridW + gx] = luma.toFloat()
                lumaSum += luma
            }
        }
        val meanLuma = lumaSum / (gridW * gridH)
        val night = meanLuma < NIGHT_LUMA
        val keyframe = ts - lastKeyframeAt >= keyframeIntervalMs
        if (keyframe) lastKeyframeAt = ts

        if (!backgroundReady) {
            System.arraycopy(gray, 0, background, 0, gray.size)
            backgroundReady = true
            // Force the first frame through so a person already in frame is seen.
            return Result(motion = true, night = night, meanLuma = meanLuma)
        }

        var diffSum = 0.0
        for (i in gray.indices) {
            diffSum += abs(gray[i] - background[i])
        }
        val meanDiff = diffSum / gray.size
        val k = if (night) NIGHT_K else DAY_K
        val threshold = max(MIN_THRESHOLD, noiseFloor * k)
        val motion = meanDiff > threshold || keyframe

        // Track the noise floor only on quiet/keyframe frames.
        if (!motion || keyframe) {
            noiseFloor = 0.9 * noiseFloor + 0.1 * meanDiff
        }

        // Slow background adaptation; faster when static, near-frozen while moving.
        val alpha = if (motion) 0.02f else 0.08f
        for (i in gray.indices) {
            background[i] += alpha * (gray[i] - background[i])
        }

        return Result(motion = motion, night = night, meanLuma = meanLuma)
    }

    companion object {
        private const val GRID_W = 32
        private const val GRID_H = 24
        private const val KEYFRAME_INTERVAL_MS = 5_000L

        private const val NIGHT_LUMA = 55.0
        private const val DAY_K = 3.0
        private const val NIGHT_K = 2.0
        private const val MIN_THRESHOLD = 6.0
        private const val INITIAL_NOISE_FLOOR = 2.0
    }
}
