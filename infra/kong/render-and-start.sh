#!/bin/sh
# Inserts the JWT public key into the declarative config, then starts Kong.
set -eu
TEMPLATE="${KONG_TEMPLATE:-/kong/kong.yml.tmpl}"
PUBLIC_KEY="${JWT_PUBLIC_KEY_FILE:-/run/secrets/jwt_public_key}"
awk -v keyfile="$PUBLIC_KEY" '
  /^[ ]*__JWT_PUBLIC_KEY__[ ]*$/ {
    indent = $0; sub(/[^ ].*/, "", indent)
    while ((getline line < keyfile) > 0) print indent line
    next
  }
  { print }
' "$TEMPLATE" > /tmp/kong.yml
export KONG_DECLARATIVE_CONFIG=/tmp/kong.yml
exec /docker-entrypoint.sh kong docker-start
