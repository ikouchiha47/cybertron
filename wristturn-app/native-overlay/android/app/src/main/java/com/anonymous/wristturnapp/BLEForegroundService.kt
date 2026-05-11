package com.anonymous.wristturnapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

// ── UUIDs ─────────────────────────────────────────────────────────────────────
private val GESTURE_SERVICE_UUID  = UUID.fromString("19B10000-E8F2-537E-4F6C-D104768A1214")
private val GESTURE_CHAR_UUID     = UUID.fromString("19B10001-E8F2-537E-4F6C-D104768A1214")
private val STATE_CHAR_UUID       = UUID.fromString("19B10002-E8F2-537E-4F6C-D104768A1214")
private val BASELINE_CHAR_UUID    = UUID.fromString("19B10003-E8F2-537E-4F6C-D104768A1214")
private val RAWMODE_CHAR_UUID     = UUID.fromString("19B10014-E8F2-537E-4F6C-D104768A1214")
private val SETTINGS_SERVICE_UUID = UUID.fromString("19B10010-E8F2-537E-4F6C-D104768A1214")
private val MODE_CHAR_UUID        = UUID.fromString("19B10018-E8F2-537E-4F6C-D104768A1214")
private val ARM_CHAR_UUID         = UUID.fromString("19B10019-E8F2-537E-4F6C-D104768A1214")
private val DELTA_CHAR_UUID       = UUID.fromString("19B1001A-E8F2-537E-4F6C-D104768A1214")
private val MIN_INTEGRALS_CHAR_UUID = UUID.fromString("19B1001B-E8F2-537E-4F6C-D104768A1214")
private val DIAG_MODE_CHAR_UUID     = UUID.fromString("19B1001C-E8F2-537E-4F6C-D104768A1214")
private val BATTERY_SERVICE_UUID  = UUID.fromString("0000180F-0000-1000-8000-00805F9B34FB")
private val BATTERY_CHAR_UUID     = UUID.fromString("00002A19-0000-1000-8000-00805F9B34FB")
private val CCCD_UUID             = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")

private const val CHANNEL_ID      = "wristturn_ble"
private const val NOTIF_ID        = 1
private const val RETRY_DELAY_MS  = 2000L
private const val DIRECT_CONNECT_TIMEOUT_MS = 4000L

class BLEForegroundService : Service() {

    inner class LocalBinder : Binder() {
        fun getService(): BLEForegroundService = this@BLEForegroundService
    }

    private val binder = LocalBinder()
    private val handler = Handler(Looper.getMainLooper())

    private var reactContext: ReactApplicationContext? = null
    private var bluetoothGatt: BluetoothGatt? = null
    private var scanning = false
    private var connected = false
    private var sleeping = false
    private var deviceName = "WristTurn"
    private var lastDeviceAddress: String? = null
    private var batteryPct: Int = -1

    // GATT operations must be serialised — Android silently drops concurrent writes.
    private val gattQueue: ArrayDeque<() -> Unit> = ArrayDeque()
    private var gattBusy = false

    private fun enqueueGatt(op: () -> Unit) {
        gattQueue.addLast(op)
        drainGattQueue()
    }

    private fun drainGattQueue() {
        if (gattBusy) {
            android.util.Log.d("WristTurn", "drainGattQueue: busy, queue size=${gattQueue.size}")
            return
        }
        if (gattQueue.isEmpty()) return
        gattBusy = true
        gattQueue.removeFirst().invoke()
    }

