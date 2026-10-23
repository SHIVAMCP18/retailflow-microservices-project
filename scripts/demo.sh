#!/usr/bin/env bash
# End-to-end demo of the RetailFlow order flow through the API gateway.
#   ./scripts/demo.sh                    (Docker Compose, https://localhost:8443)
#   GATEWAY=https://localhost:30443 ./scripts/demo.sh   (Kubernetes / kind)
# Needs only bash and curl. -k is used because the gateway certificate is self-signed.
set -euo pipefail
GW="${GATEWAY:-https://localhost:8443}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@12345}"
REQUEST_ID="demo-$(date +%s)"

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
call() { # method path [token] [json]
  curl -sk -X "$1" "$GW$2" -H "X-Request-ID: $REQUEST_ID" -H 'Content-Type: application/json' \
       ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}
}
status() { curl -sk -o /dev/null -w '%{http_code}' -X "$1" "$GW$2" ${3:+-H "Authorization: Bearer $3"} -H 'Content-Type: application/json' ${4:+-d "$4"}; }
field() { sed -n "s/.*\"$1\" *: *\"\{0,1\}\([^\",}]*\).*/\1/p" | head -1; }

bold "1. Security: requests without a JWT are rejected by the Kong gateway"
echo "GET /products without token -> HTTP $(status GET /products)"

bold "2. Admin logs in (Customer Service issues an RS256 JWT)"
ADMIN_TOKEN=$(call POST /auth/login "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | field token)
[ -n "$ADMIN_TOKEN" ] || { echo "admin login failed - check ADMIN_EMAIL/ADMIN_PASSWORD (or wait a minute if rate-limited)"; exit 1; }
echo "admin token: ${ADMIN_TOKEN:0:40}..."

printf "waiting until all services are registered and healthy"
for i in $(seq 1 60); do
  ready=1
  for path in /products /customers /orders /billing/invoices /notifications; do
    code=$(status GET "$path" "$ADMIN_TOKEN")
    [ "$code" = "200" ] || ready=0
  done
  [ "$ready" = 1 ] && break
  printf "."; sleep 3
done
echo

bold "3. Admin creates a product (Product Service -> PostgreSQL)"
PRODUCT=$(call POST /products "$ADMIN_TOKEN" '{"name":"Mechanical keyboard","price":2499,"stock":5,"category":"Electronics"}')
echo "$PRODUCT"
PRODUCT_ID=$(echo "$PRODUCT" | field id)

bold "4. A customer registers and logs in (Customer Service -> MongoDB, event customer.registered)"
EMAIL="asha.$(date +%s)@example.com"
call POST /auth/register "" "{\"name\":\"Asha Shah\",\"email\":\"$EMAIL\",\"password\":\"Secret@123\",\"phone\":\"+919999999999\"}"; echo
TOKEN=$(call POST /auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"Secret@123\"}" | field token)
echo "customer creating a product -> HTTP $(status POST /products "$TOKEN" '{"name":"x","price":1,"stock":1}') (role-based access control)"

bold "5. Customer places an order (Order -> Customer via REST, Order -> Product via gRPC, outbox via CDC)"
ORDER=$(call POST /orders "$TOKEN" "{\"items\":[{\"productId\":$PRODUCT_ID,\"quantity\":2},{\"productId\":1,\"quantity\":1}]}")
echo "$ORDER"
ORDER_ID=$(echo "$ORDER" | field orderId)

bold "6. Query side (CQRS read model) catches up asynchronously"
for i in $(seq 1 20); do
  VIEW=$(call GET "/orders/$ORDER_ID" "$TOKEN")
  echo "$VIEW" | grep -q '"invoiceId":"INV' && break
  echo "  read model not complete yet (eventual consistency), retrying..."; sleep 1
done
echo "$VIEW"

bold "7. Billing created the invoice from the order.created event (Go -> SQLite)"
INVOICES=$(call GET /billing/invoices "$TOKEN")
echo "$INVOICES"
INVOICE_ID=$(echo "$INVOICES" | field invoiceId)

bold "8. Customer pays the invoice -> payment.completed -> Order becomes PAID (saga)"
call POST "/billing/invoices/$INVOICE_ID/pay" "$TOKEN" '{"method":"UPI"}'; echo
for i in $(seq 1 20); do
  VIEW=$(call GET "/orders/$ORDER_ID" "$TOKEN")
  echo "$VIEW" | grep -q '"status":"PAID"' && break
  sleep 1
done
echo "$VIEW"

bold "9. Notifications (C# -> Redis, e-mails visible in Mailpit at http://localhost:8025)"
sleep 2
call GET /notifications "$TOKEN"; echo

bold "Done. Follow this whole flow in Grafana logs by searching for X-Request-ID: $REQUEST_ID"
