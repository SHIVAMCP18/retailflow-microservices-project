#!/bin/bash
# Creates the Order Service schema and database users. Safe to run repeatedly.
# Docker Compose runs it from the one-off "order-db-init" container (MYSQL_HOST=order-db);
# Kubernetes runs it as a MySQL first-start script (docker-entrypoint-initdb.d).
# The schema lives with the database, not in the application, so Debezium can
# start streaming before Order Service boots.
set -eo pipefail

mysql -h"${MYSQL_HOST:-localhost}" -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS orders;
USE orders;

-- ===== Write model (command side, ACID) =====
CREATE TABLE IF NOT EXISTS orders (
  id           CHAR(36)      PRIMARY KEY,
  customer_id  VARCHAR(64)   NOT NULL,
  status       VARCHAR(30)   NOT NULL,
  total        DECIMAL(12,2) NOT NULL,
  currency     CHAR(3)       NOT NULL DEFAULT 'INR',
  version      INT           NOT NULL DEFAULT 0,
  created_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_orders_customer (customer_id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id           BIGINT        AUTO_INCREMENT PRIMARY KEY,
  order_id     CHAR(36)      NOT NULL,
  product_id   BIGINT        NOT NULL,
  product_name VARCHAR(200)  NOT NULL,
  unit_price   DECIMAL(12,2) NOT NULL,
  quantity     INT           NOT NULL CHECK (quantity > 0),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- ===== Transactional outbox, read by Debezium from the binlog (CDC) =====
-- Column names follow Debezium's Outbox Event Router defaults.
CREATE TABLE IF NOT EXISTS outbox (
  id            CHAR(36)     PRIMARY KEY,
  aggregatetype VARCHAR(64)  NOT NULL,
  aggregateid   VARCHAR(64)  NOT NULL,
  type          VARCHAR(64)  NOT NULL,
  payload       JSON         NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- ===== Idempotent consumers: one row per (consumer, event) handled =====
CREATE TABLE IF NOT EXISTS processed_events (
  consumer     VARCHAR(64)   NOT NULL,
  event_id     CHAR(36)      NOT NULL,
  processed_at TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consumer, event_id)
);

-- ===== Read model (query side, eventually consistent / BASE) =====
-- Built only from events by OrderProjection; never written by commands.
CREATE TABLE IF NOT EXISTS order_view (
  order_id       CHAR(36)      PRIMARY KEY,
  customer_id    VARCHAR(64)   NOT NULL,
  customer_name  VARCHAR(200),
  customer_email VARCHAR(200),
  status         VARCHAR(30)   NOT NULL,
  total          DECIMAL(12,2) NOT NULL,
  currency       CHAR(3)       NOT NULL,
  items          JSON          NOT NULL,
  invoice_id     VARCHAR(64),
  payment_status VARCHAR(30),
  history        JSON          NOT NULL,
  created_at     TIMESTAMP(3)  NOT NULL,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_view_customer (customer_id)
);

-- ===== Least-privilege accounts =====
CREATE USER IF NOT EXISTS 'order_app'@'%' IDENTIFIED BY '${MYSQL_ORDER_PASSWORD}';
ALTER USER 'order_app'@'%' IDENTIFIED BY '${MYSQL_ORDER_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON orders.* TO 'order_app'@'%';

CREATE USER IF NOT EXISTS 'debezium'@'%' IDENTIFIED BY '${MYSQL_DEBEZIUM_PASSWORD}';
ALTER USER 'debezium'@'%' IDENTIFIED BY '${MYSQL_DEBEZIUM_PASSWORD}';
GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'debezium'@'%';
FLUSH PRIVILEGES;
SQL
echo "orders schema and accounts created"
