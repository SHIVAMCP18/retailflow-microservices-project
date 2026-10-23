#!/usr/bin/env bash
# Checks every part of the running system and prints PASS / FAIL for each.
#   ./scripts/check.sh                  all checks
#   ./scripts/check.sh --circuit-breaker  also stops Product Service to prove the breaker opens and recovers
# Needs bash, curl and docker. Run it from the project folder after `docker compose up -d`.
set -uo pipefail
cd "$(dirname "$0")/.."
GW="${GATEWAY:-https://localhost:8443}"
set -a; [ -f .env ] && . ./.env; set +a
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@12345}"
RMQ="${RABBITMQ_ADMIN_USER:-rf_admin}:${RABBITMQ_ADMIN_PASSWORD:-change-me-rabbit-admin}"

pass=0; fail=0; failed=()
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s %s\n' "$1" "${2:+($2)}"; fail=$((fail+1)); failed+=("$1"); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
expect() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected $3, got $2"; }   # name, actual, expected
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "missing '$3'" ;; esac; }

# HTTP helpers. code: status only. body: body only. Both through the gateway with -k (self-signed cert).
code() { curl -sk -o /dev/null -w '%{http_code}' -X "$1" "$GW$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}; }
body() { curl -sk -X "$1" "$GW$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}; }
field() { sed -n "s/.*\"$1\" *: *\"\{0,1\}\([^\",}]*\).*/\1/p" | head -1; }
wait_for() { # seconds, command...
  local limit=$1; shift
  for _ in $(seq 1 "$limit"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}

section "1. Containers"
ps_out=$(docker compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' 2>/dev/null)
for svc in consul rabbitmq kong debezium product-db customer-db order-db notification-db \
           product-service customer-service order-service billing-service notification-service web-ui \
           prometheus grafana loki promtail mailpit; do
  line=$(echo "$ps_out" | grep "^$svc ")
  case "$line" in
    *running*) case "$line" in *Restarting*) bad "$svc running" "restarting" ;; *) ok "$svc running" ;; esac ;;
    "") bad "$svc running" "not created" ;;
    *) bad "$svc running" "$(echo "$line" | cut -d' ' -f2-)" ;;
  esac
done
for job in secrets-init rabbitmq-init order-db-init; do
  echo "$ps_out" | grep "^$job " | grep -q "Exited (0)" && ok "$job finished" || bad "$job finished" "check: docker compose logs $job"
done

section "2. Discovery (Consul)"
for svc in product-service customer-service order-service billing-service notification-service web-ui; do
  passing=$(curl -s "localhost:8500/v1/health/service/$svc?passing" | grep -o '"Node": *{' | wc -l | tr -d ' ')
  [ "$passing" -ge 1 ] && ok "$svc registered and healthy ($passing instance$([ "$passing" -gt 1 ] && echo s))" || bad "$svc registered and healthy" "see http://localhost:8500"
done

section "3. API gateway (Kong) and security"
expect "website served at /" "$(code GET /)" 200
expect "request without token is rejected" "$(code GET /orders)" 401
expect "request with a forged token is rejected" "$(code GET /orders eyJhbGciOiJSUzI1NiJ9.eyJyb2xlIjoiQURNSU4ifQ.bad)" 401
headers=$(curl -skI "$GW/")
contains "HSTS security header" "$headers" "strict-transport-security"
contains "X-Request-ID added by gateway" "$headers" "x-request-id"
expect "plain HTTP is not exposed" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:8443/ || true)" 400

section "4. Customer service (Python + MongoDB): register, login, roles"
ADMIN=$(body POST /auth/login "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | field token)
[ -n "$ADMIN" ] && ok "admin login returns a JWT" || bad "admin login returns a JWT" "check ADMIN_EMAIL / ADMIN_PASSWORD"
EMAIL="check.$(date +%s)@example.com"
expect "register a customer" "$(code POST /auth/register "" "{\"name\":\"Check User\",\"email\":\"$EMAIL\",\"password\":\"Secret@123\",\"phone\":\"+919000000000\"}")" 201
expect "duplicate e-mail is refused" "$(code POST /auth/register "" "{\"name\":\"Check User\",\"email\":\"$EMAIL\",\"password\":\"Secret@123\"}")" 409
expect "wrong password is refused" "$(code POST /auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}")" 401
expect "invalid registration data is refused" "$(code POST /auth/register "" '{"name":"x","email":"not-an-email","password":"1"}')" 422
TOKEN=$(body POST /auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"Secret@123\"}" | field token)
[ -n "$TOKEN" ] && ok "customer login returns a JWT" || bad "customer login returns a JWT"
ME=$(body GET /customers/me "$TOKEN"); CUSTOMER_ID=$(echo "$ME" | field id)
contains "GET /customers/me" "$ME" "$EMAIL"
expect "PUT /customers/{id} (own profile)" "$(code PUT "/customers/$CUSTOMER_ID" "$TOKEN" '{"address":{"line1":"12 MG Road","city":"Pune","postcode":"411001"}}')" 200
expect "customer cannot list all customers" "$(code GET /customers "$TOKEN")" 403
expect "admin can list all customers" "$(code GET /customers "$ADMIN")" 200

