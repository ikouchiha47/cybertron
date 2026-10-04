package com.doorcam.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.BatteryManager
import android.view.TextureView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.InputStream
import java.lang.ref.WeakReference
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class MjpegStreamView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener {

    companion object {
        private const val RING_SIZE = 25    // 25s pre-event at 1fps
        private const val POST_FRAMES = 60  // 60s post-event at 1fps
        private const val BATTERY_LOW_PCT = 10

        // Parser read chunk. Frames are assembled in a single growable buffer.
        private const val READ_CHUNK = 65536

        // At most one surface draw per view per interval. When a TCP burst
        // delivers frames faster than this we draw the newest parsed frame and
        // drop the older ones instead of queueing judder. The detection
        // hand-off is unaffected: every good frame is still decoded + ingested.
        private const val MIN_DRAW_INTERVAL_MS = 100L

        private val SOI_0 = 0xFF.toByte()
        private val SOI_1 = 0xD8.toByte()
        private val EOI_0 = 0xFF.toByte()
        private val EOI_1 = 0xD9.toByte()

        // Per-view reconnect backoff (ms), capped at 15s. Each step is jittered ±20%
        // so a fleet of failing cameras does not retry in lockstep.
        private val BACKOFF_SCHEDULE = longArrayOf(1_000L, 2_000L, 5_000L, 15_000L)
        private const val BACKOFF_JITTER = 0.2

        private val registry = ConcurrentHashMap<String, WeakReference<MjpegStreamView>>()

        fun register(id: String, view: MjpegStreamView) {
            val existing = registry[id]?.get()
            if (existing != null && existing !== view) {
                android.util.Log.w("DoorCam", "[native] duplicate streamId '$id' registered; latest view wins")
            }
            registry[id] = WeakReference(view)
        }

        /**
         * Remove [id] from the registry. When [view] is supplied, only remove it if the
         * registry still points at that exact view — during a JS-driven retry remount the
         * outgoing view is detached after the replacement has registered, and an
         * unconditional remove would unregister the fresh view and wedge capture.
         */
        fun unregister(id: String, view: MjpegStreamView? = null) {
            if (view == null) {
                registry.remove(id)
                return
            }
            val current = registry[id]?.get()
            if (current === view || current == null) registry.remove(id)
        }

        fun get(id: String): MjpegStreamView? = registry[id]?.get()

        /** Static snapshot of streamId -> successful surface draws, for the debug HUD. */
        fun snapshotDrawnCounts(): Map<String, Long> {
            val out = HashMap<String, Long>(registry.size)
            for ((id, ref) in registry) {
                val view = ref.get() ?: continue
                out[id] = view.drawnFrames.get()
            }
            return out
        }
    }

    var streamId: String = "default"
        set(value) {
            if (field != value) unregister(field, this)
            field = value
            register(value, this)
        }

    var currentUrl: String? = null
        private set

    /** When false the view still renders frames but skips base64-encoding/emitting MjpegFrame. */
    @Volatile var detectionEnabled: Boolean = true

    private val running = AtomicBoolean(false)
    private var thread: Thread? = null

    // Bumped on every start/stop. Each reader captures its generation at launch and
    // aborts before decode and before draw if it no longer matches, so a reader that
    // outlives its bounded join can never touch a torn-down SurfaceTexture.
    private val generation = AtomicLong(0L)

    // Read by the render/emission path on every frame; updated live without restarting the stream.
    @Volatile private var inferenceIntervalMs: Long = 1000L
    private var lastEmitAt: Long = 0L
    private val frameSeq = AtomicLong(0L)
    // Successful surface draws for this view; polled by DoorCamModule.getMetrics.
    private val drawnFrames = AtomicLong(0L)
    private var surfaceReady = false
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    // --- Display path (reader thread only) ---------------------------------
    // Two reusable decode buffers per view. Slots alternate so the buffer just
    // handed to the surface is never the one decoded into next, giving the
    // compositor a full frame to finish with it. Reusing these removes the
    // ~614KB ARGB_8888 allocation that previously happened per frame per view.
    private val framePool = arrayOfNulls<Bitmap>(2)
    private var lastDrawnSlot: Int = -1
    // Latest decoded frame waiting to be drawn. Within a TCP burst every frame
    // is decoded + ingested, but only this (newest) one reaches the surface;
    // older frames are dropped. Tagged with its reader generation so a stale
    // entry from a superseded reader can never be drawn after a remount.
    private var pendingBitmap: Bitmap? = null
    private var pendingSlot: Int = -1
    private var pendingGen: Long = -1L
    // Timestamp of the last surface draw; paces bursts to MIN_DRAW_INTERVAL_MS.
    private var lastDrawAtMs: Long = 0L
    // Source dimensions of the most recently decoded JPEG (header pass, before
    // inSampleSize), so MjpegFrame keeps reporting the camera's native size.
    private var lastSrcW: Int = 0
    private var lastSrcH: Int = 0
    // Reused scratch for isBadFrame's single getPixels() read.
    private var badFramePixels = IntArray(0)

    // --- Connection status, reported to JS only on online<->offline transitions ---
    @Volatile private var reconnects: Int = 0
    @Volatile private var lastFrameAtMs: Long = 0L
    @Volatile private var online: Boolean = false
    @Volatile private var statusInitialized: Boolean = false
    // Index into BACKOFF_SCHEDULE; reset to 0 whenever a frame arrives. Read thread only.
    private var backoffStep: Int = 0

    // In-flight HTTP call/stream so stopStream can cancel immediately instead of relying on interrupt().
    @Volatile private var currentCall: Call? = null
    @Volatile private var currentStream: InputStream? = null

    // Ring buffer — last RING_SIZE inference-rate frames kept in memory as pre-event context
    private val ringBuffer = ArrayDeque<ByteArray>(RING_SIZE)
    private val ringLock = Any()

    // Event capture state
    @Volatile private var captureEventId: String? = null
    @Volatile private var captureCameraId: String = "default"
    private val captureFrames = mutableListOf<ByteArray>()
    @Volatile private var capturePostRemaining = 0
    private val captureLock = Any()

    // Recreated on attach so a detached/reattached view can still persist events.
    @Volatile private var ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // Finite read timeout: a half-open/wedged ESP32 socket (stops sending but
        // keeps the connection open) would otherwise block read() forever and the
        // tile would freeze with no EOF and no reconnect. A timeout throws
        // SocketTimeoutException, which the readStream loop catches and retries.
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (scale > 0 && level * 100 / scale <= BATTERY_LOW_PCT) {
                forceCloseCapture()
            }
        }
    }

    init {
        surfaceTextureListener = this
        isOpaque = true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (ioExecutor.isShutdown) {
            ioExecutor = Executors.newSingleThreadExecutor()
        }
        register(streamId, this)
        context.registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        forceCloseCapture()
        stopStream()
        unregister(streamId, this)
        ioExecutor.shutdown()
        try { context.unregisterReceiver(batteryReceiver) } catch (_: Exception) {}
    }

    /** Save whatever frames are captured so far and close the event immediately. */
    fun forceCloseCapture() {
        val eid: String
        val cameraId: String
        val frames: List<ByteArray>
        synchronized(captureLock) {
            eid = captureEventId ?: return
            cameraId = captureCameraId
            frames = captureFrames.toList()
            captureFrames.clear()
            captureEventId = null
            capturePostRemaining = 0
        }
        if (frames.isNotEmpty()) saveEventToDisk(eid, cameraId, frames)
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, w: Int, h: Int) {
        surfaceReady = true
        drawBlack()
        currentUrl?.let { startStream(it, inferenceIntervalMs) }
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        surfaceReady = false
        stopStream()
        return true
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, w: Int, h: Int) {}
    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    /** Update the inference cadence without restarting the stream. */
    fun setInferenceInterval(ms: Long) {
        if (ms > 0) inferenceIntervalMs = ms
    }

    fun startStream(url: String, intervalMs: Long = 0L) {
        // Joins (bounded) the previous reader and invalidates its generation before
        // a new one is created, so two readers never share the surface.
        stopStream()
        val gen = generation.incrementAndGet()
        currentUrl = url
        if (intervalMs > 0) inferenceIntervalMs = intervalMs
        running.set(true)
        thread = Thread { readStream(url, gen) }.also { it.isDaemon = true; it.start() }
    }

    fun stopStream() {
        // Invalidate any in-flight reader immediately, even if the join below times out.
        generation.incrementAndGet()
        running.set(false)
        try { currentStream?.close() } catch (_: Exception) {}
        currentStream = null
        try { currentCall?.cancel() } catch (_: Exception) {}
        currentCall = null
        val old = thread
        thread = null
        old?.interrupt()
        joinReader(old)
    }

    /**
     * Bounded join so teardown cannot proceed while a reader is drawing to the surface.
     * Never blocks the UI thread: on the main thread we skip the join entirely and
     * rely on the generation guard, which aborts any late reader before it decodes
     * or draws. Off-main we wait up to 2s so background teardown is quiescent.
     */
    private fun joinReader(t: Thread?) {
        if (t == null || t === Thread.currentThread()) return
        val onMain = android.os.Looper.myLooper() == android.os.Looper.getMainLooper()
        // A 0ms join means "wait forever" in Java, so on the main thread we must
        // not join at all. Late readers are harmless thanks to the generation guard.
        if (onMain) return
        try {
            t.join(2_000L)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun drawBlack() {
        val canvas: Canvas = lockCanvas() ?: return
        try { canvas.drawColor(Color.BLACK) } finally { unlockCanvasAndPost(canvas) }
    }

    private fun readStream(url: String, gen: Long) {
        backoffStep = 0
        while (running.get() && gen == generation.get()) {
            val call = client.newCall(Request.Builder().url(url).build())
            currentCall = call
            try {
                call.execute().use { resp ->
                    if (resp.isSuccessful) {
                        val stream = resp.body?.byteStream()
                        if (stream != null) {
                            currentStream = stream
                            try {
                                parseFrames(stream, gen)
                            } finally {
                                if (currentStream === stream) currentStream = null
                            }
                        }
                    }
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt() // restore interrupt flag, exit cleanly
                return
            } catch (e: Exception) {
                if (running.get()) {
                    android.util.Log.w("DoorCam", "[native] stream error streamId=$streamId: $e")
                }
            } finally {
                if (currentCall === call) currentCall = null
            }

            if (!running.get() || gen != generation.get()) return

            // Reaching here means the socket ended (EOF), the response was unsuccessful,
            // or an exception occurred. Back off and retry forever while the view is
            // mounted. Detach flips running=false and interrupts the sleep below.
            reconnects++
            markOffline()
            val delayMs = nextBackoffDelay()
            android.util.Log.w("DoorCam", "[native] reconnecting streamId=$streamId in ${delayMs}ms (reconnects=$reconnects)")
            try {
                Thread.sleep(delayMs)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    /** Next backoff delay with ±20% jitter; advances toward the 15s cap. */
    private fun nextBackoffDelay(): Long {
        val idx = backoffStep.coerceIn(0, BACKOFF_SCHEDULE.size - 1)
        val base = BACKOFF_SCHEDULE[idx]
        if (backoffStep < BACKOFF_SCHEDULE.size - 1) backoffStep++
        val jitter = (Math.random() * 2.0 - 1.0) * BACKOFF_JITTER
        return (base * (1.0 + jitter)).toLong().coerceAtLeast(250L)
    }

    /** First good frame after a (re)start: online, and reset the backoff schedule. */
    private fun markFrameReceived() {
        lastFrameAtMs = System.currentTimeMillis()
        backoffStep = 0
        if (!online) {
            online = true
            statusInitialized = true
            emitCameraStatus()
        }
    }

    /** A read/connect failure is putting us into backoff. */
    private fun markOffline() {
        if (online || !statusInitialized) {
            online = false
            statusInitialized = true
            emitCameraStatus()
        }
    }

    private fun emitCameraStatus() {
        val reactContext = context as? ReactContext ?: return
        val now = System.currentTimeMillis()
        val lastFrameAgoMs = if (lastFrameAtMs > 0L) now - lastFrameAtMs else -1L
        if (running.get()) {
            android.util.Log.w(
                "DoorCam",
                "[native] CameraStatus streamId=$streamId online=$online reconnects=$reconnects lastFrameAgoMs=$lastFrameAgoMs",
            )
        }
        val params = Arguments.createMap().apply {
            putString("streamId", streamId)
            putBoolean("online", online)
            putInt("reconnects", reconnects)
            putDouble("lastFrameAgoMs", lastFrameAgoMs.toDouble())
        }
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("CameraStatus", params)
        } catch (_: Exception) {
            // View torn down mid-transition — nothing to report.
        }
    }

    private fun parseFrames(stream: InputStream, gen: Long) {
        val readBuf = ByteArray(READ_CHUNK)
        // Single growable assembly buffer. Bytes are appended after any partial
        // frame left over from the previous read; consumed bytes are compacted
        // away instead of allocating `carry + chunk` on every socket read.
        var frameBuf = ByteArray(READ_CHUNK)
        var frameLen = 0

        while (running.get() && gen == generation.get()) {
            val read = stream.read(readBuf)
            if (read == -1) break

            if (frameLen + read > frameBuf.size) {
                var cap = frameBuf.size
                while (cap < frameLen + read) cap *= 2
                frameBuf = frameBuf.copyOf(cap)
            }
            System.arraycopy(readBuf, 0, frameBuf, frameLen, read)
            frameLen += read

            var offset = 0
            while (offset < frameLen - 1) {
                if (gen != generation.get()) return
                val soi = findMarker(frameBuf, offset, frameLen, SOI_0, SOI_1)
                if (soi == -1) {
                    // No complete SOI in the buffer. Keep a trailing 0xFF in case
                    // it is the first byte of an SOI split across reads, drop the
                    // rest of the junk.
                    offset = if (frameLen > 0 && frameBuf[frameLen - 1] == SOI_0) frameLen - 1 else frameLen
                    break
                }

                val eoiStart = findMarker(frameBuf, soi + 2, frameLen, EOI_0, EOI_1)
                if (eoiStart == -1) {
                    // Incomplete frame: keep from its SOI for the next read.
                    offset = soi
                    break
                }

                val eoi = eoiStart + 2
                // This copy is unavoidable: DoorCamEngine.ingest() queues the
                // ByteArray and decodes it on another thread, so the bytes must
                // stay stable after this call. Only the carry concatenation is
                // eliminated, not the per-frame slice.
                renderFrame(frameBuf.copyOfRange(soi, eoi), gen)
                offset = eoi
            }

            // Compact: move the unconsumed tail to the front, reuse the buffer.
            if (offset > 0) {
                val remaining = frameLen - offset
                if (remaining > 0) System.arraycopy(frameBuf, offset, frameBuf, 0, remaining)
                frameLen = remaining
            }

            // All frames from this read are processed. Draw the newest one if the
            // pacing window is open; otherwise it is dropped and the next read's
            // newest frame wins. Deferring to here is what makes "newest wins"
            // hold within a burst without a queue or an extra thread.
            flushPendingDraw(gen)
        }
    }

    private fun findMarker(data: ByteArray, from: Int, end: Int, b0: Byte, b1: Byte): Int {
        var i = from
        val last = end - 1
        while (i < last) {
            if (data[i] == b0 && data[i + 1] == b1) return i
            i++
        }
        return -1
    }

    // Returns true if the frame looks like a sensor transition artifact
    // (AWB/night mode recalibration produces frames where R+B >> G)
    private fun isBadFrame(bitmap: Bitmap): Boolean {
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return false

        val cx = w / 2
        val cy = h / 2
        // The region we'd sample (cx±50, cy±50) clipped to the bitmap. A single
        // getPixels() replaces ~121 per-pixel JNI calls per frame.
        val x0 = (cx - 50).coerceAtLeast(0)
        val x1 = (cx + 50).coerceAtMost(w - 1)
        val y0 = (cy - 50).coerceAtLeast(0)
        val y1 = (cy + 50).coerceAtMost(h - 1)
        val rw = x1 - x0 + 1
        val rh = y1 - y0 + 1
        if (rw <= 0 || rh <= 0) return false

        val need = rw * rh
        var px = badFramePixels
        if (px.size < need) {
            px = IntArray(need)
            badFramePixels = px
        }
        try {
            bitmap.getPixels(px, 0, rw, x0, y0, rw, rh)
        } catch (_: Exception) {
            return false
        }

        // Walk the exact same logical grid (cx-50 .. cx+50 step 10, clamped) as
        // before, reading from the one reused pixel array instead of getPixel().
        var rSum = 0L; var gSum = 0L; var bSum = 0L
        val step = 10
        var y = cy - 50
        while (y <= cy + 50) {
            val py = y.coerceIn(0, h - 1) - y0
            var x = cx - 50
            while (x <= cx + 50) {
                val pxx = x.coerceIn(0, w - 1) - x0
                val p = px[py * rw + pxx]
                rSum += (p shr 16) and 0xFF
                gSum += (p shr 8) and 0xFF
                bSum += p and 0xFF
                x += step
            }
            y += step
        }
        // Flag as bad if green channel is less than half the average of red+blue
        return gSum * 2 < (rSum + bSum) / 2
    }

    private fun renderFrame(jpeg: ByteArray, gen: Long) {
        // Abort before decode if this reader has been superseded or stopped.
        if (gen != generation.get() || !running.get()) return

        // Decode into the reusable slot the surface is NOT currently using, and
        // which is not already holding the frame we still intend to draw.
        val slot = chooseDecodeSlot()
        val bitmap = decodeForView(jpeg, width, height, slot) ?: return

        // A decoded frame means the socket is delivering data again.
        markFrameReceived()
        if (isBadFrame(bitmap)) {
            // Bad frame: don't queue it for drawing and don't feed detection. The
            // pooled bitmap is overwritten on the next good frame; it is never
            // recycled here because it may still be owned by the compositor.
            return
        }
        // Re-check before queueing: decode/isBadFrame took time and teardown may have run.
        if (gen != generation.get() || !running.get()) return

        // Keep only the newest good frame as the draw candidate. Any earlier
        // frame from the same burst is superseded here and never reaches the
        // surface; flushPendingDraw runs once per socket read.
        pendingBitmap = bitmap
        pendingSlot = slot
        pendingGen = gen

        // Single-producer hand-off: this view owns the camera's MJPEG socket, so
        // the detection engine must be fed from here (it never opens its own).
        // Every good frame is ingested regardless of whether it was drawn.
        DoorCamEngine.ingest(streamId, jpeg, System.currentTimeMillis())

        val now = System.currentTimeMillis()
        if (now - lastEmitAt >= inferenceIntervalMs) {
            lastEmitAt = now
            if (detectionEnabled) {
                // Report the source resolution, not the display-sampled decode.
                emitFrameToJs(jpeg, lastSrcW, lastSrcH)
            }
            onInferenceFrame(jpeg)
        }
    }

    /**
     * Pick the decode slot: never the buffer currently queued to be drawn, and
     * otherwise alternating away from the last drawn slot (double buffering).
     */
    private fun chooseDecodeSlot(): Int {
        if (pendingSlot == 0) return 1
        if (pendingSlot == 1) return 0
        return if (lastDrawnSlot == 0) 1 else 0
    }

    /**
     * Draw the newest pending good frame if the pacing window is open. Runs on
     * the reader thread once per socket read — no queue, no extra thread. When
     * throttled the pending frame is dropped so it can never backlog; the next
     * read supplies a newer one.
     */
    private fun flushPendingDraw(gen: Long) {
        val bitmap = pendingBitmap ?: return
        val slot = pendingSlot
        pendingBitmap = null
        pendingSlot = -1
        if (pendingGen != gen || gen != generation.get() || !running.get()) return
        pendingGen = -1L
        val now = System.currentTimeMillis()
        if (now - lastDrawAtMs < MIN_DRAW_INTERVAL_MS) return
        lastDrawAtMs = now
        lastDrawnSlot = slot
        drawBitmapToSurface(bitmap, gen)
    }

    /**
     * Decodes [jpeg] into framePool[slot], downsampled so its long side is
     * still at least the view's long side. Mirrors FrameDecoder.computeInSampleSize
     * so we never decode more pixels than the view can show. Returns null when the
     * bytes are not a decodable image.
     */
    private fun decodeForView(jpeg: ByteArray, viewW: Int, viewH: Int, slot: Int): Bitmap? {
        if (jpeg.isEmpty()) return null

        // Pass 1: read the source dimensions only (header; no pixels).
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        } catch (_: Throwable) {
            return null
        }
        val srcW = bounds.outWidth
        val srcH = bounds.outHeight
        if (srcW <= 0 || srcH <= 0) return null
        lastSrcW = srcW
        lastSrcH = srcH

        val targetLongSide =
            if (viewW > 0 && viewH > 0) maxOf(viewW, viewH) else maxOf(srcW, srcH)
        val sample = computeInSampleSize(srcW, srcH, targetLongSide)
        val targetW = (srcW + sample - 1) / sample
        val targetH = (srcH + sample - 1) / sample

        val previous = framePool[slot]
        val canReuse = previous != null && !previous.isRecycled && previous.isMutable &&
            previous.width == targetW && previous.height == targetH

        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inMutable = true
            if (canReuse) inBitmap = previous
        }

        val decoded = try {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, options)
        } catch (_: Throwable) {
            null
        }
        if (decoded == null) return null

        // If the size changed the decoder allocated a fresh bitmap; the old
        // pooled one is safe to recycle because it was not the last drawn slot
        // (or was never drawn).
        if (previous != null && previous !== decoded && !previous.isRecycled) {
            try { previous.recycle() } catch (_: Throwable) {}
        }
        framePool[slot] = decoded
        return decoded
    }

    /** Downsample factor keeping the decoded long side >= [target]. */
    private fun computeInSampleSize(w: Int, h: Int, target: Int): Int {
        val longSide = maxOf(w, h)
        var sample = 1
        while (longSide / (sample * 2) >= target) sample *= 2
        return sample
    }

    // Called once per inference interval — maintains ring buffer and post-event capture
    private fun onInferenceFrame(jpeg: ByteArray) {
        val eid = captureEventId
        if (eid == null) {
            // Normal: maintain rolling ring buffer
            synchronized(ringLock) {
                if (ringBuffer.size >= RING_SIZE) ringBuffer.removeFirst()
                ringBuffer.addLast(jpeg.copyOf())
            }
        } else {
            // Actively capturing post-event frames
            synchronized(captureLock) {
                captureFrames.add(jpeg.copyOf())
                capturePostRemaining--
                if (capturePostRemaining <= 0) {
                    val frames = captureFrames.toList()
                    val cameraId = captureCameraId
                    captureFrames.clear()
                    captureEventId = null
                    saveEventToDisk(eid, cameraId, frames)
                }
            }
        }
    }

    // Called from DoorCamModule (JS thread) when a person is detected
    fun startCapture(eventId: String) {
        // Already capturing — ignore
        if (captureEventId != null) return
        val preFrames = synchronized(ringLock) { ringBuffer.toList() }
        synchronized(captureLock) {
            captureEventId = eventId
            captureCameraId = streamId
            captureFrames.clear()
            captureFrames.addAll(preFrames)
            capturePostRemaining = POST_FRAMES
        }
    }

    private fun saveEventToDisk(eventId: String, cameraId: String, frames: List<ByteArray>) {
        val executor = ioExecutor
        if (executor.isShutdown) return
        executor.execute {
            val reactContext = context as? ReactContext ?: return@execute
            val dir = File(reactContext.filesDir, "doorcam_events/$eventId")
            dir.mkdirs()

            val paths = frames.mapIndexed { i, bytes ->
                val file = File(dir, "frame_%03d.jpg".format(i))
                file.writeBytes(bytes)
                file.absolutePath
            }

            val videoPath = encodeToMp4(dir, frames)

            val arr = Arguments.createArray().also { a -> paths.forEach { a.pushString(it) } }
            val params = Arguments.createMap().apply {
                putString("eventId", eventId)
                putString("cameraId", cameraId)
                putString("thumbnailPath", paths.firstOrNull() ?: "")
                putInt("frameCount", paths.size)
                putArray("paths", arr)
                putString("videoPath", videoPath ?: "")
                putDouble("timestamp", System.currentTimeMillis().toDouble())
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("DoorCamEventSaved", params)
        }
    }

    private fun encodeToMp4(dir: File, frames: List<ByteArray>): String? {
        if (frames.isEmpty()) return null

        var codec: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var muxerStarted = false

        return try {
            // Decode first frame to get dimensions
            val first = BitmapFactory.decodeByteArray(frames[0], 0, frames[0].size) ?: return null
            // MediaCodec requires dimensions divisible by 2
            val w = (first.width  / 2) * 2
            val h = (first.height / 2) * 2
            first.recycle()
            if (w <= 0 || h <= 0) return null

            val fps = 10
            val outFile = File(dir, "event.mp4")
            val localMuxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = localMuxer

            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                setInteger(MediaFormat.KEY_BIT_RATE, 2_000_000)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            }

            val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            codec = encoder
            // Byte-buffer input mode: configure() is passed no input Surface, so
            // frames are queued as YUV byte buffers. End-of-stream must therefore
            // be signalled by queueing an input buffer flagged
            // BUFFER_FLAG_END_OF_STREAM. signalEndOfInputStream() is a
            // surface-input-only API and throws IllegalStateException here.
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            encoder.start()

            val usPerFrame = 1_000_000L / fps
            var trackIndex = -1
            var ptsUs = 0L
            var eosQueued = false
            val bufInfo = MediaCodec.BufferInfo()

            /**
             * Drain encoded output into the muxer. When [waitForEos] is true the
             * loop keeps polling (bounded) until the output EOS buffer arrives;
             * otherwise it returns as soon as the codec has nothing ready.
             */
            fun drainEncoder(waitForEos: Boolean) {
                val deadlineMs = if (waitForEos) System.currentTimeMillis() + 2_000L else 0L
                while (true) {
                    val outIdx = encoder.dequeueOutputBuffer(bufInfo, if (waitForEos) 10_000L else 0L)
                    if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        if (waitForEos && System.currentTimeMillis() < deadlineMs) continue
                        break
                    }
                    if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        trackIndex = localMuxer.addTrack(encoder.outputFormat)
                        localMuxer.start()
                        muxerStarted = true
                        continue
                    }
                    if (outIdx < 0) break
                    val buf = encoder.getOutputBuffer(outIdx)
                    if (buf == null) {
                        encoder.releaseOutputBuffer(outIdx, false)
                        continue
                    }
                    if (bufInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        // Codec config (SPS/PPS) is carried by the track format.
                        encoder.releaseOutputBuffer(outIdx, false)
                        continue
                    }
                    // bufInfo.presentationTimeUs is the PTS we queued on the input
                    // buffer; pass it through unchanged so playback timing is right.
                    if (muxerStarted && trackIndex >= 0) {
                        localMuxer.writeSampleData(trackIndex, buf, bufInfo)
                    }
                    val sawEos = bufInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    encoder.releaseOutputBuffer(outIdx, false)
                    if (sawEos) return
                }
            }

            for ((idx, jpeg) in frames.withIndex()) {
                val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: continue
                val scaled = if (bmp.width != w || bmp.height != h)
                    Bitmap.createScaledBitmap(bmp, w, h, true).also { bmp.recycle() }
                else bmp

                val inIdx = encoder.dequeueInputBuffer(10_000L)
                if (inIdx >= 0) {
                    val inBuf: ByteBuffer? = encoder.getInputBuffer(inIdx)
                    if (inBuf == null) {
                        scaled.recycle()
                        // Give the slot back so the codec is not starved.
                        encoder.queueInputBuffer(inIdx, 0, 0, ptsUs, 0)
                    } else {
                        inBuf.clear()
                        // Convert ARGB to YUV420
                        val argb = IntArray(w * h)
                        scaled.getPixels(argb, 0, w, 0, 0, w, h)
                        scaled.recycle()
                        val yuv = ByteArray(w * h * 3 / 2)
                        argbToYuv420(argb, yuv, w, h)
                        inBuf.put(yuv)
                        val isLast = idx == frames.size - 1
                        val flags = if (isLast) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
                        if (isLast) eosQueued = true
                        encoder.queueInputBuffer(inIdx, 0, yuv.size, ptsUs, flags)
                        ptsUs += usPerFrame
                    }
                } else {
                    scaled.recycle()
                }
                drainEncoder(false)
            }

            // The last frame may have failed to decode or no input slot was
            // available when it was queued, in which case EOS was never sent.
            // Deliver it explicitly through the byte-buffer API.
            if (!eosQueued) {
                val deadline = System.currentTimeMillis() + 1_000L
                while (!eosQueued && System.currentTimeMillis() < deadline) {
                    val inIdx = encoder.dequeueInputBuffer(10_000L)
                    if (inIdx >= 0) {
                        encoder.queueInputBuffer(inIdx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        eosQueued = true
                    }
                }
            }

            drainEncoder(true)

            if (muxerStarted) outFile.absolutePath else null
        } catch (e: Exception) {
            android.util.Log.w("DoorCam", "MP4 encode failed: $e")
            null
        } finally {
            try { codec?.stop() } catch (e: Exception) {
                android.util.Log.w("DoorCam", "MP4 codec stop failed: $e")
            }
            try { codec?.release() } catch (_: Exception) {}
            try {
                // stop() throws if no track was ever added / muxer never started.
                if (muxerStarted) muxer?.stop()
            } catch (e: Exception) {
                android.util.Log.w("DoorCam", "MP4 muxer stop failed: $e")
            }
            try { muxer?.release() } catch (_: Exception) {}
        }
    }

    private fun argbToYuv420(argb: IntArray, yuv: ByteArray, w: Int, h: Int) {
        val size = w * h
        var yIdx = 0; var uvIdx = size
        for (j in 0 until h) {
            for (i in 0 until w) {
                val p = argb[j * w + i]
                val r = (p shr 16) and 0xFF
                val g = (p shr  8) and 0xFF
                val b =  p         and 0xFF
                val y = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
                yuv[yIdx++] = y.coerceIn(0, 255).toByte()
                if (j % 2 == 0 && i % 2 == 0) {
                    val u = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                    val v = ((112 * r - 94 * g -  18 * b + 128) shr 8) + 128
                    yuv[uvIdx++] = u.coerceIn(0, 255).toByte()
                    yuv[uvIdx++] = v.coerceIn(0, 255).toByte()
                }
            }
        }
    }

    private fun drawBitmapToSurface(bitmap: Bitmap, gen: Long) {
        // Skip entirely unless the surface is live and this reader is still current.
        if (!surfaceReady || !isAvailable || surfaceTexture == null) return
        if (gen != generation.get() || !running.get()) return

        val canvas: Canvas
        try {
            // lockCanvas() returns null when the surface is gone; never draw on null.
            canvas = lockCanvas() ?: return
        } catch (e: OutOfMemoryError) {
            throw e
        } catch (_: Error) {
            return
        } catch (_: Exception) {
            return
        }

        try {
            val vw = width.toFloat()
            val vh = height.toFloat()
            val bw = bitmap.width.toFloat()
            val bh = bitmap.height.toFloat()
            val scale = minOf(vw / bw, vh / bh)
            val dx = (vw - bw * scale) / 2f
            val dy = (vh - bh * scale) / 2f
            // The decode pass keeps the frame's long side >= the view's, so we are
            // normally downscaling. Bilinear filtering only helps when we actually
            // upscale (small source / view not laid out yet); skip it otherwise.
            paint.isFilterBitmap = !(vw > 0f && vh > 0f && bw >= vw && bh >= vh)
            if (BuildConfig.DEBUG) {
                android.util.Log.v("DoorCam", "[native] drawBitmap bw=$bw bh=$bh vw=$vw vh=$vh scale=$scale dx=$dx dy=$dy fitW=${bw*scale} fitH=${bh*scale}")
            }
            canvas.drawColor(Color.BLACK)
            canvas.drawBitmap(bitmap, null, RectF(dx, dy, dx + bw * scale, dy + bh * scale), paint)
            drawnFrames.incrementAndGet()
        } catch (e: OutOfMemoryError) {
            // Never swallow OOM silently; let it propagate.
            throw e
        } catch (_: Error) {
            // Surface/Skia torndown raced us; drop this frame, do not crash the process.
        } catch (_: Exception) {
            // Same: the surface went away underneath the draw.
        } finally {
            try {
                unlockCanvasAndPost(canvas)
            } catch (e: OutOfMemoryError) {
                throw e
            } catch (_: Error) {
                // Canvas already invalidated by teardown.
            } catch (_: Exception) {
                // Canvas already invalidated by teardown.
            }
        }
    }

    private fun emitFrameToJs(jpeg: ByteArray, frameW: Int, frameH: Int) {
        val reactContext = context as? ReactContext ?: return
        val b64 = android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP)
        val seq = frameSeq.incrementAndGet()
        if (BuildConfig.DEBUG) {
            android.util.Log.d("DoorCam", "[native] emitFrame streamId=$streamId seq=$seq frameW=$frameW frameH=$frameH viewW=$width viewH=$height")
        }
        val params = Arguments.createMap().apply {
            putString("streamId", streamId)
            putLong("seq", seq)
            putString("base64", b64)
            putInt("frameWidth", frameW)
            putInt("frameHeight", frameH)
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("MjpegFrame", params)
    }

}
