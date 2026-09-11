#!/bin/bash
# Generates RSA-2048 keypair for Clocky OTA firmware signing.
# Run once. Keep private_key.pem secret (on your phone/desktop).
# Upload public_key.pem content to ESP32 NVS via serial on first boot.

set -e
OUT=${1:-.}
mkdir -p "$OUT"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$OUT/private_key.pem"
openssl rsa -pubout -in "$OUT/private_key.pem" -out "$OUT/public_key.pem"

echo "Generated:"
echo "  $OUT/private_key.pem  — keep this, copy to phone"
echo "  $OUT/public_key.pem   — paste into ESP32 serial on first boot"
echo ""
cat "$OUT/public_key.pem"
