package com.doorcam.app

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Multi-camera native detection engine (Phase 2b — all-dashboard detection).
 *
 * Data plane — SINGLE PRODUCER PER CAMERA:
 *  - A camera that is currently displayed by a native [MjpegStreamView] is fed
 *    exclusively through [ingest]: the view is the sole owner of that camera's
 *    MJPEG socket. The engine NEVER opens its own `/stream` connection for a
 *    camera that has an active view (ESP32-CAM serves one client; concurrent
 *    readers corrupt the stream).
 *  - A camera in the active set with NO active view (e.g. off-dashboard while
 *    another camera is fullscreen, or the app is backgrounded and all views
 *    detached) is fed by a transient `http://<ip>/capture` poller at ~1fps
 *    (no persistent socket). The poller yields automatically the moment a
 *    native view for that camera appears, and resumes when the last view goes.
 *
 * Every ingested frame is evaluated by a per-camera [MotionGate]; inference runs
 * at most every [DetectionConfig.inferenceIntervalMs] (default 500ms) per camera
 * on the single pipeline thread, which remains the sole [PersonDetector.detect]
 * caller. K-of-M voting, reset, and sticky nearness are kept per camera.
 */
object DoorCamEngine {

    private const val TAG = "DoorCam"
    private const val EVENT_NAME = "PersonDetected"

    // Mirrors src/utils/constants.ts
    private const val DEFAULT_PERSON_SCORE_THRESHOLD = 0.45f
    private const val DEFAULT_EMPTY_FRAMES_BEFORE_RESET = 3
    private const val DEFAULT_NEARNESS_VERY_CLOSE = 0.7f
    private const val DEFAULT_NEARNESS_CLOSE = 0.4f

    // K-of-M temporal voting.
    private const val DEFAULT_K_CONFIRM = 2
    private const val DEFAULT_M_WINDOW = 3

    // Inference cadence per camera when motion is present.
    private const val DEFAULT_INFERENCE_INTERVAL_MS = 500L

    // Forced-keyframe cadence of the per-camera motion gate: the worst-case
    // wait from "person appears but no motion" to the first inference.
    private const val DEFAULT_KEYFRAME_INTERVAL_MS = 1000L
    private const val MIN_KEYFRAME_INTERVAL_MS = 250
    private const val MAX_KEYFRAME_INTERVAL_MS = 10000

    // Detector selection. Both implementations live behind PersonDetector;
    // "yolo11n" (LiteRT) is the default: smaller, faster, and better person
    // recall on our night frames. "efficientdet" (MediaPipe) stays as fallback.
    private const val DETECTOR_EFFICIENTDET = "efficientdet"
    private const val DETECTOR_YOLO = "yolo11n"
    private const val DEFAULT_DETECTOR = DETECTOR_YOLO

    // Latest-wins per-camera queue depth (bounded memory; oldest dropped).
    private const val PER_CAMERA_QUEUE_CAPACITY = 4

    // Transient /capture poll cadence for viewless active cameras.
    private const val CAPTURE_POLL_INTERVAL_MS = 1000L
    private const val STREAM_PORT = 81

    // ---------------------------------------------------------------------
    // Config (live-applied)
    // ---------------------------------------------------------------------

    private data class DetectionConfig(
        val personScoreThreshold: Float = DEFAULT_PERSON_SCORE_THRESHOLD,
        val kConfirm: Int = DEFAULT_K_CONFIRM,
        val mWindow: Int = DEFAULT_M_WINDOW,
        val emptyFramesBeforeReset: Int = DEFAULT_EMPTY_FRAMES_BEFORE_RESET,
        val nearnessVeryClose: Float = DEFAULT_NEARNESS_VERY_CLOSE,
        val nearnessClose: Float = DEFAULT_NEARNESS_CLOSE,
        val inferenceIntervalMs: Long = DEFAULT_INFERENCE_INTERVAL_MS,
        val keyframeIntervalMs: Long = DEFAULT_KEYFRAME_INTERVAL_MS,
        val detector: String = DEFAULT_DETECTOR,
    )

    @Volatile
    private var config = DetectionConfig()

    // ---------------------------------------------------------------------
    // Camera / state bookkeeping
    // ---------------------------------------------------------------------

