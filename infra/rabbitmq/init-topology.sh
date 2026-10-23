#!/bin/sh
# Creates the RabbitMQ virtual host, exchanges, queues and users through the
# management API. Every queue is a quorum queue that retries a failing message
# up to 5 times, then moves it to its dead-letter queue (<name>.dlq).
set -eu
API="http://${RABBITMQ_HOST:-rabbitmq}:15672/api"
ADMIN="${RABBITMQ_ADMIN_USER}:${RABBITMQ_ADMIN_PASSWORD}"
V=retailflow

call() {
  code=$(curl -s -o /tmp/r -w '%{http_code}' -u "$ADMIN" -X "$1" -H 'content-type: application/json' "$API$2" ${3:+-d "$3"})
  case "$code" in 2*) ;; *) echo "FAILED $1 $2 ($code): $(cat /tmp/r)"; exit 1 ;; esac
}

until curl -sf -u "$ADMIN" "$API/overview" >/dev/null; do echo "waiting for RabbitMQ"; sleep 2; done

call PUT "/vhosts/$V"
call PUT "/permissions/$V/$RABBITMQ_ADMIN_USER" '{"configure":".*","write":".*","read":".*"}'
call PUT "/exchanges/$V/retailflow.events" '{"type":"topic","durable":true}'
call PUT "/exchanges/$V/retailflow.dlx" '{"type":"direct","durable":true}'

queue() { # queue name, then the routing keys it listens to
  q="$1"; shift
  call PUT "/queues/$V/$q" "{\"durable\":true,\"arguments\":{\"x-queue-type\":\"quorum\",\"x-delivery-limit\":5,\"x-dead-letter-exchange\":\"retailflow.dlx\",\"x-dead-letter-routing-key\":\"$q\"}}"
  call PUT "/queues/$V/$q.dlq" '{"durable":true}'
  call POST "/bindings/$V/e/retailflow.dlx/q/$q.dlq" "{\"routing_key\":\"$q\"}"
  for key in "$@"; do call POST "/bindings/$V/e/retailflow.events/q/$q" "{\"routing_key\":\"$key\"}"; done
  echo "queue $q <- $*"
}
queue billing.orders        order.created
queue order.payments        payment.completed
queue order.projection      'order.*' 'invoice.*' 'payment.*'
queue notification.events   'order.*' 'invoice.*' 'payment.*' 'customer.*'

# Application user: may publish/consume but cannot create or delete anything.
call PUT "/users/$RABBITMQ_APP_USER" "{\"password\":\"$RABBITMQ_APP_PASSWORD\",\"tags\":\"\"}"
call PUT "/permissions/$V/$RABBITMQ_APP_USER" '{"configure":"^$","write":"^retailflow\\.events$","read":".*"}'
echo "RabbitMQ topology ready"
