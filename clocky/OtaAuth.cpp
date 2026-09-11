#include "OtaAuth.h"
#include <Preferences.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include <mbedtls/base64.h>
#include <mbedtls/rsa.h>

#define NVS_NS       "clocky"
#define NVS_KEY_PUB  "otaPubKey"

// Public key embedded at compile time — not a secret, safe to commit.
// Regenerate with scripts/generate_keys.sh if you rotate the keypair.
static const char kOtaPublicKeyPem[] =
  "-----BEGIN PUBLIC KEY-----\n"
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuYXWckCVzYzyMRE+Ofng\n"
  "fUIkOJMZkXncenxZsTi740UYcxCzmsRXLpld69sMT3ePUoDca/eOc5Q4XsALWrzx\n"
  "m9w6TaLeqL838L6FygLIR+vpxzdw0Om1IniFaFdYPQf5DwItUV5ZrWv4Y/Numaf3\n"
  "IfkrWuNsUbYA9/vWW82LsFc8MoGZInV0Sgw+h27WyZWnfeV5OUsOkdUNcYEOXY5T\n"
  "mSE2R6VmZIinkHsSvIXFUlgzgW/Z7FLss0OsQdrp/0qoBK0YKJWnwgE3RsKUUAoE\n"
  "V6ErdGA3tV4rUvhNIYvWwc3GFtaLxTvueEFe+QhZtUoDtKInTItreLIDzWe9qu7H\n"
  "6wIDAQAB\n"
  "-----END PUBLIC KEY-----\n";

static String sPubKeyPem;

void otaAuthBegin() {
  sPubKeyPem = kOtaPublicKeyPem;
  Serial.println("[OTA] Public key loaded.");
}

bool otaAuthVerify(const uint8_t hash[32], const char* sigB64) {
  if (sPubKeyPem.isEmpty()) return false;

  // Decode base64 signature
  uint8_t sig[256];
  size_t sigLen = 0;
  if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen,
        (const uint8_t*)sigB64, strlen(sigB64)) != 0) {
    Serial.println("[OTA] Signature base64 decode failed.");
    return false;
  }

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int ret = mbedtls_pk_parse_public_key(&pk,
    (const uint8_t*)sPubKeyPem.c_str(), sPubKeyPem.length() + 1);
  if (ret != 0) {
    Serial.printf("[OTA] Failed to parse public key: -0x%04X\n", -ret);
    mbedtls_pk_free(&pk);
    return false;
  }

  mbedtls_rsa_context* rsa = mbedtls_pk_rsa(pk);
  mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, MBEDTLS_MD_SHA256);

  ret = mbedtls_rsa_rsassa_pss_verify(rsa, MBEDTLS_MD_SHA256, 32, hash, sig);
  mbedtls_pk_free(&pk);

  if (ret != 0) {
    Serial.printf("[OTA] Signature verification failed: -0x%04X\n", -ret);
    return false;
  }

  Serial.println("[OTA] Signature verified.");
  return true;
}
