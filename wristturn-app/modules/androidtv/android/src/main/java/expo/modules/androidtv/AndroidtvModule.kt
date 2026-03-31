package expo.modules.androidtv

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetSocketAddress
import java.security.cert.X509Certificate
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLContext
import kotlin.concurrent.thread

private const val TAG = "AndroidTVModule"
private const val CONNECT_TIMEOUT_MS = 5000
private const val IO_TIMEOUT_MS = 5000

class AndroidtvModule : Module() {

    private var pairingSocket: SSLSocket? = null
    private var remoteSocket: SSLSocket? = null
    private var clientCert: X509Certificate? = null
    private var serverCert: X509Certificate? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var trustManager: TrustManager? = null
    private var host: String = ""

    override fun definition() = ModuleDefinition {
        Name("AndroidTV")

        Events("onSecret", "onReady", "onError", "onVolume", "onCurrentApp")

        // Acquire multicast lock so mDNS works on Android
        OnCreate {
            val wifiManager = appContext.reactContext
                ?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            multicastLock = wifiManager?.createMulticastLock("wristturn.mdns")
            multicastLock?.setReferenceCounted(true)
            multicastLock?.acquire()
        }

        OnDestroy {
            multicastLock?.release()
            multicastLock = null
        }

        // Start pairing with a TV at the given host
        AsyncFunction("startPairing") { host: String ->
            this@AndroidtvModule.host = host
            try {
                Log.d(TAG, "startPairing begin host=$host")
                val tm = TrustManager()
                this@AndroidtvModule.trustManager = tm

                // Build TLS context with client key material + trust manager.
                val (ctx, _) = createSSLContext(tm)
                val sock = createTimedTlsSocket(ctx, host, 6467)

                pairingSocket = sock
                clientCert = (sock.session.localCertificates?.firstOrNull()) as? X509Certificate
                serverCert = tm.serverCert
                Log.d(
                    TAG,
                    "startPairing handshake done clientCert=${clientCert != null} serverCert=${serverCert != null}"
                )

                val os = sock.outputStream
                val ins = sock.inputStream

                Log.d(TAG, "startPairing sending PairingRequest")
                os.write(pairingRequest("atvremote", "WristTurn"))
                os.flush()
                val ack1 = readFrame(ins) ?: throw Exception("No PairingRequestAck")
                Log.d(TAG, "startPairing PairingRequestAck received bytes=${ack1.size} status=${extractStatus(ack1)}")

                Log.d(TAG, "startPairing sending Options")
                os.write(optionsMessage())
                os.flush()
                val ack2 = readFrame(ins) ?: throw Exception("No PairingOption")
                Log.d(TAG, "startPairing PairingOption received bytes=${ack2.size} status=${extractStatus(ack2)}")

                Log.d(TAG, "startPairing sending Configuration")
                os.write(configurationMessage())
                os.flush()
                val ack3 = readFrame(ins) ?: throw Exception("No ConfigurationAck")
                Log.d(TAG, "startPairing ConfigurationAck received bytes=${ack3.size} status=${extractStatus(ack3)}; emitting onSecret")

                sendEvent("onSecret", mapOf<String, Any>())
            } catch (e: Exception) {
                val root = generateSequence(e as Throwable?) { it.cause }.lastOrNull()
                val msg = root?.message ?: e.message ?: "unknown error"
                Log.e(TAG, "startPairing failed: $msg", e)
                sendEvent("onError", mapOf("message" to msg))
                throw Exception(msg, e)
            }
        }

        // User has entered the PIN shown on TV
        AsyncFunction("sendCode") { code: String ->
            try {
                Log.d(TAG, "sendCode begin code=$code codeLength=${code.length}")
                val sock = pairingSocket ?: throw Exception("Not pairing")
                val cc   = clientCert   ?: throw Exception("No client cert")
                val sc   = serverCert   ?: throw Exception("No server cert")

                val os = sock.outputStream
                val ins = sock.inputStream

                os.write(secretMessage(cc, sc, code))
                os.flush()
                val ack = readFrame(ins) ?: throw Exception("No SecretAck")
                val status = extractStatus(ack)
                if (status != null && status != 200) {
                    throw Exception("Pairing rejected by TV (status=$status)")
                }
                Log.d(TAG, "sendCode SecretAck received bytes=${ack.size} status=$status")

                sock.close()
                pairingSocket = null

                connectRemote()
            } catch (e: Exception) {
                val root = generateSequence(e as Throwable?) { it.cause }.lastOrNull()
                val msg = root?.message ?: e.message ?: "unknown"
                Log.e(TAG, "sendCode failed: $msg", e)
                sendEvent("onError", mapOf("message" to msg))
                throw Exception(msg, e)
            }
        }

        // Connect to already-paired TV (after pairing is done)
        AsyncFunction("connect") { host: String ->
            this@AndroidtvModule.host = host
            try {
                Log.d(TAG, "connect begin host=$host")
                connectRemote()
            } catch (e: Exception) {
                val msg = e.message ?: "connect failed"
                Log.e(TAG, "connect failed: $msg", e)
                sendEvent("onError", mapOf("message" to msg))
                throw Exception(msg, e)
            }
        }

        // Send a keycode (SHORT press)
        AsyncFunction("sendKey") { keyCode: Int ->
            try {
                val os = remoteSocket?.outputStream ?: throw Exception("Not connected")
                os.write(keyEventMessage(keyCode, 2))
                os.flush()
            } catch (e: Exception) {
                val msg = e.message ?: "send key failed"
                Log.e(TAG, "sendKey failed: $msg", e)
                throw Exception(msg, e)
            }
        }

        // Launch an app by deep link URL
        AsyncFunction("sendAppLink") { url: String ->
            try {
                val os = remoteSocket?.outputStream ?: throw Exception("Not connected")
                os.write(appLinkMessage(url))
                os.flush()
            } catch (e: Exception) {
                val msg = e.message ?: "send app link failed"
                Log.e(TAG, "sendAppLink failed: $msg", e)
                throw Exception(msg, e)
            }
        }

        AsyncFunction("disconnect") {
            remoteSocket?.close()
            remoteSocket = null
            Log.d(TAG, "disconnect complete")
        }
    }

