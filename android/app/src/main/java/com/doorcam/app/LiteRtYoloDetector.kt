package com.doorcam.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.util.Log
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * LiteRT (TensorFlow Lite) person detector backed by a YOLO11n export
 * (Ultralytics -> ONNX -> TFLite, raw detection head, no TFLite NMS metadata).
 *
 * This is a drop-in sibling of [MediaPipePersonDetector]: both implement
 * [PersonDetector] and are selected by [DoorCamEngine.setDetectionConfig]
 * (`{ detector: "yolo11n" }`). Neither replaces the other.
 *
 * Model I/O (the shape actually shipped in `assets/yolo11n.tflite`):
 *   input  : float32 [1, 320, 320, 3]  NHWC, RGB, values 0..1 (letterboxed)
 *   output : float32 [1, 84, 2100]     raw, one row per channel:
 *              rows 0..3   cx, cy, w, h in input pixels (no objectness row)
 *              row  4      person (COCO class 0) score, sigmoid applied
 *              rows 5..83  remaining COCO classes
 *
 * The layout is discovered from the interpreter's tensors at init, so NCHW
 * inputs ([1,3,H,W]) and a channel-last output ([1,2100,84]) are also handled;
 * the raw boxes/scores are decoded here and never rely on model metadata.
 *
 * Thread affinity: [initialize] and [detect] MUST be called on the same single
 * thread (the engine's pipeline thread) — the interpreter and its scratch
 * buffers are not thread-safe. Never throws: on any failure [ready] stays
 * false and [detect] returns an empty list (degraded-safe), exactly like the
 * MediaPipe path.
 */
class LiteRtYoloDetector(
    private val context: Context,
    private val modelAssetPath: String = DEFAULT_MODEL_ASSET,
    private val scoreThreshold: Float = DEFAULT_SCORE_THRESHOLD,
    private val iouThreshold: Float = DEFAULT_IOU_THRESHOLD,
    private val maxResults: Int = DEFAULT_MAX_RESULTS,
    private val numThreads: Int = DEFAULT_NUM_THREADS,
    private val minBoxAreaFraction: Float = DEFAULT_MIN_BOX_AREA_FRACTION,
    private val minAspect: Float = DEFAULT_MIN_ASPECT,
    private val maxAspect: Float = DEFAULT_MAX_ASPECT,
    private val padValue: Int = DEFAULT_PAD_VALUE,
) : PersonDetector {

    companion object {
        private const val TAG = "DoorCam"
        const val DEFAULT_MODEL_ASSET = "yolo11n.tflite"

        /** Must match the exported model's input extent. */
        const val DEFAULT_INPUT_SIZE = 320

        /**
         * Same defaults as [MediaPipePersonDetector] so both detectors are
         * directly comparable on-device via the existing `setDetectionConfig`.
         */
        const val DEFAULT_SCORE_THRESHOLD = 0.30f
        const val DEFAULT_MAX_RESULTS = 5
        const val DEFAULT_MIN_BOX_AREA_FRACTION = 0.002f
        const val DEFAULT_MIN_ASPECT = 1.2f
        const val DEFAULT_MAX_ASPECT = 6.0f

        /** Ultralytics default NMS IoU for the detection head. */
        const val DEFAULT_IOU_THRESHOLD = 0.45f

        /** CPU delegate thread count. */
        const val DEFAULT_NUM_THREADS = 2

        /** YOLO letterbox gray fill (ultralytics default). */
        const val DEFAULT_PAD_VALUE = 114

        private const val PERSON_CLASS_INDEX = 0
        private const val BOX_CHANNELS = 4

        /** Hard cap before NMS to keep the O(n^2) pass bounded on bad frames. */
        private const val MAX_CANDIDATES = 400
    }

    @Volatile
    override var ready: Boolean = false
        private set

    private var interpreter: Interpreter? = null

    // Input geometry / layout.
    private var inputWidth = 0
    private var inputHeight = 0
    private var inputNchw = false

    // Output geometry / layout.
    private var outputAnchors = 0
    private var outputChannels = 0
    private var outputChannelLast = false

    // Reusable buffers (allocated once in initialize, on the pipeline thread).
    private var inputBuffer: ByteBuffer? = null
    private var outputBuffer: ByteBuffer? = null
    private var rawOutput: FloatArray? = null
    private var pixels: IntArray? = null
    private var scratch: Bitmap? = null
    private var canvas: Canvas? = null
    private var paint: Paint? = null
    private val dstRect = Rect()

    /**
     * Loads the model and creates the interpreter. Must run on the pipeline
     * thread. Never throws.
     */
    fun initialize() {
        if (ready) return
        var created: Interpreter? = null
        try {
            val modelBuffer = loadModelBuffer(modelAssetPath)
            val options = Interpreter.Options().apply { setNumThreads(numThreads) }
            created = Interpreter(modelBuffer, options)

            // ---- input tensor ----
            val inTensor = created.getInputTensor(0)
            val inShape = inTensor.shape()
            if (inShape.size != 4) {
                Log.e(TAG, "[engine] yolo unsupported input rank=${inShape.size}")
                created.close()
                return
            }
            val dim1 = inShape[1]
            val dim3 = inShape[3]
            val nhwc = dim3 == 3
            val nchw = dim1 == 3
            if (!nhwc && !nchw) {
                Log.e(TAG, "[engine] yolo unsupported input shape=${inShape.joinToString()}")
                created.close()
                return
            }
            inputNchw = nchw
            inputHeight = if (nhwc) inShape[1] else inShape[2]
            inputWidth = if (nhwc) inShape[2] else inShape[3]
            if (inputWidth <= 0 || inputHeight <= 0) {
                Log.e(TAG, "[engine] yolo invalid input dims ${inputWidth}x$inputHeight")
                created.close()
                return
            }
            if (inTensor.dataType() != DataType.FLOAT32) {
                Log.e(TAG, "[engine] yolo unsupported input dtype=${inTensor.dataType()}")
                created.close()
                return
            }

            // ---- output tensor (raw head, shape [1, C, A] or [1, A, C]) ----
            val outTensor = created.getOutputTensor(0)
            val outShape = outTensor.shape()
            if (outShape.size < 2) {
                Log.e(TAG, "[engine] yolo unsupported output rank=${outShape.size}")
                created.close()
                return
            }
            val a = outShape[outShape.size - 2]
            val b = outShape[outShape.size - 1]
            outputChannels = min(a, b)
            outputAnchors = max(a, b)
            outputChannelLast = b == outputChannels && a != b
            if (outTensor.dataType() != DataType.FLOAT32 ||
                outputChannels <= BOX_CHANNELS ||
                outputAnchors <= 0
            ) {
                Log.e(TAG, "[engine] yolo unsupported output dtype=${outTensor.dataType()} shape=${outShape.joinToString()}")
                created.close()
                return
            }

            // ---- reusable buffers ----
            val inBytes = inputWidth.toLong() * inputHeight * 3L * 4L
            inputBuffer = ByteBuffer.allocateDirect(inBytes.toInt()).order(ByteOrder.nativeOrder())
            val outFloats = outputAnchors.toLong() * outputChannels
            val outBytes = outFloats * 4L
            outputBuffer = ByteBuffer.allocateDirect(outBytes.toInt()).order(ByteOrder.nativeOrder())
            rawOutput = FloatArray(outFloats.toInt())
            pixels = IntArray(inputWidth * inputHeight)
            val bmp = Bitmap.createBitmap(inputWidth, inputHeight, Bitmap.Config.ARGB_8888)
            scratch = bmp
            canvas = Canvas(bmp)
            paint = Paint(Paint.FILTER_BITMAP_FLAG)
            dstRect.setEmpty()

            interpreter = created
            ready = true
            Log.i(
                TAG,
                "[engine] yolo detector ready model=$modelAssetPath in=${inputWidth}x$inputHeight " +
                    "layout=${if (inputNchw) "NCHW" else "NHWC"} out=[C=$outputChannels A=$outputAnchors " +
                    "last=$outputChannelLast] threads=$numThreads score=$scoreThreshold iou=$iouThreshold",
            )
        } catch (t: Throwable) {
            Log.e(TAG, "[engine] yolo detector init failed; running degraded: ${t.message}", t)
            try { created?.close() } catch (_: Throwable) {}
            releaseBuffers()
            interpreter = null
            ready = false
        }
    }

    override fun detect(bitmap: Bitmap, width: Int, height: Int): List<RawDetection> {
        val itp = interpreter ?: return emptyList()
        if (!ready || width <= 0 || height <= 0 || bitmap.isRecycled) return emptyList()
        val inBuf = inputBuffer ?: return emptyList()
        val outBuf = outputBuffer ?: return emptyList()
        val raw = rawOutput ?: return emptyList()

        return try {
            if (!preprocess(bitmap, width, height, inBuf)) return emptyList()

            inBuf.rewind()
            outBuf.rewind()
            itp.run(inBuf, outBuf)
            outBuf.rewind()
            outBuf.asFloatBuffer().get(raw)

            val candidates = decode(raw, width, height)
            nms(candidates)
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] yolo detect failed: ${t.message}")
            emptyList()
        }
    }

    // ------------------------------------------------------------------
    // Preprocessing
    // ------------------------------------------------------------------

    /**
     * Letterboxes [bitmap] into the model input (scale to fit, center pad with
     * gray [padValue]) and writes RGB floats in [0,1] into [inBuf] using the
     * model's input layout. Returns false on any failure.
     */
    private fun preprocess(bitmap: Bitmap, width: Int, height: Int, inBuf: ByteBuffer): Boolean {
        val cv = canvas ?: return false
        val px = pixels ?: return false
        val pt = paint ?: return false
        val scale = min(inputWidth.toFloat() / width, inputHeight.toFloat() / height)
        if (scale <= 0f) return false
        val newW = (width * scale).roundToInt().coerceAtLeast(1)
        val newH = (height * scale).roundToInt().coerceAtLeast(1)
        val padX = (inputWidth - newW) / 2
        val padY = (inputHeight - newH) / 2

        cv.drawColor(Color.rgb(padValue, padValue, padValue))
        dstRect.set(padX, padY, padX + newW, padY + newH)
        cv.drawBitmap(bitmap, null, dstRect, pt)

        scratch?.getPixels(px, 0, inputWidth, 0, 0, inputWidth, inputHeight)

        val inv = 1f / 255f
        if (inputNchw) {
            val plane = inputWidth * inputHeight
            var p = 0
            var i = 0
            while (p < plane) {
                val c = px[p]
                inBuf.putFloat(i, ((c shr 16) and 0xFF) * inv)
                inBuf.putFloat(plane + i, ((c shr 8) and 0xFF) * inv)
                inBuf.putFloat(2 * plane + i, (c and 0xFF) * inv)
                p++
                i++
            }
        } else {
            var p = 0
            val total = inputWidth * inputHeight
            while (p < total) {
                val c = px[p]
                inBuf.putFloat(((c shr 16) and 0xFF) * inv)
                inBuf.putFloat(((c shr 8) and 0xFF) * inv)
                inBuf.putFloat((c and 0xFF) * inv)
                p++
            }
        }
        return true
    }

    // ------------------------------------------------------------------
    // Decoding + NMS
    // ------------------------------------------------------------------

    private fun scoreAt(raw: FloatArray, anchor: Int): Float =
        if (outputChannelLast) raw[anchor * outputChannels + BOX_CHANNELS + PERSON_CLASS_INDEX]
        else raw[(BOX_CHANNELS + PERSON_CLASS_INDEX) * outputAnchors + anchor]

    private fun boxAt(raw: FloatArray, channel: Int, anchor: Int): Float =
        if (outputChannelLast) raw[anchor * outputChannels + channel]
        else raw[channel * outputAnchors + anchor]

    /** Decodes raw head output into normalized, geometry-filtered candidates. */
    private fun decode(raw: FloatArray, width: Int, height: Int): ArrayList<RawDetection> {
        // Recompute the letterbox transform exactly as preprocess() did.
        val scale = min(inputWidth.toFloat() / width, inputHeight.toFloat() / height)
        if (scale <= 0f) return ArrayList()
        val newW = (width * scale).roundToInt().coerceAtLeast(1)
        val newH = (height * scale).roundToInt().coerceAtLeast(1)
        val padX = (inputWidth - newW) / 2f
        val padY = (inputHeight - newH) / 2f

        val out = ArrayList<RawDetection>()
        var anchor = 0
        while (anchor < outputAnchors) {
            val score = scoreAt(raw, anchor)
            if (score >= scoreThreshold) {
                val cx = boxAt(raw, 0, anchor)
                val cy = boxAt(raw, 1, anchor)
                val bw = boxAt(raw, 2, anchor)
                val bh = boxAt(raw, 3, anchor)
                if (bw > 0f && bh > 0f) {
                    // input px -> original px -> normalized [0,1]
                    val x1 = ((cx - bw / 2f - padX) / scale) / width
                    val y1 = ((cy - bh / 2f - padY) / scale) / height
                    val x2 = ((cx + bw / 2f - padX) / scale) / width
                    val y2 = ((cy + bh / 2f - padY) / scale) / height

                    val nx1 = x1.coerceIn(0f, 1f)
                    val ny1 = y1.coerceIn(0f, 1f)
                    val nx2 = x2.coerceIn(0f, 1f)
                    val ny2 = y2.coerceIn(0f, 1f)

                    // Same geometry filters as MediaPipePersonDetector.
                    val nw = nx2 - nx1
                    val nh = ny2 - ny1
                    if (nw > 0f && nh > 0f && nw * nh >= minBoxAreaFraction) {
                        val aspect = nh / nw
                        if (aspect in minAspect..maxAspect) {
                            out.add(RawDetection(score, nx1, ny1, nx2, ny2))
                            if (out.size >= MAX_CANDIDATES) return out
                        }
                    }
                }
            }
            anchor++
        }
        return out
    }

    // Single-class (person) NMS. Class-wise semantics are preserved because
    // only the person class is ever emitted.
    private fun nms(candidates: ArrayList<RawDetection>): List<RawDetection> {
        if (candidates.isEmpty()) return emptyList()
        candidates.sortByDescending { it.score }
        val kept = ArrayList<RawDetection>(min(maxResults, candidates.size))
        for (c in candidates) {
            var discard = false
            for (k in kept) {
                if (iou(c, k) > iouThreshold) {
                    discard = true
                    break
                }
            }
            if (!discard) {
                kept.add(c)
                if (kept.size >= maxResults) break
            }
        }
        return kept
    }

    private fun iou(a: RawDetection, b: RawDetection): Float {
        val ix1 = max(a.x1, b.x1)
        val iy1 = max(a.y1, b.y1)
        val ix2 = min(a.x2, b.x2)
        val iy2 = min(a.y2, b.y2)
        val iw = ix2 - ix1
        val ih = iy2 - iy1
        if (iw <= 0f || ih <= 0f) return 0f
        val inter = iw * ih
        val areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
        val areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
        val denom = areaA + areaB - inter
        return if (denom <= 0f) 0f else inter / denom
    }

    // ------------------------------------------------------------------
    // Resources
    // ------------------------------------------------------------------

    private fun loadModelBuffer(path: String): ByteBuffer {
        return try {
            // Fast path: memory-map the uncompressed asset (build.gradle sets
            // noCompress "tflite" so openFd is available).
            context.assets.openFd(path).use { afd ->
                FileInputStream(afd.fileDescriptor).use { fis ->
                    fis.channel.map(FileChannel.MapMode.READ_ONLY, afd.startOffset, afd.declaredLength)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] yolo mmap failed, reading asset: ${t.message}")
            context.assets.open(path).use { input ->
                val bytes = input.readBytes()
                ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply {
                    put(bytes)
                    rewind()
                }
            }
        }
    }

    private fun releaseBuffers() {
        inputBuffer = null
        outputBuffer = null
        rawOutput = null
        pixels = null
        canvas = null
        paint = null
        val b = scratch
        scratch = null
        if (b != null && !b.isRecycled) {
            try { b.recycle() } catch (_: Throwable) {}
        }
    }

    override fun close() {
        ready = false
        try { interpreter?.close() } catch (_: Throwable) {}
        interpreter = null
        releaseBuffers()
    }
}
