package expo.modules.androidtv

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetSocketAddress
import java.security.cert.X509Certificate
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLContext
import kotlin.concurrent.thread

private const val TAG = "AndroidTVModule"
private const val CONNECT_TIMEOUT_MS = 5000
private const val IO_TIMEOUT_MS = 5000

class AndroidtvModule : Module() {

    private var pairingSocket: SSLSocket? = null
    private var remoteSocket: SSLSocket? = null
    private val commandQueue = LinkedBlockingQueue<Pair<ByteArray, Long>>(64)
    private var clientCert: X509Certificate? = null
    private var clientPrivateKey: java.security.PrivateKey? = null
    private var serverCert: X509Certificate? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var trustManager: TrustManager? = null
    private var host: String = ""

    override fun definition() = ModuleDefinition {
        Name("AndroidTV")

        Events("onSecret", "onReady", "onError", "onVolume", "onCurrentApp")

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

                val filesDir = appContext.reactContext?.filesDir
                    ?: throw Exception("No files dir")

                // Always generate fresh identity for pairing
                val (ctx, privateKey, cert) = createSSLContext(tm)
                clientPrivateKey = privateKey

                val sock = createTimedTlsSocket(ctx, host, 6467)
                pairingSocket = sock
                clientCert = (sock.session.localCertificates?.firstOrNull()) as? X509Certificate
                serverCert = tm.serverCert
                Log.d(TAG, "startPairing handshake done clientCert=${clientCert != null} serverCert=${serverCert != null}")

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
                val pk   = clientPrivateKey ?: throw Exception("No client key")

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

                // Pairing succeeded — persist the client identity so reconnects skip pairing
                val filesDir = appContext.reactContext?.filesDir
                if (filesDir != null) {
                    saveClientIdentity(filesDir, this@AndroidtvModule.host, pk, cc)
                }

                connectRemote()
            } catch (e: Exception) {
                val root = generateSequence(e as Throwable?) { it.cause }.lastOrNull()
                val msg = root?.message ?: e.message ?: "unknown"
                Log.e(TAG, "sendCode failed: $msg", e)
                sendEvent("onError", mapOf("message" to msg))
                throw Exception(msg, e)
            }
        }

        // Connect to already-paired TV (skips pairing if identity is saved)
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

        AsyncFunction("sendKey") { keyCode: Int ->
            if (remoteSocket == null) throw Exception("Not connected")
            val enqueuedAt = System.currentTimeMillis()
            Log.d(TAG, "sendKey enqueue keyCode=$keyCode t=${enqueuedAt}")
            commandQueue.offer(Pair(keyEventMessage(keyCode, 3), enqueuedAt))
        }

        AsyncFunction("sendAppLink") { url: String ->
            if (remoteSocket == null) throw Exception("Not connected")
            val enqueuedAt = System.currentTimeMillis()
            Log.d(TAG, "sendAppLink enqueue url=$url t=${enqueuedAt}")
            commandQueue.offer(Pair(appLinkMessage(url), enqueuedAt))
        }

        AsyncFunction("disconnect") {
            remoteSocket?.close()
            remoteSocket = null
            Log.d(TAG, "disconnect complete")
        }

        // Call this to force re-pairing for a specific host (clears saved identity)
        AsyncFunction("forgetPairing") { host: String ->
            val filesDir = appContext.reactContext?.filesDir
            if (filesDir != null) {
                forgetClientIdentity(filesDir, host)
            }
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

        // Use saved identity if available (prevents need to re-pair)
        val filesDir = appContext.reactContext?.filesDir
        val savedIdentity = if (filesDir != null) loadClientIdentity(filesDir, host) else null
        val (ctx, _, _) = createSSLContext(tm, savedIdentity)

        val sock = createTimedTlsSocket(ctx, host, 6466)
        remoteSocket = sock
        Log.d(TAG, "connectRemote handshake done; emitting onReady")

        sendEvent("onReady", mapOf<String, Any>())

        // Writer thread — drains commandQueue serially, measures enqueue→send latency
        commandQueue.clear()
        thread {
            try {
                val os = sock.outputStream
                while (!sock.isClosed) {
                    val item = commandQueue.poll(5, TimeUnit.SECONDS) ?: continue
                    val (msg, enqueuedAt) = item
                    val sentAt = System.currentTimeMillis()
                    os.write(msg)
                    os.flush()
                    Log.d(TAG, "sendKey sent queueLatency=${sentAt - enqueuedAt}ms")
                }
            } catch (e: Exception) {
                Log.w(TAG, "writer thread exit: ${e.message}")
            }
        }

        // Reader thread — handles pings and TV-initiated frames
        thread {
            try {
                val ins = sock.inputStream
                sock.soTimeout = 0
                while (!sock.isClosed) {
                    val frame = readFrame(ins) ?: break
                    handleRemoteFrame(sock, frame)
                }
            } catch (e: Exception) {
                Log.w(TAG, "remote reader exit: ${e.message}")
            }
            remoteSocket = null
            commandQueue.clear()
            sendEvent("onError", mapOf("message" to "disconnected"))
        }
    }

    private fun handleRemoteFrame(sock: SSLSocket, frame: ByteArray) {
        if (frame.isEmpty()) return
        val tag = frame[0].toInt() and 0xFF
        val fieldNumber = tag ushr 3
        Log.d(TAG, "handleRemoteFrame field=$fieldNumber frameLen=${frame.size}")

        when (fieldNumber) {
            1 -> {
                // remote_configure — TV sends its features, we reply with ours
                // Features: PING=1, KEY=2, POWER=32, VOLUME=64, APP_LINK=512 → 611
                val features = 1 or 2 or 32 or 64 or 512
                try {
                    sock.outputStream.write(configurMessage(features))
                    sock.outputStream.flush()
                    Log.d(TAG, "remote_configure reply sent features=$features")
                } catch (e: Exception) {
                    Log.w(TAG, "configure reply failed: ${e.message}")
                }
            }
            8 -> {
                // remote_ping_request (field 8) — extract val1 and echo as remote_ping_response (field 9)
                try {
                    // frame = [tag] [len_varint] [inner: field1=val1, field2=val2]
                    // Extract val1 from inner — first field (tag=0x08, then varint)
                    var i = 1
                    // skip length varint of field 8
                    while (i < frame.size && (frame[i].toInt() and 0x80) != 0) i++
                    i++ // past last byte of length varint
                    // now at inner payload; read first field tag + val1
                    var val1 = 0
                    if (i < frame.size) {
                        i++ // skip inner tag (0x08 = field1, varint)
                        var shift = 0
                        while (i < frame.size) {
                            val b = frame[i++].toInt() and 0xFF
                            val1 = val1 or ((b and 0x7F) shl shift); shift += 7
                            if ((b and 0x80) == 0) break
                        }
                    }
                    // Build response: RemoteMessage { remote_ping_response(9) { val1(1) = val1 } }
                    val inner = int32Field(1, val1)
                    val pong  = frameMessage(lengthDelimited(9, inner))
                    sock.outputStream.write(pong)
                    sock.outputStream.flush()
                    Log.d(TAG, "pong sent val1=$val1")
                } catch (e: Exception) {
                    Log.w(TAG, "pong failed: ${e.message}")
                }
            }
        }
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
        socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
        socket.soTimeout = IO_TIMEOUT_MS // only for handshake
        socket.startHandshake()
        socket.soTimeout = 0 // no timeout after handshake
        return socket
    }
}
