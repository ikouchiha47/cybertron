package expo.modules.androidtv

import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.math.BigInteger
import java.util.Date
import javax.net.ssl.*
import kotlin.concurrent.thread

private const val TAG = "AndroidTVRemote"
private const val PAIRING_PORT = 6467
private const val REMOTE_PORT  = 6466

// ── Minimal protobuf encoding helpers ────────────────────────────────────────

internal fun varint(value: Int): ByteArray {
    val buf = mutableListOf<Byte>()
    var v = value
    while (v and 0x7F.inv() != 0) {
        buf.add(((v and 0x7F) or 0x80).toByte())
        v = v ushr 7
    }
    buf.add((v and 0x7F).toByte())
    return buf.toByteArray()
}

internal fun field(fieldNumber: Int, wireType: Int, payload: ByteArray): ByteArray {
    val tag = (fieldNumber shl 3) or wireType
    return varint(tag) + payload
}

internal fun lengthDelimited(fieldNumber: Int, data: ByteArray): ByteArray {
    return field(fieldNumber, 2, varint(data.size) + data)
}

internal fun stringField(fieldNumber: Int, value: String): ByteArray {
    return lengthDelimited(fieldNumber, value.toByteArray(Charsets.UTF_8))
}

internal fun bytesField(fieldNumber: Int, value: ByteArray): ByteArray {
    return lengthDelimited(fieldNumber, value)
}

internal fun int32Field(fieldNumber: Int, value: Int): ByteArray {
    return field(fieldNumber, 0, varint(value))
}

// ── Pairing messages ──────────────────────────────────────────────────────────
// Based on Google's Polo pairing protocol (open source)

internal fun pairingRequest(serviceName: String, clientName: String): ByteArray {
    val inner = stringField(1, serviceName) + stringField(2, clientName)
    val outer = int32Field(1, 2) +        // protocol_version = 2
                int32Field(2, 200) +      // status = OK
                lengthDelimited(10, inner) // field 10 = pairing_request
    return frameMessage(outer)
}

internal fun optionsMessage(): ByteArray {
    // encoding: type=HEXADECIMAL(3), symbol_length=6
    val encoding = int32Field(1, 3) + int32Field(2, 6)
    val options  = lengthDelimited(1, encoding) + // input_encodings
                   lengthDelimited(2, encoding) + // output_encodings
                   int32Field(3, 1)               // preferred_role = INPUT
    val outer    = int32Field(1, 2) + int32Field(2, 200) + lengthDelimited(20, options)
    return frameMessage(outer)
}

internal fun configurationMessage(): ByteArray {
    // encoding: type=HEXADECIMAL(3), symbol_length=6, client_role=INPUT(1)
    val encoding = int32Field(1, 3) + int32Field(2, 6)
    val config   = lengthDelimited(1, encoding) + int32Field(2, 1)
    val outer    = int32Field(1, 2) + int32Field(2, 200) + lengthDelimited(30, config)
    return frameMessage(outer)
}

fun secretMessage(clientCert: X509Certificate, serverCert: X509Certificate, code: String): ByteArray {
    val secret = computeSecret(clientCert, serverCert, code)
    val prefix = secret.take(6).joinToString("") { "%02X".format(it) }
    Log.d(
        TAG,
        "secretMessage built secretLen=${secret.size} secretPrefix=$prefix"
    )
    val inner  = bytesField(1, secret)
    val outer  = int32Field(1, 2) + int32Field(2, 200) + lengthDelimited(40, inner)
    return frameMessage(outer)
}

