package com.doorcam.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.RectF
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetector

/**
 * MediaPipe Tasks Vision person detector backed by EfficientDet-Lite0 (float32),
 * loaded from the app assets.
 *
 * Thread affinity: [initialize] and [detect] MUST be called on the same single
 * thread (the engine's pipeline thread). MediaPipe tasks are not thread-safe and
 * the native graph is bound to its creating thread.
 */
class MediaPipePersonDetector(
    private val context: Context,
    private val modelAssetPath: String = DEFAULT_MODEL_ASSET,
    private val scoreThreshold: Float = DEFAULT_SCORE_THRESHOLD,
    private val maxResults: Int = DEFAULT_MAX_RESULTS,
    private val minBoxAreaFraction: Float = DEFAULT_MIN_BOX_AREA_FRACTION,
    private val minAspect: Float = DEFAULT_MIN_ASPECT,
    private val maxAspect: Float = DEFAULT_MAX_ASPECT,
) : PersonDetector {

    companion object {
        private const val TAG = "DoorCam"
        const val DEFAULT_MODEL_ASSET = "efficientdet_lite0.tflite"
        const val DEFAULT_SCORE_THRESHOLD = 0.30f
        const val DEFAULT_MAX_RESULTS = 5

        /** Reject tiny blobs — box must cover at least 0.2% of the frame. */
        const val DEFAULT_MIN_BOX_AREA_FRACTION = 0.002f

        /** Human-shaped boxes: height/width in [1.2, 6.0]. */
        const val DEFAULT_MIN_ASPECT = 1.2f
        const val DEFAULT_MAX_ASPECT = 6.0f
    }

    @Volatile
    override var ready: Boolean = false
        private set

    private var detector: ObjectDetector? = null

    /**
     * Loads the model and creates the native detector. Must run on the pipeline
     * thread. Never throws — on failure [ready] stays false and the engine runs
     * degraded (no detections).
     */
    fun initialize() {
        if (ready) return
        try {
            // NOTE: the public Java Tasks API does not expose numThreads for the
            // CPU delegate in this version; the interpreter thread count comes
            // from the model/delegate defaults. Delegate is explicitly CPU.
            val baseOptions = BaseOptions.builder()
                .setModelAssetPath(modelAssetPath)
                .setDelegate(Delegate.CPU)
                .build()

            val options = ObjectDetector.ObjectDetectorOptions.builder()
                .setBaseOptions(baseOptions)
                .setRunningMode(RunningMode.IMAGE)
                .setScoreThreshold(scoreThreshold)
                .setMaxResults(maxResults)
                .setCategoryAllowlist(listOf("person"))
                .build()

            detector = ObjectDetector.createFromOptions(context, options)
            ready = true
            Log.i(TAG, "[engine] detector ready model=$modelAssetPath score=$scoreThreshold max=$maxResults")
        } catch (t: Throwable) {
            Log.e(TAG, "[engine] detector init failed; running degraded: ${t.message}", t)
            detector = null
            ready = false
        }
    }

    override fun detect(bitmap: Bitmap, width: Int, height: Int): List<RawDetection> {
        val d = detector ?: return emptyList()
        if (width <= 0 || height <= 0 || bitmap.isRecycled) return emptyList()

        var mpImage: MPImage? = null
        return try {
            mpImage = BitmapImageBuilder(bitmap).build()
            val result = d.detect(mpImage)
            val detections = result.detections()
            if (detections.isNullOrEmpty()) return emptyList()

            val out = ArrayList<RawDetection>(detections.size)
            for (det in detections) {
                val category = det.categories()?.maxByOrNull { it.score() } ?: continue
                val score = category.score()
                if (score < scoreThreshold) continue

                val box: RectF = det.boundingBox() ?: continue
                val nw = box.width() / width
                val nh = box.height() / height
                if (nw <= 0f || nh <= 0f) continue

                val area = nw * nh
                if (area < minBoxAreaFraction) continue

                val aspect = nh / nw
                if (aspect < minAspect || aspect > maxAspect) continue

                out.add(
                    RawDetection(
                        score = score,
                        x1 = (box.left / width).coerceIn(0f, 1f),
                        y1 = (box.top / height).coerceIn(0f, 1f),
                        x2 = (box.right / width).coerceIn(0f, 1f),
                        y2 = (box.bottom / height).coerceIn(0f, 1f),
                    )
                )
            }
            out
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] detect failed: ${t.message}")
            emptyList()
        } finally {
            try { mpImage?.close() } catch (_: Throwable) {}
        }
    }

    override fun close() {
        ready = false
        try { detector?.close() } catch (_: Throwable) {}
        detector = null
    }
}
