#pragma once
#include <Arduino.h>

// Call once at boot. Loads public key from NVS.
// If no key is set, prints instructions to Serial and waits for SETPUBKEY:<pem> input.
void otaAuthBegin();

// Verify RSA-PSS-SHA256 signature over firmware bytes.
// sigB64: base64-encoded 256-byte RSA-2048 signature.
// hash:   SHA-256 digest of the firmware (32 bytes).
bool otaAuthVerify(const uint8_t hash[32], const char* sigB64);
