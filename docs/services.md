# The services, one by one

RetailFlow is an online store split into five business services. Each one is written in a
different language, owns a different database, and talks to the others only through APIs and
events. It never reads another service's database. A React website, the Kong gateway and some
shared infrastructure sit around them.

```
Browser ──HTTPS──► Kong ──► Customer · Product · Order · Billing · Notification
                              Order ──REST──► Customer
                              Order ──gRPC──► Product
                              Order ──outbox──► Debezium ──► RabbitMQ ──► Billing, Notification, Order
                              Billing ──outbox──► RabbitMQ ──► Order, Notification
```

---

## 1. Customer Service: Python (FastAPI) + MongoDB

**What it does:** customer accounts. It registers customers, signs them in, stores their
profile (name, email, phone, address, account status) and is the **identity provider** of the
whole system: it issues the login tokens (JWTs) that every other service trusts.

**Why MongoDB:** a customer profile is a single document with optional nested parts (the
address). A document database stores that naturally, without joins or schema migrations.

**Data:** collection `customers.customers`, one document per customer. Passwords are stored only
as **bcrypt hashes**. A unique index on `email` stops duplicate accounts.

**API (through Kong):**

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/auth/register` | anyone | Create an account (validated: name, real email, password ≥ 8 characters) |
| POST | `/auth/login` | anyone | Check the password, return a JWT valid for 1 hour |
| GET | `/customers/me` | signed in | Your own profile |
| GET / PUT | `/customers/{id}` | owner or ADMIN | Read or update a profile |
| GET | `/customers` | ADMIN | All customers |

**How the JWT works:** the token is signed with **RS256** using a private key that only this
service has. It contains `sub` (customer id), `role` (CUSTOMER or ADMIN), name, email,
issuer and expiry. Kong and the other four services hold only the **public** key: they can
verify a token but cannot create one.

**Events:** publishes `customer.registered` to RabbitMQ, which triggers the welcome email and SMS.

**Other details:** an admin account is created on first start from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env`. The service registers itself in Consul and exposes Prometheus
metrics at `/metrics`. Kong rate-limits `/auth` to 30 requests per minute to slow down
password guessing.

**Files:** `customer-service/app.py`

---

## 2. Product Service: Node.js (Express) + PostgreSQL

**What it does:** the catalogue. It manages products, categories, prices and stock, and
**reserves stock** when an order is placed.

**Why PostgreSQL:** stock must never go below zero, even when two people buy the last item at the
same moment. PostgreSQL gives strict ACID transactions and row locks for that.

**Data:**

| Table | Contents |
|---|---|
| `categories` | id, name |
| `products` | id, name, category, `price NUMERIC(12,2)`, `stock CHECK (stock >= 0)` |
| `stock_reservations` | which order reserved how many of which product |

Seed data: three products and two categories, created on first start.

**REST API (through Kong):**

| Method | Path | Who |
|---|---|---|
| GET | `/products`, `/products/{id}`, `/categories` | signed in |
| POST | `/products` | ADMIN (validated: name, price ≥ 0, whole-number stock) |
| PATCH | `/products/{id}/stock` | ADMIN |

**gRPC API (internal, port 50051):** `ProductStock.ReserveStock`, defined in
`product-service/proto/product.proto`. Order Service calls it with the order id and the
items. In **one PostgreSQL transaction** the service locks each product row
(`SELECT … FOR UPDATE`), checks the stock, decrements it and records the reservation. If any
item is short, the whole transaction rolls back and nothing is reserved. It returns the
current names and prices, so the order always uses the catalogue's real price, never a price
sent by the browser. Calling it twice with the same order id does not reserve twice
(idempotent).

**Why gRPC here:** it's a fast internal call with a strict, typed contract that both the Java
client and the Node server generate code from.

**Files:** `product-service/src/server.js`, `src/platform.js` (JWT check, Consul, logging), `proto/product.proto`

---

## 3. Order Service: Java (Spring Boot) + MySQL

**What it does:** places orders and tracks them from "pending payment" to "paid". It's the
centre of the system and shows the most patterns.