    private data class CameraConfig(
        val id: String,
        val ip: String,
        val name: String,
        val url: String,
        val captureUrl: String,
    )

    private data class FrameItem(
        val streamId: String,
        val jpeg: ByteArray,
        val ts: Long,
        /** Monotonic ingest timestamp, used for end-to-end detection latency. */
        val ingestNanos: Long = System.nanoTime(),
    )

    private class CameraState {
        val window = ArrayDeque<Boolean>()
        var active = false
        var emptyFrames = 0
        var stickyVeryClose = false
        var lastNearness = "none"
        val seq = AtomicLong(0L)
    }

    private class CameraMetrics {
        @Volatile var framesIn = 0L
        @Volatile var motionSkips = 0L
        @Volatile var inferencesRun = 0L
        @Volatile var inferenceMsEwma = 0.0
        @Volatile var detectionsConfirmed = 0L

        // Per-stage EWMA durations (alpha 0.2), milliseconds.
        @Volatile var decodeMsEwma = 0.0
        @Volatile var motionMsEwma = 0.0
        @Volatile var postMsEwma = 0.0

        // End-to-end detection latency: frame ingest -> PersonDetected emit.
        @Volatile var detectionLatencyMsEwma = 0.0

        // Current queue depth sampled at inference time (gauge).
        @Volatile var queueDepth = 0L

        // Frames evicted from this camera's latest-wins queue (counter).
        @Volatile var framesDropped = 0L
    }

    private class CameraRuntime(config: CameraConfig, keyframeIntervalMs: Long) {
        @Volatile var config: CameraConfig = config
        val state = CameraState()
        val metrics = CameraMetrics()
        val decoder = FrameDecoder()
        val motion = MotionGate(keyframeIntervalMs = keyframeIntervalMs)

        val queueLock = Any()
        val queue = ArrayDeque<FrameItem>()

        @Volatile var lastInferenceAt = 0L

        @Volatile var poller: CapturePoller? = null
    }

    private val lock = Any()
    private var started = false
    private val running = AtomicBoolean(false)

    private var appContext: Context? = null

    @Volatile
    private var reactContext: ReactApplicationContext? = null

