package com.doorcam.app

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap

class DoorCamModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    init {
        // Starts the native detection engine (and loads its model) once per process.
        DoorCamEngine.initialize(reactContext)
    }

    override fun getName() = "DoorCamModule"

    @ReactMethod
    fun saveEvent(streamId: String, eventId: String) {
        MjpegStreamView.get(streamId)?.startCapture(eventId)
    }

    @ReactMethod
    fun setCameras(cameras: ReadableArray?) {
        DoorCamEngine.setCameras(cameras)
    }

    @ReactMethod
    fun setActiveCameras(cameras: ReadableArray?) {
        DoorCamEngine.setActiveCameras(cameras)
    }

    @ReactMethod
    fun setDetectionConfig(config: ReadableMap?) {
        DoorCamEngine.setDetectionConfig(config)
    }

    @ReactMethod
    fun getMetrics(promise: Promise) {
        // Superset of DoorCamEngine's payload: merge the per-view drawn-frame
        // counters so the JS debug HUD can derive drawn fps without a new bridge
        // method. Cameras the engine knows about but that have no view get 0.
        DoorCamEngine.getMetrics(MetricsMergePromise(promise, MjpegStreamView.snapshotDrawnCounts()))
    }

    /**
     * Delegates to the real promise, but first merges engine metrics with the
     * per-camera drawn-frame counts from the live MjpegStreamView registry.
     */
    private class MetricsMergePromise(
        private val delegate: Promise,
        private val drawnCounts: Map<String, Long>,
    ) : Promise {

        override fun resolve(value: Any?) {
            val map = value as? WritableMap
            val cameras = map?.getMap("cameras") as? WritableMap
            if (cameras != null) {
                val keys = cameras.keySetIterator()
                while (keys.hasNextKey()) {
                    val id = keys.nextKey()
                    val cam = cameras.getMap(id) as? WritableMap ?: continue
                    cam.putDouble("drawn", (drawnCounts[id] ?: 0L).toDouble())
                }
            }
            delegate.resolve(value)
        }

        override fun reject(code: String, message: String?) = delegate.reject(code, message)

        override fun reject(code: String, throwable: Throwable?) = delegate.reject(code, throwable)

        override fun reject(code: String, message: String?, throwable: Throwable?) =
            delegate.reject(code, message, throwable)

        override fun reject(throwable: Throwable) = delegate.reject(throwable)

        override fun reject(throwable: Throwable, userInfo: WritableMap) =
            delegate.reject(throwable, userInfo)

        override fun reject(code: String, userInfo: WritableMap) = delegate.reject(code, userInfo)

        override fun reject(code: String, throwable: Throwable?, userInfo: WritableMap) =
            delegate.reject(code, throwable, userInfo)

        override fun reject(code: String, message: String?, userInfo: WritableMap) =
            delegate.reject(code, message, userInfo)

        override fun reject(
            code: String?,
            message: String?,
            throwable: Throwable?,
            userInfo: WritableMap?,
        ) = delegate.reject(code, message, throwable, userInfo)

        @Suppress("DEPRECATION")
        override fun reject(message: String) = delegate.reject(message)
    }
}
