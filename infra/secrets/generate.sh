#!/bin/sh
# Creates the JWT signing key pair and the gateway's HTTPS certificate in the
# "secrets" volume. Each container later mounts only the sub-folder it needs:
#   public/   jwt_public_key                    -> Kong + every service (verify tokens)
#   issuer/   jwt_private_key, jwt_public_key   -> Customer Service only (sign tokens)
#   gateway/  tls.crt, tls.key                  -> Kong only (HTTPS)
# Existing files are kept, so tokens stay valid across restarts.
set -eu
OUT="${OUT:-/out}"
if [ -f "$OUT/issuer/jwt_private_key" ] && [ -f "$OUT/gateway/tls.crt" ]; then echo "secrets already exist"; exit 0; fi
mkdir -p "$OUT/public" "$OUT/issuer" "$OUT/gateway"

# RS256 key pair: only the token issuer holds the private key.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$OUT/issuer/jwt_private_key"
openssl pkey -in "$OUT/issuer/jwt_private_key" -pubout -out "$OUT/issuer/jwt_public_key"
cp "$OUT/issuer/jwt_public_key" "$OUT/public/jwt_public_key"

# Self-signed TLS certificate for HTTPS on the Kong gateway.
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$OUT/gateway/tls.key" -out "$OUT/gateway/tls.crt"

# Files must be readable by the non-root users of the containers that mount them.
chmod 0644 "$OUT"/*/*
echo "secrets generated"