    private fun connectRemote() {
        val existing = remoteSocket
        if (existing != null && existing.isConnected && !existing.isClosed) {
            Log.d(TAG, "connectRemote already connected; emitting onReady")
            sendEvent("onReady", mapOf<String, Any>())
            return
        }

        Log.d(TAG, "connectRemote begin host=$host")
        val tm = TrustManager()
        val (ctx, _) = createSSLContext(tm)

        val sock = createTimedTlsSocket(ctx, host, 6466)
        remoteSocket = sock
        Log.d(TAG, "connectRemote handshake done; emitting onReady")

        sendEvent("onReady", mapOf<String, Any>())

        // Read incoming events (volume, current app) in background
        thread {
            try {
                val ins = sock.inputStream
                while (!sock.isClosed) {
                    val frame = readFrame(ins) ?: break
                    handleRemoteFrame(frame)
                }
            } catch (_: Exception) {}
        }
    }

    private fun handleRemoteFrame(frame: ByteArray) {
        // Parse top-level RemoteMessage fields
        // Field 7 = volume event, field 10 = current_app
        // Minimal parse: just emit raw for now
    }

    private fun readFrame(ins: java.io.InputStream): ByteArray? {
        val len = readVarint(ins) ?: return null

        val payload = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = ins.read(payload, read, len - read)
            if (n < 0) return null
            read += n
        }
        return payload
    }

    private fun readVarint(ins: java.io.InputStream): Int? {
        var shift = 0
        var result = 0
        while (shift < 32) {
            val b = ins.read()
            if (b < 0) return null
            result = result or ((b and 0x7F) shl shift)
            if ((b and 0x80) == 0) return result
            shift += 7
        }
        throw Exception("Invalid frame varint length")
    }

    private fun extractStatus(payload: ByteArray): Int? {
        var i = 0
        while (i < payload.size) {
            val (tag, next) = readVarintFromBytes(payload, i) ?: return null
            i = next
            val field = tag ushr 3
            val wire = tag and 0x07
            when (wire) {
                0 -> {
                    val (value, after) = readVarintFromBytes(payload, i) ?: return null
                    if (field == 2) return value
                    i = after
                }
                2 -> {
                    val (len, afterLen) = readVarintFromBytes(payload, i) ?: return null
                    i = afterLen + len
                    if (i > payload.size) return null
                }
                else -> return null
            }
        }
        return null
    }

    private fun readVarintFromBytes(buf: ByteArray, start: Int): Pair<Int, Int>? {
        var i = start
        var shift = 0
        var result = 0
        while (i < buf.size && shift < 32) {
            val b = buf[i].toInt() and 0xFF
            i += 1
            result = result or ((b and 0x7F) shl shift)
            if ((b and 0x80) == 0) return result to i
            shift += 7
        }
        return null
    }

    private fun createTimedTlsSocket(ctx: SSLContext, host: String, port: Int): SSLSocket {
        val socket = ctx.socketFactory.createSocket() as SSLSocket
        socket.soTimeout = IO_TIMEOUT_MS
        socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
        socket.startHandshake()
        return socket
    }
}