**Placing an order (`POST /orders`):**
1. **REST call to Customer Service** (`GET /customers/{id}`, passing on the user's token) to
   check the customer exists and is active.
2. **gRPC call to Product Service** (`ReserveStock`) to reserve the items and get the prices.
3. **One MySQL transaction (ACID)** that writes the `orders` row, the `order_items` rows and an
   `outbox` row containing the `order.created` event. Either all three are saved or none are.
4. It replies `201 Created` with status `PENDING_PAYMENT`. It doesn't pretend billing has
   already happened.

The remote calls happen *before* the transaction, so no database locks are held while waiting
on the network.

**Transactional outbox + CDC:** Order Service never sends messages itself. **Debezium** reads
MySQL's change log (binlog), sees the new `outbox` row and publishes it to RabbitMQ with the
routing key `order.created`. If the transaction rolls back, there's no binlog entry and no
event. So "order saved" and "event published" can never disagree.

**CQRS (separate write and read sides):**
- *Write side:* `orders` and `order_items`, changed only by commands.
- *Read side:* `order_view`, one denormalised row per order (customer name, items, total,
  invoice id, payment status and a **history** of events). It is built only by consuming
  events (`order.*`, `invoice.*`, `payment.*`). `GET /orders` and `GET /orders/{id}` read only
  this table.
- The read side is **eventually consistent**: right after placing an order it may take a moment
  to appear. The website shows that as a live timeline.

**Saga step:** it consumes `payment.completed` from Billing, marks the order `PAID` and
writes an `order.paid` event to the outbox (in one transaction).

**Circuit breakers (Resilience4j):** separate breakers named `product` and `customer`. After 2
failures in the last 4 calls the breaker **opens for 15 seconds**: calls fail immediately with
`503 "… circuit breaker fallback"` instead of hanging. Then one test call is allowed
(half-open); if it works, the breaker closes again. The gRPC call also has a 2-second deadline.
You can see the state at `/actuator/circuitbreakers` and in Grafana.

**Discovery:** it uses Spring Cloud Consul to register itself and to find healthy
`customer-service` and `product-service` instances (for gRPC, the port comes from the Consul
metadata).

**Idempotent consumers:** every event it handles is recorded in `processed_events`; a
redelivered event is skipped.

**Security:** Spring Security OAuth2 resource server, which verifies the RS256 JWT, maps `role` to
`ROLE_CUSTOMER` / `ROLE_ADMIN`, and lets customers see only their own orders. The database user
`order_app` can only read and write data (no DDL). Debezium has its own read-only replication user.

**API:** `POST /orders`, `GET /orders`, `GET /orders/{id}`.

**Files:** `order-service/src/main/java/com/retailflow/order/` (`OrderService`, `ProductClient`,
`CustomerClient`, `EventListeners`, `OrderQueries`, `SecurityConfig`), `infra/mysql/01-order-schema.sh`

---

## 4. Billing Service: Go + SQLite

**What it does:** invoices and payments. It creates an invoice for every new order and records
payments. Payment is simulated; no real payment provider is involved.

**Why SQLite:** billing data is small and owned by one service. SQLite is a full ACID database
in a single file on the service's own volume, with no separate server to run. (In Kubernetes
it runs as a StatefulSet with one replica and its own persistent volume.)

**Data:** `invoices`, `payments`, `processed_events`, `outbox`.

**How it works:**
- **Consumes `order.created`** from the `billing.orders` queue. In one SQLite transaction it
  records the event id (to skip duplicates), creates the invoice (`INV-XXXXXXXX`, status
  `UNPAID`) and writes an `invoice.created` event to its outbox. `order_id` is unique, so one
  order can never get two invoices.
- **`POST /billing/invoices/{id}/pay`:** in one transaction it marks the invoice `PAID`, inserts a
  payment row and writes `payment.completed` to the outbox. Paying twice returns `409`.
- **Outbox relay:** a background goroutine reads unpublished outbox rows every second,
  publishes them to RabbitMQ with **publisher confirms**, and only then marks them published.
  (This is the "polling publisher" style of outbox, while Order Service uses log-based CDC, so
  both approaches are demonstrated.)
