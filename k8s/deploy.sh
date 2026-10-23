#!/usr/bin/env bash
# Builds the images, creates Secrets/ConfigMaps from the same files Docker
# Compose uses, and deploys RetailFlow to the current kubectl context.
#
#   CLUSTER=kind     ./k8s/deploy.sh   (default; cluster from k8s/kind-config.yaml)
#   CLUSTER=minikube ./k8s/deploy.sh
#   CLUSTER=docker-desktop ./k8s/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER="${CLUSTER:-kind}"
NS=retailflow
SERVICES=(product-service customer-service order-service billing-service notification-service web-ui)

[ -f .env ] || cp .env.example .env

echo "== 1/5 Building service images"
docker compose build "${SERVICES[@]}"

echo "== 2/5 Making images available to the cluster ($CLUSTER)"
for svc in "${SERVICES[@]}"; do
  case "$CLUSTER" in
    kind)     kind load docker-image "retailflow/$svc:1.0" --name "${KIND_CLUSTER_NAME:-retailflow}" ;;
    minikube) minikube image load "retailflow/$svc:1.0" ;;
    *)        ;; # Docker Desktop's Kubernetes shares the local image store
  esac
done

echo "== 3/5 Generating keys and certificates"
mkdir -p k8s/.generated
docker run --rm -v "$PWD/k8s/.generated:/out" -v "$PWD/infra/secrets/generate.sh:/generate.sh:ro" \
  --entrypoint sh alpine/openssl:3.3.2 /generate.sh
G=k8s/.generated

echo "== 4/5 Creating namespace, Secrets and ConfigMaps"
kubectl apply -f k8s/00-namespace.yaml
apply() { kubectl -n "$NS" "$@" --dry-run=client -o yaml | kubectl apply -f -; }
apply create secret generic app-secrets --from-env-file=.env
apply create secret generic jwt-public --from-file=jwt_public_key="$G/public/jwt_public_key"
apply create secret generic jwt-issuer --from-file=jwt_private_key="$G/issuer/jwt_private_key" --from-file=jwt_public_key="$G/issuer/jwt_public_key"
apply create secret tls gateway-tls --cert="$G/gateway/tls.crt" --key="$G/gateway/tls.key"
apply create configmap kong-config --from-file=infra/kong/kong.yml.tmpl --from-file=infra/kong/render-and-start.sh
apply create configmap rabbitmq-config --from-file=infra/rabbitmq/init-topology.sh --from-file=infra/rabbitmq/20-prometheus.conf
apply create configmap order-db-init --from-file=infra/mysql/01-order-schema.sh
apply create configmap debezium-config --from-file=infra/debezium/application.properties
apply create configmap prometheus-config --from-file=infra/prometheus/prometheus.yml --from-file=infra/prometheus/alerts.yml
apply create configmap loki-config --from-file=infra/loki/loki.yml
apply create configmap grafana-datasources --from-file=infra/grafana/provisioning/datasources/datasources.yml
apply create configmap grafana-dashboard-provider --from-file=infra/grafana/provisioning/dashboards/dashboards.yml
apply create configmap grafana-dashboards --from-file=infra/grafana/dashboards/retailflow.json

echo "== 5/5 Deploying workloads"
kubectl apply -f k8s/10-infrastructure.yaml -f k8s/20-databases.yaml -f k8s/30-services.yaml \
              -f k8s/40-observability.yaml -f k8s/50-network-policies.yaml
kubectl -n "$NS" rollout status deployment/kong deployment/order-service deployment/product-service \
  deployment/customer-service deployment/notification-service deployment/web-ui statefulset/billing-service --timeout=10m

cat <<EOF

RetailFlow is running in namespace "$NS".
  kubectl -n $NS get pods
  Website : https://localhost:30443   (kind; otherwise: kubectl -n $NS port-forward svc/kong 8443:8443)
  Grafana : http://localhost:30300    (admin / GRAFANA_ADMIN_PASSWORD from .env)
  Demo    : GATEWAY=https://localhost:30443 ./scripts/demo.sh
EOF