internal fun computeSecret(
    clientCert: X509Certificate,
    serverCert: X509Certificate,
    code: String
): ByteArray {
    // Protocol from androidtvremote2:
    // sha256(bytes.fromhex(clientMod) + bytes.fromhex(0+clientExp) +
    //        bytes.fromhex(serverMod) + bytes.fromhex(0+serverExp) +
    //        bytes.fromhex(pin[2:]))
    // and hash[0] must match pin[0:2].
    val clientKey = clientCert.publicKey as java.security.interfaces.RSAPublicKey
    val serverKey = serverCert.publicKey as java.security.interfaces.RSAPublicKey

    fun normalizeHex(hex: String): String = if (hex.length % 2 == 0) hex else "0$hex"

    fun hexToBytes(hex: String): ByteArray {
        val h = normalizeHex(hex)
        return ByteArray(h.length / 2) { i ->
            h.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    val pin = code.uppercase()
    if (pin.length != 6) {
        throw IllegalArgumentException("PIN length must be 6")
    }
    pin.toInt(16) // validate hex PIN early

    val clientMod = clientKey.modulus.toString(16).uppercase()
    val clientExp = ("0" + clientKey.publicExponent.toString(16)).uppercase()
    val serverMod = serverKey.modulus.toString(16).uppercase()
    val serverExp = ("0" + serverKey.publicExponent.toString(16)).uppercase()

    val digest = MessageDigest.getInstance("SHA-256")
    digest.update(hexToBytes(clientMod))
    digest.update(hexToBytes(clientExp))
    digest.update(hexToBytes(serverMod))
    digest.update(hexToBytes(serverExp))
    digest.update(hexToBytes(pin.substring(2)))
    val hash = digest.digest()
    val hashPrefix = hash.take(6).joinToString("") { "%02X".format(it) }

    val expectedFirst = pin.substring(0, 2).toInt(16)
    val actualFirst = hash[0].toInt() and 0xFF
    Log.d(
        TAG,
        "computeSecret pin=$pin expectedFirst=%02X actualFirst=%02X clientModBytes=${normalizeHex(clientMod).length / 2} serverModBytes=${normalizeHex(serverMod).length / 2} hashPrefix=$hashPrefix"
            .format(expectedFirst, actualFirst)
    )
    if (actualFirst != expectedFirst) {
        throw IllegalArgumentException("PIN checksum mismatch")
    }
    return hash
}

// ── Remote messages ───────────────────────────────────────────────────────────

fun keyEventMessage(keyCode: Int, direction: Int): ByteArray {
    // direction: 0=START_LONG, 1=END_LONG, 2=SHORT
    val keyEvent = int32Field(1, keyCode) + int32Field(2, direction)
    val outer    = lengthDelimited(3, keyEvent)
    return frameMessage(outer)
}

fun appLinkMessage(appLink: String): ByteArray {
    val linkMsg = stringField(1, appLink)
    val outer   = lengthDelimited(9, linkMsg)
    return frameMessage(outer)
}

// Length-prefix framing: protobuf varint length + payload
internal fun frameMessage(payload: ByteArray): ByteArray {
    return varint(payload.size) + payload
}

// ── TLS helpers ───────────────────────────────────────────────────────────────

fun createSSLContext(
    trustManager: javax.net.ssl.X509TrustManager = TrustManager(),
    existingIdentity: Pair<java.security.PrivateKey, X509Certificate>? = null
): Triple<SSLContext, java.security.PrivateKey, X509Certificate> {
    val (privateKey, cert) = existingIdentity ?: run {
        val kpg = KeyPairGenerator.getInstance("RSA")
        kpg.initialize(2048)
        val kp  = kpg.generateKeyPair()
        kp.private to generateSelfSignedCert(kp)
    }

    val ks = KeyStore.getInstance("PKCS12")
    ks.load(null, null)
    ks.setKeyEntry("client", privateKey, null, arrayOf(cert))

    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
    kmf.init(ks, null)

    val ctx = SSLContext.getInstance("TLS")
    ctx.init(kmf.keyManagers, arrayOf(trustManager), null)
    return Triple(ctx, privateKey, cert)
}

// ── Persistent client identity ────────────────────────────────────────────────

private fun hostKey(host: String) = host.replace(Regex("[^a-zA-Z0-9._-]"), "_")

fun saveClientIdentity(filesDir: java.io.File, host: String, privateKey: java.security.PrivateKey, cert: X509Certificate) {
    val k = hostKey(host)
    java.io.File(filesDir, "atv_${k}.key").writeBytes(privateKey.encoded)
    java.io.File(filesDir, "atv_${k}.crt").writeBytes(cert.encoded)
    Log.d(TAG, "saveClientIdentity saved key+cert for host=$host")
}

fun loadClientIdentity(filesDir: java.io.File, host: String): Pair<java.security.PrivateKey, X509Certificate>? {
    val k = hostKey(host)
    val keyFile = java.io.File(filesDir, "atv_${k}.key")
    val crtFile = java.io.File(filesDir, "atv_${k}.crt")
    if (!keyFile.exists() || !crtFile.exists()) {
        Log.d(TAG, "loadClientIdentity no saved identity for host=$host")
        return null
    }
    return try {
        val keySpec = java.security.spec.PKCS8EncodedKeySpec(keyFile.readBytes())
        val privateKey = java.security.KeyFactory.getInstance("RSA").generatePrivate(keySpec)
        val cert = java.security.cert.CertificateFactory.getInstance("X.509")
            .generateCertificate(crtFile.inputStream()) as X509Certificate
        Log.d(TAG, "loadClientIdentity loaded saved identity for host=$host")
        privateKey to cert
    } catch (e: Exception) {
        Log.w(TAG, "loadClientIdentity failed to load for host=$host, will regenerate", e)
        null
    }
}

fun forgetClientIdentity(filesDir: java.io.File, host: String) {
    val k = hostKey(host)
    java.io.File(filesDir, "atv_${k}.key").delete()
    java.io.File(filesDir, "atv_${k}.crt").delete()
    Log.d(TAG, "forgetClientIdentity cleared identity for host=$host")
}

internal fun generateSelfSignedCert(kp: java.security.KeyPair): X509Certificate {
    // Android includes BouncyCastle; create a local self-signed cert via reflection.
    return createBouncyCastleCert(kp)
}

internal fun createBouncyCastleCert(kp: java.security.KeyPair): X509Certificate {
    val issuer  = "CN=WristTurn"
    val notBefore = Date()
    val notAfter  = Date(notBefore.time + 10L * 365 * 24 * 60 * 60 * 1000)

    // Use Android's bundled BouncyCastle classes via reflection.
    val builderClass = Class.forName("org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder")
    val signerClass  = Class.forName("org.bouncycastle.operator.jcajce.JcaContentSignerBuilder")
    val x500NameClass = Class.forName("org.bouncycastle.asn1.x500.X500Name")
    val contentSignerClass = Class.forName("org.bouncycastle.operator.ContentSigner")
    val holderClass = Class.forName("org.bouncycastle.cert.X509CertificateHolder")
    val converterClass = Class.forName("org.bouncycastle.cert.jcajce.JcaX509CertificateConverter")

    Log.d(TAG, "createBouncyCastleCert begin")
    val x500Name = x500NameClass
        .getConstructor(String::class.java)
        .newInstance(issuer)

    val buildMethod = signerClass.getMethod("build", java.security.PrivateKey::class.java)
    val signer = run {
        val attempts = listOf(
            Pair("SHA256withRSA", null),
            Pair("SHA256WithRSAEncryption", null),
            Pair("SHA256withRSA", "BC"),
            Pair("SHA256WithRSAEncryption", "BC")
        )
        var lastError: Exception? = null
        var built: Any? = null
        for ((algorithm, provider) in attempts) {
            try {
                val signerBuilder = signerClass.getConstructor(String::class.java).newInstance(algorithm)
                if (provider != null) {
                    signerBuilder.javaClass
                        .getMethod("setProvider", String::class.java)
                        .invoke(signerBuilder, provider)
                }
                built = buildMethod.invoke(signerBuilder, kp.private)
                Log.d(TAG, "createBouncyCastleCert signer built algorithm=$algorithm provider=${provider ?: "default"}")
                break
            } catch (e: Exception) {
                lastError = e
                Log.w(
                    TAG,
                    "createBouncyCastleCert signer attempt failed algorithm=$algorithm provider=${provider ?: "default"}",
                    e
                )
            }
        }
        if (built == null) {
            throw (lastError ?: IllegalStateException("failed to create signer"))
        }
        built
    }

    val serial = BigInteger.valueOf(System.currentTimeMillis())
    val builder = try {
        builderClass
            .getConstructor(
                x500NameClass,
                BigInteger::class.java,
                Date::class.java,
                Date::class.java,
                x500NameClass,
                java.security.PublicKey::class.java
            )
            .newInstance(x500Name, serial, notBefore, notAfter, x500Name, kp.public)
    } catch (e: Exception) {
        val ctorShapes = builderClass.constructors.joinToString(" | ") { ctor ->
            ctor.parameterTypes.joinToString(prefix = "(", postfix = ")") { it.name }
        }
        Log.e(TAG, "JcaX509v3CertificateBuilder ctor mismatch. Available=$ctorShapes", e)
        throw e
    }

    val holder = builder.javaClass.getMethod("build", contentSignerClass)
        .invoke(builder, signer)

    val converter = converterClass.getConstructor().newInstance()
    val cert = converterClass.getMethod("getCertificate", holderClass)
        .invoke(converter, holder) as X509Certificate
    Log.d(TAG, "createBouncyCastleCert success")
    return cert
}

// Trust-all TrustManager for the pairing TLS handshake
// (we validate identity via the PIN, not the cert chain)
class TrustManager : X509TrustManager {
    var serverCert: X509Certificate? = null
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        serverCert = chain[0]
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