- A malformed message is rejected straight to the dead-letter queue. A temporary failure is
  re-queued, and the queue moves it to the dead-letter queue after 5 attempts.

**API:** `GET /billing/invoices` (own, or all for ADMIN), `GET /billing/invoices/{id}`,
`POST /billing/invoices/{id}/pay`.

**Files:** `billing-service/main.go`, `platform.go` (JWT check, Consul registration)

---

## 5. Notification Service: C# (ASP.NET Core) + Redis

**What it does:** tells the customer what happened, in-app, by email and by SMS.

**Why Redis:** notifications are a simple, fast-growing feed per customer. Redis lists
(`LPUSH` / `LRANGE`) are ideal, and Redis is persistent here (append-only file).

**How it works:**
- Consumes the `notification.events` queue, which is bound to `customer.*`, `order.*`,
  `invoice.*` and `payment.*`, one queue receiving many event types through topic wildcards.
- For each event it writes a message such as "Invoice INV-1A2B for ₹6,997 is ready" and:
  - stores it in Redis (`notifications:{customerId}` plus a global feed) for the in-app list,
  - sends an **email** over SMTP to **Mailpit** (a test inbox at http://localhost:8025),
  - sends a simulated **SMS** for the welcome message (logged, not actually sent).
- **Idempotent:** `SET processed:{eventId} NX` in Redis, so a duplicate event never sends a
  second email.
- **Circuit breaker (Polly):** around SMTP. If the mail server keeps failing, the breaker opens
  for 30 seconds, and emails are marked `SKIPPED_CIRCUIT_OPEN` while in-app notifications
  still work.

**API:** `GET /notifications` (your own; ADMIN sees the latest of everyone's).

**Files:** `notification-service/Program.cs`, `Notifications.cs`

---

## The website: React (Vite) served by nginx

A single-page store: sign in / register, shop with cart, order page with a live timeline,
invoices with payment buttons, notifications with a badge, admin pages (products, all orders,
customers) and a System page. It's served by Kong at `/` and calls the APIs on the same address,
so every click goes through the gateway. The **Request log** bar at the bottom shows each call,
which service answered and its `X-Request-ID`. Files: `web-ui/src/`.

---

## Shared infrastructure

| Component | Role |
|---|---|
| **Kong** (API gateway) | Single entry point on HTTPS 8443. Checks the JWT, rate-limits, limits request size, adds security headers and an `X-Request-ID`. Finds services through Consul DNS. Config: `infra/kong/kong.yml.tmpl` |
| **Consul** (discovery) | Every service registers itself with a health check. Kong, Order Service and Prometheus look services up here. UI: http://localhost:8500 |
| **RabbitMQ** (broker) | Topic exchange `retailflow.events`, quorum queues with 5 retries and a dead-letter queue each, and a restricted application user. Created by `infra/rabbitmq/init-topology.sh`. UI: http://localhost:15672 |
| **Debezium** (CDC) | Reads the MySQL binlog and publishes Order Service's outbox rows. Config: `infra/debezium/application.properties` |
| **Prometheus + Grafana** | Metrics from every service (found via Consul), alert rules, a dashboard. http://localhost:9090, http://localhost:3000 |
| **Loki + Promtail** | Collect the JSON logs of every container. Search by `X-Request-ID` in Grafana to follow one request across services |
| **Mailpit** | Fake mail server with a web inbox for the emails |
| **secrets-init, rabbitmq-init, order-db-init** | One-off setup jobs: generate keys and certificates, create the queues, create the MySQL schema and users |

## Events at a glance

| Event | Published by | Consumed by |
|---|---|---|
| `customer.registered` | Customer | Notification |
| `order.created` | Order (outbox → Debezium) | Billing, Order (read model), Notification |
| `invoice.created` | Billing (outbox relay) | Order (read model), Notification |
| `payment.completed` | Billing (outbox relay) | Order (saga + read model), Notification |
| `order.paid` | Order (outbox → Debezium) | Order (read model), Notification |

Every event has the same envelope: `eventId`, `eventType`, `occurredAt`, `correlationId`
(the gateway's `X-Request-ID`) and `payload`. Delivery is **at-least-once**, and every consumer
skips duplicates by `eventId`.