    private fun gattOpDone() {
        gattBusy = false
        drainGattQueue()
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onBind(intent: Intent): IBinder = binder

    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON  -> handleBluetoothOn()
                BluetoothAdapter.STATE_OFF -> handleBluetoothOff()
            }
        }
    }

    /**
     * Tear down all BT resources on adapter-OFF.
     * Must null out every handle derived from the adapter because Android may
     * invalidate them when the stack restarts. Cancels pending retries so a
     * stale timer can't call ensureConnected() before the stack is back up.
     */
    private fun handleBluetoothOff() {
        android.util.Log.i("WristTurn", "Bluetooth turned off — tearing down")
        handler.removeCallbacksAndMessages(null)
        stopScan()                // properly deregisters the scan callback
        teardownGatt()
        connected = false
        emit("BLE_DISCONNECTED", emptyMap<String, Any>())
    }

    /**
     * Resume operation on adapter-ON.
     * We defer by 500ms to let the stack settle, and explicitly stopScan() first
     * to clear any ghost scanner registration that survived the adapter cycle
     * (seen on MediaTek devices — new scans silently return zero results otherwise).
     */
    private fun handleBluetoothOn() {
        android.util.Log.i("WristTurn", "Bluetooth turned on — restarting")
        handler.postDelayed({
            stopScan()
            ensureConnected()
        }, 500)
    }

    /** Close and null the GATT handle. Safe to call when already null. */
    private fun teardownGatt() {
        bluetoothGatt?.close()
        bluetoothGatt = null
        gattQueue.clear()
        gattBusy = false
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIF_ID, buildNotification("Scanning for WristTurn..."))
        registerReceiver(bluetoothStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureConnected()
        return START_STICKY
    }

    override fun onDestroy() {
        unregisterReceiver(bluetoothStateReceiver)
        stopScan()
        teardownGatt()
        super.onDestroy()
    }

    /**
     * Centralized peer-disconnect handler — called from GATT callback on any
     * non-CONNECTED state. Clears per-session state and schedules a reconnect.
     */
    private fun handleGattDisconnected(status: Int) {
        connected = false
        lastDeviceAddress = null
        teardownGatt()
        emit("BLE_DISCONNECTED", mapOf("reason" to status))
        updateNotification(if (sleeping) "WristTurn sleeping" else "Scanning for WristTurn...")
        scheduleRetry()
    }

    fun setReactContext(ctx: ReactApplicationContext) {
        reactContext = ctx
    }

    // ── Public API (called from BLEServiceModule) ─────────────────────────────

    fun getState(): Map<String, Any?> = mapOf(
        "connected" to connected,
        "sleeping"  to sleeping,
        "deviceName" to deviceName,
        "batteryPct" to batteryPct,
    )

    fun setRawMode(enabled: Boolean) {
        writeCharBytes(GESTURE_SERVICE_UUID, RAWMODE_CHAR_UUID, byteArrayOf((if (enabled) 1 else 0).toByte()))
    }

    fun setMode(mode: Int) {
        writeCharBytes(SETTINGS_SERVICE_UUID, MODE_CHAR_UUID, byteArrayOf(mode.toByte()))
    }

    fun setArmed(armed: Boolean) {
        writeCharBytes(SETTINGS_SERVICE_UUID, ARM_CHAR_UUID, byteArrayOf((if (armed) 1 else 0).toByte()))
    }

    fun setBaseline(roll: Float, pitch: Float, yaw: Float) {
        val bytes = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN).apply {
            putFloat(roll)
            putFloat(pitch)
            putFloat(yaw)
        }.array()
        writeCharBytes(GESTURE_SERVICE_UUID, BASELINE_CHAR_UUID, bytes)
    }

    /**
     * Write packed per-axis MIN_INTEGRAL thresholds.
     *   high byte = pitch threshold ×100   (e.g. 30 → 0.30 rad)
     *   low byte  = roll/yaw threshold ×100
     * Caller is expected to clamp each byte to 10..100 before calling.
     */
    fun setMinIntegrals(packed: Int) {
        val bytes = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN)
            .putShort((packed and 0xFFFF).toShort())
            .array()
        writeCharBytes(SETTINGS_SERVICE_UUID, MIN_INTEGRALS_CHAR_UUID, bytes)
    }

    /** Toggle diagnostic firehose. Default off. Independent from rawMode. */
    fun setDiagMode(enabled: Boolean) {
        writeCharBytes(SETTINGS_SERVICE_UUID, DIAG_MODE_CHAR_UUID,
            byteArrayOf((if (enabled) 1 else 0).toByte()))
    }

    private fun writeCharBytes(serviceUuid: UUID, charUuid: UUID, bytes: ByteArray) {
        enqueueGatt {
            val gatt = bluetoothGatt
            if (gatt == null) {
                android.util.Log.w("WristTurn", "write: no active GATT for $charUuid")
                gattOpDone()
                return@enqueueGatt
            }
            val svc = gatt.getService(serviceUuid)
            if (svc == null) {
                android.util.Log.w("WristTurn", "write: service $serviceUuid not found for $charUuid")
                gattOpDone()
                return@enqueueGatt
            }
            val chr = svc.getCharacteristic(charUuid)
            if (chr == null) {
                android.util.Log.w("WristTurn", "write: char $charUuid not found in service $serviceUuid")
                gattOpDone()
                return@enqueueGatt
            }

            chr.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(chr, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                chr.value = bytes
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(chr)
            }

            if (ok) {
                android.util.Log.i("WristTurn", "write sent: $charUuid (${bytes.size}B)")
            } else {
                android.util.Log.e("WristTurn", "write failed to start: $charUuid")
                gattOpDone()
            }
        }
    }

    // ── Connection management ─────────────────────────────────────────────────

    private fun ensureConnected() {
        if (connected || scanning) return
        val addr = lastDeviceAddress
        if (addr != null) {
            // Try direct connect first — faster than scanning
            tryDirectConnect(addr)
        } else {
            startScan()
        }
    }

    private fun tryDirectConnect(address: String) {
        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = bm.adapter ?: return
        val device = try { adapter.getRemoteDevice(address) } catch (e: Exception) { null }
        if (device == null) { startScan(); return }

        connectToDevice(device)

        // If direct connect doesn't succeed within timeout, fall back to scan
        handler.postDelayed({
            if (!connected) {
                teardownGatt()
                startScan()
            }
        }, DIRECT_CONNECT_TIMEOUT_MS)
    }

    private fun startScan() {
        if (scanning) return
        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val scanner = bm.adapter?.bluetoothLeScanner ?: run {
            emit("BLE_ERROR", mapOf("msg" to "bluetoothLeScanner unavailable"))
            scheduleRetry()
            return
        }
        scanning = true

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            // No UUID filter — 128-bit UUID filters are unreliable on some Android devices.
            // We filter by service UUID in onScanResult instead.
            scanner.startScan(null, settings, scanCallback)
        } catch (e: SecurityException) {
            scanning = false
            emit("BLE_ERROR", mapOf("msg" to "startScan SecurityException: ${e.message}"))
            scheduleRetry()
        } catch (e: Exception) {
            scanning = false
            emit("BLE_ERROR", mapOf("msg" to "startScan failed: ${e.message}"))
            scheduleRetry()
        }
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        bm.adapter?.bluetoothLeScanner?.stopScan(scanCallback)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name  = result.device.name ?: result.scanRecord?.deviceName ?: ""
            val uuids = result.scanRecord?.serviceUuids
            val hasServiceUuid = uuids != null && uuids.any { it.uuid == GESTURE_SERVICE_UUID }
            val hasName        = name.startsWith("RUNE") || name == "WristTurn"
            android.util.Log.i("WristTurn", "scan result: name='$name' uuids=$uuids hasServiceUuid=$hasServiceUuid hasName=$hasName")
            if (!hasServiceUuid && !hasName) return
            stopScan()
            connectToDevice(result.device)
        }
        override fun onScanFailed(errorCode: Int) {
            android.util.Log.e("WristTurn", "scan failed errorCode=$errorCode")
            emit("BLE_ERROR", mapOf("msg" to "scan failed errorCode=$errorCode"))
            // errorCode=1 (ALREADY_STARTED): Android still has old callback registered.
            // Stop explicitly to clear it, then retry with a longer delay.
            stopScan()
            handler.postDelayed({ ensureConnected() }, if (errorCode == 1) 3000L else RETRY_DELAY_MS)
        }
    }

    private fun connectToDevice(device: BluetoothDevice) {
        bluetoothGatt?.close()
        bluetoothGatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private fun scheduleRetry() {
        handler.postDelayed({ ensureConnected() }, RETRY_DELAY_MS)
    }

    // ── GATT callbacks ────────────────────────────────────────────────────────

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                gatt.discoverServices()
            } else {
                handleGattDisconnected(status)
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                android.util.Log.e("WristTurn", "onServicesDiscovered failed: status=$status")
                gatt.disconnect()
                return
            }

            lastDeviceAddress = gatt.device.address
            deviceName = gatt.device.name ?: "WristTurn"
            connected = true
            sleeping = false

            // Negotiate MTU before subscribing — nRF52840 supports 247 bytes.
            // Subscriptions start in onMtuChanged; if negotiation fails we fall back there too.
            android.util.Log.i("WristTurn", "services discovered, requesting MTU=247")
            gatt.requestMtu(247)
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            android.util.Log.i("WristTurn", "MTU negotiated: $mtu (status=$status)")

            android.util.Log.i("WristTurn", "queuing subscriptions")

            // Unsubscribe then re-subscribe each char for idempotent setup
            subscribeToChar(gatt, GESTURE_SERVICE_UUID, GESTURE_CHAR_UUID)
            subscribeToChar(gatt, GESTURE_SERVICE_UUID, STATE_CHAR_UUID)
            subscribeToChar(gatt, BATTERY_SERVICE_UUID, BATTERY_CHAR_UUID)
            subscribeToChar(gatt, SETTINGS_SERVICE_UUID, DELTA_CHAR_UUID)

            // Read battery after subscriptions
            enqueueGatt {
                val read = gatt.getService(BATTERY_SERVICE_UUID)
                    ?.getCharacteristic(BATTERY_CHAR_UUID)
                if (read == null) { gattOpDone(); return@enqueueGatt }
                gatt.readCharacteristic(read)
            }

            // Emit BLE_CONNECTED only after all subscriptions + battery read are done
            enqueueGatt {
                android.util.Log.i("WristTurn", "all subscriptions confirmed, emitting BLE_CONNECTED")
                emit("BLE_CONNECTED", mapOf("name" to deviceName, "address" to gatt.device.address))
                updateNotification("$deviceName connected")
                gattOpDone()
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            val charUuid = descriptor.characteristic.uuid
            if (status == BluetoothGatt.GATT_SUCCESS) {
                android.util.Log.i("WristTurn", "onDescriptorWrite OK: $charUuid — subscribed")
            } else {
                android.util.Log.e("WristTurn", "onDescriptorWrite FAILED: $charUuid status=$status — NOT subscribed")
            }
            gattOpDone()
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            handleCharValue(characteristic.uuid, value)
        }

        // API < 33 fallback
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            handleCharValue(characteristic.uuid, characteristic.value ?: return)
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) handleCharValue(characteristic.uuid, value)
            gattOpDone()
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS)
                handleCharValue(characteristic.uuid, characteristic.value ?: ByteArray(0))
            gattOpDone()
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                android.util.Log.i("WristTurn", "onCharacteristicWrite OK: ${characteristic.uuid}")
            } else {
                android.util.Log.e("WristTurn", "onCharacteristicWrite FAILED: ${characteristic.uuid} status=$status")
            }
            gattOpDone()
        }
    }

    private fun subscribeToChar(gatt: BluetoothGatt, serviceUuid: UUID, charUuid: UUID) {
        enqueueGatt {
            val svc = gatt.getService(serviceUuid)
            if (svc == null) {
                android.util.Log.w("WristTurn", "subscribe: service $serviceUuid not found")
                gattOpDone(); return@enqueueGatt
            }
            val chr = svc.getCharacteristic(charUuid)
            if (chr == null) {
                android.util.Log.w("WristTurn", "subscribe: char $charUuid not found in service $serviceUuid")
                gattOpDone(); return@enqueueGatt
            }
            val descriptor = chr.getDescriptor(CCCD_UUID)
            if (descriptor == null) {
                android.util.Log.w("WristTurn", "subscribe: no CCCD on $charUuid — skipping")
                gattOpDone(); return@enqueueGatt
            }

            // Disable first (idempotent — clears any stale subscription from prior session)
            gatt.setCharacteristicNotification(chr, false)

            // Re-enable
            gatt.setCharacteristicNotification(chr, true)

            val ok: Boolean
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val result = gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                ok = (result == BluetoothGatt.GATT_SUCCESS)
            } else {
                @Suppress("DEPRECATION")
                descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                ok = gatt.writeDescriptor(descriptor)
            }

            if (ok) {
                android.util.Log.i("WristTurn", "subscribe: writeDescriptor sent for $charUuid — awaiting onDescriptorWrite")
            } else {
                android.util.Log.e("WristTurn", "subscribe: writeDescriptor FAILED for $charUuid — releasing queue")
                gattOpDone()
            }
        }
    }

    // ── Payload parsing ───────────────────────────────────────────────────────

    private fun handleCharValue(uuid: UUID, value: ByteArray) {
        android.util.Log.d("WristTurn", "char notify: $uuid (${value.size}B) hex=${value.take(4).joinToString("") { "%02X".format(it) }}")
        when (uuid) {
            GESTURE_CHAR_UUID -> handleGesturePayload(value)
            STATE_CHAR_UUID   -> handleStatePayload(value)
            BATTERY_CHAR_UUID -> handleBatteryPayload(value)
            DELTA_CHAR_UUID   -> handleDeltaPayload(value)
            else              -> android.util.Log.w("WristTurn", "unhandled char: $uuid")
        }
    }

    private val GESTURE_NAMES = setOf(
        "turn_right", "turn_left", "pitch_up", "pitch_down",
        "yaw_right", "yaw_left", "tap", "shake", "step", "idle"
    )

    private fun handleGesturePayload(value: ByteArray) {
        val raw = String(value, Charsets.UTF_8).trimEnd('\u0000', ' ').trim()
        if (raw.isEmpty() || raw == "ping") return

        val parts = raw.split("|")
        val name = parts[0].trim()

        // Raw IMU stream
        if (name == "raw" && parts.size >= 4) {
            emit("BLE_RAW", mapOf(
                "roll"  to parts[1].toFloatOrNull(),
                "pitch" to parts[2].toFloatOrNull(),
                "yaw"   to parts[3].toFloatOrNull(),
            ))
            return
        }

        // Diag firehose — every sample of every IMU report when diagMode is
        // enabled. Tag carries the source: gyr / lacc / grav / ypr.
        // Three-letter prefixes (dgr / dla / dgv / dyp) keep the wire format
        // short to fit inside the 40-byte gestureChar buffer.
        if (parts.size >= 4 && (name == "dgr" || name == "dla" || name == "dgv" || name == "dyp")) {
            val tag = when (name) {
                "dgr" -> "GYR"
                "dla" -> "LACC"
                "dgv" -> "GRAV"
                "dyp" -> "YPR"
                else  -> name
            }
            emit("BLE_DIAG", mapOf(
                "type" to tag,
                "x"    to parts[1].toFloatOrNull(),
                "y"    to parts[2].toFloatOrNull(),
                "z"    to parts[3].toFloatOrNull(),
            ))
            return
        }

        if (!GESTURE_NAMES.contains(name) || name == "idle") return

        val payload = mutableMapOf<String, Any?>("name" to name)
        if (parts.size >= 4) {
            payload["roll"]  = parts[1].toFloatOrNull()
            payload["pitch"] = parts[2].toFloatOrNull()
            payload["yaw"]   = parts[3].toFloatOrNull()
        }
        if (parts.size >= 5) payload["delta"] = parts[4].toFloatOrNull()
        if (parts.size == 2) payload["value"] = parts[1].toFloatOrNull()

        emit("BLE_GESTURE", payload)
    }

    /**
     * Parse a binary state packet from stateChar.
     * Schema lives in wristturn_audrino/wristturn/state_packet.h (firmware) and
     * wristturn-app/src/ble/StatePacket.ts (app). First byte is the type tag.
     *
     * We forward the raw bytes as a Latin-1 string to JS (RN bridge can't pass
     * ByteArray cleanly without extra glue), where StatePacket.ts decodes them.
     * Sleep/wake side-effects are handled here too so the native notification
     * stays accurate even when the JS thread is paused.
     */
    private fun handleStatePayload(value: ByteArray) {
        if (value.isEmpty()) return
        val tag = value[0].toInt() and 0xFF
        android.util.Log.i("WristTurn", "STATE rx (${value.size}B): tag=0x${"%02X".format(tag)}")

        // Latin-1 byte-to-char packing — round-trips losslessly through the RN bridge.
        val sb = StringBuilder(value.size)
        for (b in value) sb.append((b.toInt() and 0xFF).toChar())
        emit("BLE_STATE", mapOf("raw" to sb.toString()))

        when (tag) {
            0x04 -> {  // PKT_SLEEP
                sleeping = true
                updateNotification("WristTurn sleeping")
                emit("BLE_SLEEPING", emptyMap<String, Any>())
            }
            0x05 -> {  // PKT_WAKE
                sleeping = false
                updateNotification("$deviceName connected")
            }
        }
    }

    private fun handleBatteryPayload(value: ByteArray) {
        if (value.isEmpty()) return
        batteryPct = value[0].toInt() and 0xFF
        emit("BLE_BATTERY", mapOf("pct" to batteryPct))
    }

    private fun handleDeltaPayload(value: ByteArray) {
        if (value.size < 12) return
        val bb = ByteBuffer.wrap(value).order(ByteOrder.LITTLE_ENDIAN)
        emit("BLE_DELTA", mapOf(
            "roll"  to bb.float,
            "pitch" to bb.float,
            "yaw"   to bb.float,
        ))
    }

    // ── Event emission ────────────────────────────────────────────────────────

    private fun emit(event: String, data: Map<String, Any?>) {
        val ctx = reactContext
        if (ctx == null) {
            android.util.Log.w("WristTurn", "emit($event) DROPPED — reactContext is null")
            return
        }
        try {
            val params = com.facebook.react.bridge.Arguments.createMap()
            data.forEach { (k, v) ->
                when (v) {
                    is String  -> params.putString(k, v)
                    is Int     -> params.putInt(k, v)
                    is Float   -> params.putDouble(k, v.toDouble())
                    is Double  -> params.putDouble(k, v)
                    is Boolean -> params.putBoolean(k, v)
                    null       -> params.putNull(k)
                    else       -> params.putString(k, v.toString())
                }
            }
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        } catch (_: Exception) {}
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "WristTurn BLE", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "WristTurn gesture connection" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String) = run {
        val intent = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("WristTurn")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }
}
