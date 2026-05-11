package com.anonymous.wristturnapp

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class BLEServiceModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BLEService"

    private var service: BLEForegroundService? = null
    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            service = (binder as BLEForegroundService.LocalBinder).getService()
            service?.setReactContext(reactContext)
            bound = true
        }
        override fun onServiceDisconnected(name: ComponentName) {
            service = null
            bound = false
        }
    }

    @ReactMethod
    fun start(promise: Promise) {
        val ctx = reactContext.applicationContext
        val intent = Intent(ctx, BLEForegroundService::class.java)
        ctx.startForegroundService(intent)
        ctx.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        // Idempotently (re-)inject the current react context. If the service
        // survived a JS-bridge restart, its stale reference would silently drop
        // every emit(); this recovers by replacing it on each start() call.
        service?.setReactContext(reactContext)
        promise.resolve(null)
    }

    @ReactMethod
    fun stop(promise: Promise) {
        if (bound) {
            reactContext.applicationContext.unbindService(connection)
            bound = false
        }
        reactContext.applicationContext.stopService(
            Intent(reactContext.applicationContext, BLEForegroundService::class.java)
        )
        promise.resolve(null)
    }

    @ReactMethod
    fun getState(promise: Promise) {
        val svc = service
        if (svc == null) {
            promise.resolve(Arguments.createMap())
            return
        }
        val state = svc.getState()
        val map = Arguments.createMap().apply {
            putBoolean("connected",  state["connected"] as? Boolean ?: false)
            putBoolean("sleeping",   state["sleeping"]  as? Boolean ?: false)
            putString("deviceName",  state["deviceName"] as? String ?: "")
            putInt("batteryPct",     state["batteryPct"] as? Int ?: -1)
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun setRawMode(enabled: Boolean, promise: Promise) {
        service?.setRawMode(enabled)
        promise.resolve(null)
    }

    @ReactMethod
    fun setMode(mode: Int, promise: Promise) {
        service?.setMode(mode)
        promise.resolve(null)
    }

    @ReactMethod
    fun setArmed(armed: Boolean, promise: Promise) {
        service?.setArmed(armed)
        promise.resolve(null)
    }

    @ReactMethod
    fun setBaseline(roll: Double, pitch: Double, yaw: Double, promise: Promise) {
        service?.setBaseline(roll.toFloat(), pitch.toFloat(), yaw.toFloat())
        promise.resolve(null)
    }

    @ReactMethod
    fun setMinIntegrals(packed: Int, promise: Promise) {
        service?.setMinIntegrals(packed)
        promise.resolve(null)
    }

    @ReactMethod
    fun setDiagMode(enabled: Boolean, promise: Promise) {
        service?.setDiagMode(enabled)
        promise.resolve(null)
    }

    // Required by RN for event emitter — no-ops here since we emit directly
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