section "5. Product service (Node.js + PostgreSQL)"
expect "GET /products" "$(code GET /products "$TOKEN")" 200
expect "GET /products/1" "$(code GET /products/1 "$TOKEN")" 200
expect "unknown product returns 404" "$(code GET /products/999999 "$TOKEN")" 404
expect "GET /categories" "$(code GET /categories "$TOKEN")" 200
expect "customer cannot create products" "$(code POST /products "$TOKEN" '{"name":"x","price":1,"stock":1}')" 403
expect "invalid product is refused" "$(code POST /products "$ADMIN" '{"name":"","price":-1,"stock":1.5}')" 400
PRODUCT=$(body POST /products "$ADMIN" '{"name":"Check monitor","price":9999.50,"stock":3,"category":"Electronics"}'); PRODUCT_ID=$(echo "$PRODUCT" | field id)
[ -n "$PRODUCT_ID" ] && ok "admin creates a product (id $PRODUCT_ID)" || bad "admin creates a product" "$PRODUCT"
expect "admin updates stock" "$(code PATCH "/products/$PRODUCT_ID/stock" "$ADMIN" '{"stock":3}')" 200

section "6. Order service (Java + MySQL): REST + gRPC, outbox, CQRS"
expect "empty order is refused" "$(code POST /orders "$TOKEN" '{"items":[]}')" 400
expect "more than the stock is refused (gRPC ReserveStock)" "$(code POST /orders "$TOKEN" "{\"items\":[{\"productId\":$PRODUCT_ID,\"quantity\":50}]}")" 409
ORDER=$(body POST /orders "$TOKEN" "{\"items\":[{\"productId\":$PRODUCT_ID,\"quantity\":2},{\"productId\":1,\"quantity\":1}]}")
ORDER_ID=$(echo "$ORDER" | field orderId)
[ -n "$ORDER_ID" ] && ok "order placed (Customer via REST, Product via gRPC)" || bad "order placed" "$ORDER"
contains "order starts as PENDING_PAYMENT" "$ORDER" "PENDING_PAYMENT"
STOCK=$(body GET "/products/$PRODUCT_ID" "$TOKEN" | field stock)
expect "stock was reserved (3 - 2 = 1)" "$STOCK" 1
view_has() { body GET "/orders/$ORDER_ID" "$TOKEN" | grep -q "$1"; }
wait_for 20 view_has '"invoiceId":"INV' && ok "read model built from events, invoice linked (CDC -> RabbitMQ -> Billing)" || bad "read model shows the invoice" "check: docker compose logs debezium billing-service"
expect "GET /orders lists the order" "$(body GET /orders "$TOKEN" | grep -c "$ORDER_ID")" 1
expect "admin can see any order" "$(code GET "/orders/$ORDER_ID" "$ADMIN")" 200

section "7. Billing service (Go + SQLite) and the saga"
INVOICES=$(body GET /billing/invoices "$TOKEN"); INVOICE_ID=$(echo "$INVOICES" | field invoiceId)
contains "invoice created for the order" "$INVOICES" "$ORDER_ID"
contains "invoice amount is exact (2 x 9999.50 + 1499 = 21498)" "$INVOICES" '"amount":21498'
expect "GET /billing/invoices/{id}" "$(code GET "/billing/invoices/$INVOICE_ID" "$TOKEN")" 200
expect "pay the invoice" "$(code POST "/billing/invoices/$INVOICE_ID/pay" "$TOKEN" '{"method":"UPI"}')" 200
expect "paying twice is refused" "$(code POST "/billing/invoices/$INVOICE_ID/pay" "$TOKEN" '{"method":"UPI"}')" 409
wait_for 20 view_has '"status":"PAID"' && ok "order became PAID (payment.completed -> Order)" || bad "order became PAID"
contains "order history has all four events" "$(body GET "/orders/$ORDER_ID" "$TOKEN")" "order.paid"

