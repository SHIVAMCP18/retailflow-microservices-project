# RetailFlow — Microservices Architecture Assignment

A small retail system (customers, products, orders, invoices, notifications) built as five
independent microservices, with a **React website** on top. Each one is written in a different language and owns a different
database. The whole system starts with **one command** using Docker Compose, and can also be
deployed to Kubernetes.

```
                    HTTPS + JWT
   Client ───────────────────────────► Kong API Gateway ──(DNS lookup)──► Consul (discovery)
                                            │ REST
          ┌──────────────┬──────────────────┼───────────────┬──────────────────┐
          ▼              ▼                  ▼               ▼                  ▼
   Customer Service  Product Service   Order Service   Billing Service   Notification Service
   Python · MongoDB  Node.js · Postgres Java · MySQL   Go · SQLite       C# · Redis
   (issues JWTs)         ▲   ▲            │  │  ▲           │  ▲            ▲      │ SMTP
          ▲              │   └── gRPC ────┘  │  │           │  │            │      ▼
          └──────── REST (circuit breaker) ──┘  │           │  │            │   Mailpit
                                                │ outbox    │  │            │
                                                ▼ (binlog)  │  │            │
                                          Debezium (CDC)    │  │            │
                                                │           ▼  │            │
                                                └────► RabbitMQ topic exchange "retailflow.events"
                                                       order.* · invoice.* · payment.* · customer.*

   Prometheus (finds targets through Consul) → Grafana dashboard ← Loki ← Promtail (all logs)
```

## The website

Open **https://localhost:8443** (accept the self-signed certificate warning). Kong serves the
React website at `/` and routes its API calls to the five services.

| Page | What it shows |
|---|---|
| Sign in / Create account | Customer Service issues the JWT. Demo admin: `admin@example.com` / `Admin@12345` |
| Shop | Catalogue and cart (Product Service). **Place order** calls Order Service, which uses REST + gRPC |
| My orders → order page | **Live timeline** of the saga: order.created → invoice.created → payment.completed → order.paid. Includes the "Pay" button |
| Invoices | Billing Service invoices with payment status |
| Notifications | In-app notifications (Notification Service), with a badge in the menu |
| Admin (admin only) | Add products and set stock, all orders with revenue, all customers |
| System | Diagram, the patterns used, and links to Consul, RabbitMQ, Grafana, Prometheus and Mailpit |

The **Request log** bar at the bottom lists every request the page made: the
service and language that answered, the status, the time it took, and the `X-Request-ID`
(search for it in Grafana logs).

## How each requirement is met