    private val pipelineExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "DoorCamEngine-pipeline").apply { isDaemon = true }
    }

    private val cameras = ConcurrentHashMap<String, CameraConfig>()
    private val runtimes = ConcurrentHashMap<String, CameraRuntime>()

    // Global roll-up counters, in addition to the per-camera metrics.
    private val globalFramesIn = AtomicLong(0L)
    private val globalMotionSkips = AtomicLong(0L)
    private val globalInferences = AtomicLong(0L)
    private val globalDetections = AtomicLong(0L)
    private val globalFramesDropped = AtomicLong(0L)

    @Volatile
    private var globalInferenceMsEwma = 0.0

    @Volatile
    private var globalDecodeMsEwma = 0.0

    @Volatile
    private var globalMotionMsEwma = 0.0

    @Volatile
    private var globalPostMsEwma = 0.0

    @Volatile
    private var globalDetectionLatencyMsEwma = 0.0

    @Volatile
    private var activeIds: Set<String> = emptySet()

    @Volatile
    private var detector: PersonDetector? = null

    @Volatile
    var detectorReady: Boolean = false
        private set

    /** Id of the detector currently owned by the pipeline thread. */
    @Volatile
    private var activeDetectorId: String = DEFAULT_DETECTOR

    // Per-detector inference latency EWMA + run count, so both models can be
    // compared on-device even though only one is active at a time.
    private val detectorInferenceMsEwma = ConcurrentHashMap<String, Double>()
    private val detectorInferencesRun = ConcurrentHashMap<String, Long>()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    fun initialize(context: ReactApplicationContext) {
        appContext = context.applicationContext
        reactContext = context
        ensureStarted()
    }

    private fun ensureStarted() {
        synchronized(lock) {
            if (started) return
            started = true
            running.set(true)
            pipelineExecutor.execute { pipelineLoop() }
        }
    }

    private fun pipelineLoop() {
        val ctx = appContext
        if (ctx == null) {
            Log.e(TAG, "[engine] no context; pipeline not started")
            return
        }

        // Model load happens once, here on the pipeline thread.
        var current = createDetector(ctx, config.detector)
        detector = current
        activeDetectorId = normalizeDetectorId(config.detector)
        detectorReady = current.ready
        Log.i(TAG, "[engine] started detector=${activeDetectorId} detectorReady=${current.ready}")

        while (running.get()) {
            // Live detector switch: close the old model and init the new one on
            // this thread so [PersonDetector] thread affinity is preserved and
            // no native model is leaked.
            val desired = normalizeDetectorId(config.detector)
            if (desired != activeDetectorId) {
                val old = current
                val next = createDetector(ctx, desired)
                detector = next
                activeDetectorId = desired
                detectorReady = next.ready
                current = next
                try { old.close() } catch (_: Throwable) {}
                Log.i(TAG, "[engine] detector switched to=$desired ready=${next.ready}")
            }

            val item = pollItem()
            if (item == null) {
                try { Thread.sleep(20) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
                continue
            }
            try {
                process(item)
            } catch (t: Throwable) {
                // The engine must never crash the app.
                Log.w(TAG, "[engine] frame processing failed: ${t.message}")
            }
        }

        current.close()
        detector = null
        detectorReady = false
        runtimes.values.forEach {
            it.poller?.stop()
            it.decoder.release()
        }
        runtimes.clear()
    }

    /** Round-robin across cameras so one busy stream can't starve the others. */
    private val runtimeCursor = AtomicLong(0L)

    private fun pollItem(): FrameItem? {
        val list = runtimes.values.toList()
        if (list.isEmpty()) return null
        val size = list.size
        val start = (runtimeCursor.getAndIncrement() % size).toInt()
        for (i in 0 until size) {
            val rt = list[(start + i) % size]
            synchronized(rt.queueLock) {
                if (rt.queue.isNotEmpty()) return rt.queue.removeFirst()
            }
        }
        return null
    }

    // ---------------------------------------------------------------------
    // Data plane
    // ---------------------------------------------------------------------

    /**
     * Enqueues one raw JPEG for [streamId]. Non-blocking: under saturation the
     * oldest queued frame for that camera is dropped so a producer (native view
     * or capture poller) is never stalled.
     */
    fun ingest(streamId: String, jpeg: ByteArray, ts: Long = System.currentTimeMillis()) {
        if (jpeg.isEmpty()) return
        ensureStarted()
        val rt = runtimeFor(streamId)
        val item = FrameItem(streamId, jpeg, ts)
        var dropped = false
        synchronized(rt.queueLock) {
            if (rt.queue.size >= PER_CAMERA_QUEUE_CAPACITY) {
                rt.queue.removeFirst()
                dropped = true
            }
            rt.queue.addLast(item)
        }
        if (dropped) {
            rt.metrics.framesDropped += 1
            globalFramesDropped.incrementAndGet()
        }
        rt.metrics.framesIn += 1
        globalFramesIn.incrementAndGet()
    }

    private fun process(item: FrameItem) {
        val rt = runtimeFor(item.streamId)
        val cfg = config
        val m = rt.metrics

        val decodeStart = System.nanoTime()
        val frame = rt.decoder.decode(item.jpeg) ?: return
        if (frame.isRecycled) return
        val decodeMs = (System.nanoTime() - decodeStart) / 1_000_000.0
        m.decodeMsEwma = ewma(m.decodeMsEwma, decodeMs)
        globalDecodeMsEwma = ewma(globalDecodeMsEwma, decodeMs)

        // Motion gate runs on EVERY ingested frame using the already-decoded bitmap.
        val motionStart = System.nanoTime()
        val gate = rt.motion.process(frame, item.ts)
        val motionMs = (System.nanoTime() - motionStart) / 1_000_000.0
        m.motionMsEwma = ewma(m.motionMsEwma, motionMs)
        globalMotionMsEwma = ewma(globalMotionMsEwma, motionMs)
        // Motion gate saves CPU only while nothing is being tracked. Once a
        // track is active, keep evaluating the temporal/vote/reset path every
        // (throttled) frame so the box follows the person and the loss path
        // (emptyFramesBeforeReset -> empty-boxes emit) can fire promptly when
        // they leave, even if the scene goes still underneath them.
        if (!gate.motion && !rt.state.active) {
            m.motionSkips += 1
            globalMotionSkips.incrementAndGet()
            return
        }

        val now = System.currentTimeMillis()
        val interval = cfg.inferenceIntervalMs.coerceAtLeast(0L)
        if (now - rt.lastInferenceAt < interval) return
        rt.lastInferenceAt = now

        // Queue depth sampled at inference time (latest-wins backlog).
        m.queueDepth = synchronized(rt.queueLock) { rt.queue.size.toLong() }

        val t0 = System.nanoTime()
        val detections = detector?.detect(frame, frame.width, frame.height) ?: emptyList()
        val elapsedMs = (System.nanoTime() - t0) / 1_000_000.0
        m.inferencesRun += 1
        globalInferences.incrementAndGet()
        m.inferenceMsEwma = if (m.inferenceMsEwma <= 0.0) elapsedMs else (0.8 * m.inferenceMsEwma) + (0.2 * elapsedMs)
        globalInferenceMsEwma = if (globalInferenceMsEwma <= 0.0) elapsedMs else (0.8 * globalInferenceMsEwma) + (0.2 * elapsedMs)

        // Per-detector latency, keyed by the detector that actually ran.
        val detId = activeDetectorId
        val detPrev = detectorInferenceMsEwma[detId]
        detectorInferenceMsEwma[detId] = if (detPrev == null || detPrev <= 0.0) {
            elapsedMs
        } else {
            (0.8 * detPrev) + (0.2 * elapsedMs)
        }
        detectorInferencesRun.merge(detId, 1L, Long::plus)

        // Post-process + temporal stage: filtering, K-of-M voting, nearness
        // resolution and event emit.
        val postStart = System.nanoTime()
        val state = rt.state
        val strong = detections.filter { it.score >= cfg.personScoreThreshold }
        val framePositive = strong.isNotEmpty()

        state.window.addLast(framePositive)
        val mWindow = cfg.mWindow.coerceAtLeast(1)
        while (state.window.size > mWindow) state.window.removeFirst()
        val votes = state.window.count { it }
        val confirmed = votes >= cfg.kConfirm

        val maxBoxHeight = if (framePositive) strong.maxOf { it.y2 - it.y1 } else 0f
        val frameNearness = when {
            !framePositive -> "none"
            maxBoxHeight > cfg.nearnessVeryClose -> "very_close"
            maxBoxHeight > cfg.nearnessClose -> "close"
            else -> "far"
        }

        if (confirmed) {
            state.emptyFrames = 0
            if (!state.active) {
                state.active = true
                state.stickyVeryClose = false
                state.lastNearness = "none"
                m.detectionsConfirmed += 1
                globalDetections.incrementAndGet()
                Log.i(TAG, "[engine] person confirmed stream=${item.streamId}")
            }
            if (frameNearness == "very_close") state.stickyVeryClose = true

            // Sticky very_close floor holds until the event ends.
            val nearness = when {
                state.stickyVeryClose -> "very_close"
                framePositive -> frameNearness
                else -> state.lastNearness
            }
            state.lastNearness = nearness

            if (framePositive) {
                emitPersonDetected(item, frame, strong, nearness, state)
            }
        } else {
            state.emptyFrames += 1
            if (state.active && state.emptyFrames >= cfg.emptyFramesBeforeReset) {
                state.active = false
                state.stickyVeryClose = false
                state.lastNearness = "none"
                emitPersonDetected(item, frame, emptyList(), "none", state)
                Log.i(TAG, "[engine] person lost stream=${item.streamId}")
            }
        }

        val postMs = (System.nanoTime() - postStart) / 1_000_000.0
        m.postMsEwma = ewma(m.postMsEwma, postMs)
        globalPostMsEwma = ewma(globalPostMsEwma, postMs)
    }

    private fun emitPersonDetected(
        item: FrameItem,
        frame: android.graphics.Bitmap,
        detections: List<RawDetection>,
        nearness: String,
        state: CameraState,
    ) {
        // End-to-end detection latency: ingest -> PersonDetected emit.
        // Best-effort only; metrics must never throw.
        try {
            val latencyMs = ((System.nanoTime() - item.ingestNanos) / 1_000_000.0).coerceAtLeast(0.0)
            val em = runtimeFor(item.streamId).metrics
            em.detectionLatencyMsEwma = ewma(em.detectionLatencyMsEwma, latencyMs)
            globalDetectionLatencyMsEwma = ewma(globalDetectionLatencyMsEwma, latencyMs)
        } catch (_: Throwable) {
        }

        val rc = reactContext ?: return

        val boxesArr = Arguments.createArray()
        for (det in detections) {
            val box = Arguments.createArray()
            box.pushDouble(det.x1.toDouble())
            box.pushDouble(det.y1.toDouble())
            box.pushDouble(det.x2.toDouble())
            box.pushDouble(det.y2.toDouble())
            boxesArr.pushArray(box)
        }
        val scoresArr = Arguments.createArray()
        for (det in detections) scoresArr.pushDouble(det.score.toDouble())

        val seq = state.seq.incrementAndGet()
        val params = Arguments.createMap().apply {
            putString("streamId", item.streamId)
            putDouble("seq", seq.toDouble())
            putArray("boxes", boxesArr)
            putArray("scores", scoresArr)
            putString("nearness", nearness)
            putInt("frameWidth", frame.width)
            putInt("frameHeight", frame.height)
            putDouble("ts", item.ts.toDouble())
        }

        try {
            rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_NAME, params)
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "[engine] PersonDetected stream=${item.streamId} seq=$seq n=${detections.size} nearness=$nearness")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] emit failed: ${t.message}")
        }
    }

    // ---------------------------------------------------------------------
    // Control plane (React bridge entry points, called from DoorCamModule)
    // ---------------------------------------------------------------------

    fun setCameras(camerasArray: ReadableArray?) {
        if (camerasArray == null) return
        ensureStarted()
        try {
            for (i in 0 until camerasArray.size()) {
                val map = camerasArray.getMap(i) ?: continue
                val id = map.getString("id") ?: continue
                val ip = map.getString("ip") ?: ""
                val name = map.getString("name") ?: id
                val explicitUrl = map.getString("url")
                val url = if (!explicitUrl.isNullOrBlank()) explicitUrl else buildStreamUrl(ip)
                val cfg = CameraConfig(id, ip, name, url, buildCaptureUrl(ip))
                cameras[id] = cfg
                runtimes[id]?.config = cfg
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] setCameras failed: ${t.message}")
        }
    }

    fun setActiveCameras(activeArray: ReadableArray?) {
        ensureStarted()
        val ids = try {
            (0 until (activeArray?.size() ?: 0)).mapNotNull { activeArray?.getString(it) }
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] setActiveCameras parse failed: ${t.message}")
            emptyList()
        }
        val next = ids.toSet()
        activeIds = next
        synchronized(lock) {
            // Stop pollers for cameras no longer in the active set.
            runtimes.forEach { (id, rt) ->
                if (!next.contains(id)) {
                    rt.poller?.stop()
                    rt.poller = null
                }
            }
            // Ensure every active camera has a poller thread. The poller itself
            // yields while a native view owns the stream, and resumes on detach.
            for (id in next) {
                val rt = runtimeFor(id)
                if (rt.poller == null) {
                    val cam = cameras[id] ?: continue
                    val p = CapturePoller(id, cam.captureUrl)
                    rt.poller = p
                    p.start()
                }
            }
        }
        Log.i(TAG, "[engine] active set=$next")
    }

    fun isActive(id: String): Boolean = activeIds.contains(id)

    fun setDetectionConfig(map: ReadableMap?) {
        if (map == null) return
        try {
            val current = config
            config = DetectionConfig(
                personScoreThreshold = readFloat(map, "personScoreThreshold", current.personScoreThreshold),
                kConfirm = readInt(map, "kConfirm", current.kConfirm),
                mWindow = readInt(map, "mWindow", current.mWindow),
                emptyFramesBeforeReset = readInt(map, "emptyFramesBeforeReset", current.emptyFramesBeforeReset),
                nearnessVeryClose = readFloat(map, "nearnessVeryClose", current.nearnessVeryClose),
                nearnessClose = readFloat(map, "nearnessClose", current.nearnessClose),
                inferenceIntervalMs = readInt(map, "inferenceIntervalMs", current.inferenceIntervalMs.toInt()).toLong(),
                keyframeIntervalMs = readInt(
                    map,
                    "keyframeIntervalMs",
                    current.keyframeIntervalMs.toInt(),
                ).coerceIn(MIN_KEYFRAME_INTERVAL_MS, MAX_KEYFRAME_INTERVAL_MS).toLong(),
                detector = normalizeDetectorId(readString(map, "detector", current.detector)),
            )
            // Apply the (possibly changed) keyframe cadence to every existing
            // per-camera gate so a live config change takes effect immediately.
            runtimes.values.forEach { it.motion.setKeyframeIntervalMs(config.keyframeIntervalMs) }
            Log.i(TAG, "[engine] config applied $config")
        } catch (t: Throwable) {
            Log.w(TAG, "[engine] setDetectionConfig failed: ${t.message}")
        }
    }

    fun getMetrics(promise: Promise) {
        try {
            val camerasMap = Arguments.createMap()
            for ((id, rt) in runtimes) {
                val m = rt.metrics
                camerasMap.putMap(id, Arguments.createMap().apply {
                    putDouble("framesIn", m.framesIn.toDouble())
                    putDouble("motionSkips", m.motionSkips.toDouble())
                    putDouble("inferencesRun", m.inferencesRun.toDouble())
                    putDouble("inferenceMsEwma", m.inferenceMsEwma)
                    putDouble("detectionsConfirmed", m.detectionsConfirmed.toDouble())
                    putDouble("decodeMs", m.decodeMsEwma)
                    putDouble("motionMs", m.motionMsEwma)
                    putDouble("postMs", m.postMsEwma)
                    putDouble("detectionLatencyMs", m.detectionLatencyMsEwma)
                    putDouble("queueDepth", m.queueDepth.toDouble())
                    putDouble("framesDropped", m.framesDropped.toDouble())
                    putBoolean("active", activeIds.contains(id))
                    putBoolean("hasView", MjpegStreamView.get(id) != null)
                    putString("config", rt.config.name)
                })
            }
            val totals = Arguments.createMap().apply {
                putDouble("framesIn", globalFramesIn.get().toDouble())
                putDouble("motionSkips", globalMotionSkips.get().toDouble())
                putDouble("inferencesRun", globalInferences.get().toDouble())
                putDouble("inferenceMsEwma", globalInferenceMsEwma)
                putDouble("detectionsConfirmed", globalDetections.get().toDouble())
                putDouble("decodeMs", globalDecodeMsEwma)
                putDouble("motionMs", globalMotionMsEwma)
                putDouble("postMs", globalPostMsEwma)
                putDouble("detectionLatencyMs", globalDetectionLatencyMsEwma)
                putDouble("queueDepth", runtimes.values.sumOf { it.metrics.queueDepth }.toDouble())
                putDouble("framesDropped", globalFramesDropped.get().toDouble())
            }
            val result = Arguments.createMap().apply {
                putBoolean("detectorReady", detectorReady)
                putString("detector", activeDetectorId)
                putMap("detectorMetrics", Arguments.createMap().apply {
                    detectorInferenceMsEwma.forEach { (id, ms) ->
                        putMap(id, Arguments.createMap().apply {
                            putDouble("inferenceMsEwma", ms)
                            putDouble("inferencesRun", (detectorInferencesRun[id] ?: 0L).toDouble())
                        })
                    }
                })
                putString("activeCameraId", activeIds.firstOrNull())
                putArray("activeCameraIds", Arguments.createArray().also { a -> activeIds.forEach { a.pushString(it) } })
                putMap("cameras", camerasMap)
                putMap("totals", totals)
            }
            promise.resolve(result)
        } catch (t: Throwable) {
            promise.reject("engine_metrics_failed", t)
        }
    }

    // ---------------------------------------------------------------------
    // Capture poller (transient GET http://<ip>/capture for viewless cameras)
    // ---------------------------------------------------------------------

    private class CapturePoller(private val streamId: String, private val captureUrl: String) {
        private val pollerRunning = AtomicBoolean(true)

        @Volatile private var call: Call? = null

        fun start() {
            Thread { pollLoop() }.also { it.isDaemon = true; it.start() }
        }

        fun stop() {
            pollerRunning.set(false)
            try { call?.cancel() } catch (_: Throwable) {}
            call = null
        }

        private fun pollLoop() {
            var firstIteration = true
            while (pollerRunning.get()) {
                try {
                    // On first iteration, give a freshly-mounted native view time
                    // to register before we could open a concurrent connection.
                    if (firstIteration) {
                        firstIteration = false
                        Thread.sleep(DoorCamEngine.CAPTURE_POLL_INTERVAL_MS)
                    }

                    // Stop if deactivated or the engine is shutting down.
                    if (!DoorCamEngine.running.get() || !DoorCamEngine.isActive(streamId)) break

                    // Single-producer rule: if a native view owns this camera,
                    // never open our own connection. Just wait and re-check.
                    if (MjpegStreamView.get(streamId) != null) {
                        Thread.sleep(DoorCamEngine.CAPTURE_POLL_INTERVAL_MS)
                        continue
                    }

                    val request = Request.Builder().url(captureUrl).build()
                    val c = DoorCamEngine.httpClient.newCall(request)
                    call = c
                    c.execute().use { response ->
                        if (response.isSuccessful) {
                            val bytes = response.body?.bytes()
                            if (bytes != null && bytes.isNotEmpty()) {
                                DoorCamEngine.ingest(streamId, bytes, System.currentTimeMillis())
                            }
                        }
                    }
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                } catch (t: Throwable) {
                    if (BuildConfig.DEBUG) Log.d(DoorCamEngine.TAG, "[engine] capture poll failed for $streamId: ${t.message}")
                } finally {
                    call = null
                }

                try {
                    Thread.sleep(DoorCamEngine.CAPTURE_POLL_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun runtimeFor(streamId: String): CameraRuntime = runtimes.computeIfAbsent(streamId) {
        val cam = cameras[it]
            ?: CameraConfig(it, "", it, buildStreamUrl(""), buildCaptureUrl(""))
        CameraRuntime(cam, config.keyframeIntervalMs)
    }

    private fun buildStreamUrl(ip: String): String {
        val trimmed = ip.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
        return "http://$trimmed:$STREAM_PORT/stream"
    }

    private fun buildCaptureUrl(ip: String): String {
        val trimmed = ip.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return if (trimmed.endsWith("/capture")) trimmed else "$trimmed/capture"
        }
        return "http://$trimmed/capture"
    }

    // JS numbers cross the bridge as doubles; never call getInt() directly.
    private fun readFloat(map: ReadableMap, key: String, fallback: Float): Float =
        if (map.hasKey(key) && !map.isNull(key)) map.getDouble(key).toFloat() else fallback

    /** EWMA with alpha 0.2, seeded by the first sample. Never throws. */
    private fun ewma(prev: Double, sample: Double): Double =
        if (prev <= 0.0 || !prev.isFinite()) sample else (0.8 * prev) + (0.2 * sample)

    private fun readInt(map: ReadableMap, key: String, fallback: Int): Int =
        if (map.hasKey(key) && !map.isNull(key)) map.getDouble(key).toInt() else fallback

    private fun readString(map: ReadableMap, key: String, fallback: String): String =
        if (map.hasKey(key) && !map.isNull(key)) map.getString(key) ?: fallback else fallback

    /** Maps any JS-facing detector value to one of the two canonical ids. */
    private fun normalizeDetectorId(raw: String?): String {
        val v = raw?.trim()?.lowercase() ?: return DETECTOR_EFFICIENTDET
        return if (v == "yolo" || v.contains("yolo")) DETECTOR_YOLO else DETECTOR_EFFICIENTDET
    }

    /**
     * Constructs and initializes a detector. MUST be called on the pipeline
     * thread. Both implementations swallow their own init errors and report
     * `ready == false`, so the engine stays degraded-safe.
     */
    private fun createDetector(ctx: Context, id: String): PersonDetector =
        if (normalizeDetectorId(id) == DETECTOR_YOLO) {
            LiteRtYoloDetector(ctx).also { it.initialize() }
        } else {
            MediaPipePersonDetector(ctx).also { it.initialize() }
        }
}