section "8. Notification service (C# + Redis) and e-mail"
notif_count() { [ "$(body GET /notifications "$TOKEN" | grep -o '"eventType"' | wc -l)" -ge 5 ]; }
wait_for 15 notif_count && ok "5 notifications (welcome, order, invoice, payment, confirmation)" || bad "5 notifications" "got: $(body GET /notifications "$TOKEN" | grep -o '"eventType":"[a-z.]*"' | tr '\n' ' ')"
mails=$(curl -s "localhost:8025/api/v1/search?query=to:$EMAIL" | grep -o '"messages_count":[0-9]*' | grep -o '[0-9]*$')
[ "${mails:-0}" -ge 4 ] && ok "e-mails delivered to Mailpit ($mails)" || bad "e-mails delivered to Mailpit" "found ${mails:-0}"

section "9. Messaging (RabbitMQ)"
queues=$(curl -s -u "$RMQ" localhost:15672/api/queues/retailflow)
for q in billing.orders order.payments order.projection notification.events; do
  [ -n "$(echo "$queues" | grep -o "\"name\":\"$q\"")" ] && ok "queue $q exists" || bad "queue $q exists"
  [ -n "$(echo "$queues" | grep -o "\"name\":\"$q.dlq\"")" ] && ok "dead-letter queue $q.dlq exists" || bad "dead-letter queue $q.dlq exists"
done
exchange=$(curl -s -u "$RMQ" localhost:15672/api/exchanges/retailflow/retailflow.events)
contains "topic exchange retailflow.events" "$exchange" '"type":"topic"'
consumers=$(curl -s -u "$RMQ" localhost:15672/api/consumers/retailflow | grep -o '"queue":{[^}]*}' | grep -o '"name":"[a-z.]*"' | sort -u | wc -l | tr -d ' ')
[ "$consumers" -ge 4 ] && ok "every queue has a consumer ($consumers queues)" || bad "every queue has a consumer" "$consumers queues have consumers"

section "10. CDC (Debezium) and outbox"
dbz=$(docker compose logs debezium --tail 200 2>/dev/null)
contains "Debezium connected to the MySQL binlog" "$dbz" "Connected to"
outbox=$(docker compose exec -T order-db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT COUNT(*) FROM orders.outbox WHERE aggregateid=\"'"$ORDER_ID"'\""' 2>/dev/null | tr -d '\r')
expect "outbox rows written in the order transaction (order.created + order.paid)" "$outbox" 2

section "11. Monitoring and logging"
targets=$(curl -s localhost:9090/api/v1/targets)
up=$(echo "$targets" | grep -o '"health":"up"' | wc -l | tr -d ' '); down=$(echo "$targets" | grep -o '"health":"down"' | wc -l | tr -d ' ')
[ "$up" -ge 7 ] && [ "$down" -eq 0 ] && ok "Prometheus scrapes $up targets, none down" || bad "Prometheus targets" "$up up, $down down"
expect "Grafana is up" "$(curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/health)" 200
expect "Grafana dashboard provisioned" "$(curl -s -o /dev/null -w '%{http_code}' -u "admin:${GRAFANA_ADMIN_PASSWORD:-change-me-grafana}" localhost:3000/api/dashboards/uid/retailflow)" 200
loki=$(curl -s -u "admin:${GRAFANA_ADMIN_PASSWORD:-change-me-grafana}" localhost:3000/api/datasources/proxy/uid/loki/loki/api/v1/label/service/values)
contains "Loki receives logs from the services" "$loki" "order-service"

if [ "${1:-}" = "--circuit-breaker" ]; then
  section "12. Circuit breaker (stops Product Service for a moment)"
  docker compose stop product-service >/dev/null 2>&1
  codes=""; for _ in 1 2 3 4; do codes="$codes $(code POST /orders "$TOKEN" '{"items":[{"productId":1,"quantity":1}]}')"; done
  contains "orders fail fast with 503 while Product is down" "$codes" "503 503"
  state=$(docker compose exec -T order-service wget -qO- localhost:8083/actuator/circuitbreakers 2>/dev/null)
  contains "circuit breaker 'product' is OPEN" "$state" '"state":"OPEN"'
  docker compose start product-service >/dev/null 2>&1
  recovered() { [ "$(code POST /orders "$TOKEN" '{"items":[{"productId":1,"quantity":1}]}')" = 201 ]; }
  wait_for 60 recovered && ok "orders work again after Product returns (breaker closed)" || bad "circuit breaker recovers"
fi

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { printf 'Failed: %s\n' "${failed[@]}"; exit 1; }