| # | Requirement | Where to see it |
|---|---|---|
| 1 | **A different language for every service** | Customer: **Python** (FastAPI) · Product: **Node.js** (Express) · Order: **Java 21** (Spring Boot) · Billing: **Go** · Notification: **C#** (.NET 8). The gateway is Kong (configuration only, no custom code). |
| 2 | **Database per service, a different product for each** | Customer → **MongoDB** · Product → **PostgreSQL** · Order → **MySQL** · Billing → **SQLite** · Notification → **Redis**. Each database has its own credentials. In Kubernetes, a NetworkPolicy lets only the owning service reach it (`k8s/50-network-policies.yaml`). |
| 3a | **Discovery service** | **Consul** (http://localhost:8500). Each service registers itself with a health check at startup (`registerWithConsul` / `consul_registration` / Spring Cloud Consul). Kong routes to `*.service.consul` using Consul as its DNS server. Order Service finds Product and Customer through Consul, and Prometheus finds its scrape targets through Consul. |
| 3b | **Circuit breaker** | **Resilience4j** in Order Service on the gRPC call to Product and the REST call to Customer (`ProductClient.java`, `CustomerClient.java`). State: `/actuator/circuitbreakers` and the Grafana panel. **Polly** circuit breaker in Notification Service around SMTP (`Notifications.cs`). |
| 3c | **API gateway** | **Kong** (DB-less, `infra/kong/kong.yml.tmpl`): HTTPS, JWT validation, rate limiting (stricter on `/auth`), request-size limit, CORS, security headers, `X-Request-ID` correlation IDs, Prometheus metrics. |
| 3d | **Monitoring and logging** | **Prometheus** (http://localhost:9090) with alert rules (`infra/prometheus/alerts.yml`) · **Grafana** dashboard (http://localhost:3000) · **Loki + Promtail** collect every container's log. All services log in JSON, and the gateway's `X-Request-ID` follows a request across HTTP, gRPC and RabbitMQ. |
| 4 | **Synchronous and asynchronous communication** | Sync: **REST** (client → gateway → services, Order → Customer) and **gRPC** (Order → Product `ReserveStock`, `product.proto`). Async: **RabbitMQ topic exchange** with quorum queues, wildcard bindings (`order.*`), retries and **dead-letter queues** (`infra/rabbitmq/init-topology.sh`). |
| 5 | **ACID/BASE, CDC with transactional outbox, CQRS** | **ACID**: each service commits its changes in one local transaction. Order + items + outbox row in MySQL; stock reservation with row locks in Postgres; invoice + payment + outbox in SQLite. **Transactional outbox + CDC**: **Debezium** reads the MySQL change log (binlog) and publishes the outbox rows (`infra/debezium/application.properties`). Billing uses a polling outbox publisher for comparison. **CQRS**: commands write `orders`/`order_items`; queries read `order_view`, a separate read model built from events (`EventListeners.java`, `OrderQueries.java`). **BASE**: the read model, invoices and notifications are eventually consistent. Every consumer is idempotent (`processed_events` tables, Redis `SET NX`). **Saga**: order → invoice → payment → order PAID. |
| 6 | **Security** | HTTPS at the gateway (TLS certificate generated at first start). **RS256 JWTs**: only Customer Service holds the private key; Kong and every service verify the token with the public key and enforce roles (`ADMIN` / `CUSTOMER`). bcrypt password hashes. Secrets come from `.env` / Kubernetes Secrets, never from code. Least-privilege database and RabbitMQ users. Containers run as non-root, and admin UIs are bound to `127.0.0.1`. Kubernetes adds: read-only root filesystems, dropped Linux capabilities, seccomp, Pod Security Standards, default-deny NetworkPolicies, and no service-account tokens. |
| 7 | **Kubernetes, multi-container pods** | `k8s/`: Deployments, StatefulSets with PersistentVolumes, a Job, a DaemonSet, an HPA, Secrets, ConfigMaps, NetworkPolicies and probes. **Multi-container pods**: Notification Service + Mailpit sidecar in one pod, plus init containers that wait for dependencies in every service pod. Product and Customer run 2 replicas each, and Consul load-balances between them. |

## Run it with Docker Compose (easiest)

Requirements: Docker Desktop (or Docker Engine 26+ with Compose v2), with about **6 GB of RAM** for Docker.

```bash
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
docker compose up --build -d    # the first build downloads images and takes a few minutes
docker compose ps               # wait until the services are "Up"
./scripts/demo.sh               # runs the whole flow (on Windows use Git Bash)
```

| What | Address | Login |
|---|---|---|
| **Website** + API gateway (HTTPS, self-signed) | https://localhost:8443 | `admin@example.com` / `Admin@12345`, or register |
| Consul (discovery + health) | http://localhost:8500 | — |
| RabbitMQ (exchanges, queues, DLQs) | http://localhost:15672 | `RABBITMQ_ADMIN_USER` / `_PASSWORD` from `.env` |
| Grafana dashboard | http://localhost:3000 | `admin` / `GRAFANA_ADMIN_PASSWORD` |
| Prometheus (targets, alerts) | http://localhost:9090 | — |
| Mailpit (e-mails that were sent) | http://localhost:8025 | — |

Stop: `docker compose down` (keeps data) or `docker compose down -v` (fresh start).

### Check that everything works

```bash
./scripts/check.sh                    # 84 checks: containers, Consul, Kong, every endpoint, events, CDC, monitoring
./scripts/check.sh --circuit-breaker  # also stops Product Service to prove the breaker opens and recovers
```

Each check prints PASS or FAIL, so if something is broken you can see exactly which part.

### Troubleshooting

| Problem | Fix |
|---|---|
| `variable is not set` warnings | `.env` is missing: `cp .env.example .env` |
| `TLS handshake timeout` / `Name or service not known` while building | Network problem. Run the command again, restart Docker Desktop, or switch networks. |
| Website says "name resolution failed" right after start | Services are still registering in Consul. Wait 30–60 s. |
| A service stays red in Consul, or placing an order fails | Start from scratch: `docker compose down -v && docker compose up -d`, then `./scripts/check.sh` |

## Run it on Kubernetes

```bash
kind create cluster --name retailflow --config k8s/kind-config.yaml   # or: minikube start --cpus 4 --memory 8g
CLUSTER=kind ./k8s/deploy.sh          # CLUSTER=minikube or CLUSTER=docker-desktop also work
kubectl -n retailflow get pods
GATEWAY=https://localhost:30443 ./scripts/demo.sh
```

`deploy.sh` builds the images, loads them into the cluster, generates keys and certificates,
creates the Secrets/ConfigMaps from the same files Compose uses, and applies `k8s/*.yaml`.
On minikube or Docker Desktop, use `kubectl -n retailflow port-forward svc/kong 8443:8443` and
the default gateway address. NetworkPolicies need a CNI that enforces them (kind's kindnet,
Calico or Cilium). The HPA needs metrics-server.

## The API (all through the gateway)

| Method | Path | Who | Service |
|---|---|---|---|
| POST | `/auth/register` · `/auth/login` | anyone | Customer |
| GET / PUT | `/customers/me`, `/customers/{id}` | owner or ADMIN | Customer |
| GET | `/customers` | ADMIN | Customer |
| GET | `/products`, `/products/{id}`, `/categories` | logged in | Product |
| POST / PATCH | `/products`, `/products/{id}/stock` | ADMIN | Product |
| POST | `/orders` `{"items":[{"productId":1,"quantity":2}]}` | logged in | Order |
| GET | `/orders`, `/orders/{id}` (CQRS read model) | owner or ADMIN | Order |
| GET | `/billing/invoices`, `/billing/invoices/{id}` | owner or ADMIN | Billing |
| POST | `/billing/invoices/{id}/pay` `{"method":"UPI"}` | owner or ADMIN | Billing |
| GET | `/notifications` | owner (ADMIN sees all) | Notification |

## Things to show in a demo

1. **The website**: open https://localhost:8443, register a customer, add two products to the cart, place the order, and watch the timeline fill in. Click **UPI** and the order turns Paid. Open the "Request log" bar to show which service answered each request.
1. **The order flow from the terminal**: run `./scripts/demo.sh`. The order's `history` shows `order.created → invoice.created → payment.completed → order.paid` arriving asynchronously.
2. **Circuit breaker**: `docker compose stop product-service`, then place two or three orders. Responses switch to a fast `503 … circuit breaker fallback`. Check `docker compose exec order-service wget -qO- localhost:8083/actuator/circuitbreakers` (state `OPEN`) and the Grafana panel. Restart the service with `docker compose start product-service`.
3. **Discovery**: open the Consul UI. Stop a service and watch its health check turn red; Kong stops routing to it.
4. **CDC / outbox**: `docker compose logs debezium` shows the binlog connection. The `outbox` table in MySQL holds every event that was published.
5. **Dead-letter queue**: publish a malformed message to `retailflow.events` with routing key `order.created` from the RabbitMQ UI. It ends up in `billing.orders.dlq`, and the `MessagesInDeadLetterQueue` alert fires.
6. **Logging**: in Grafana, type the demo's `X-Request-ID` into "Search logs" to see that request in every service's log.

More detail: [docs/services.md](docs/services.md) (each service explained) and [docs/architecture.md](docs/architecture.md).
