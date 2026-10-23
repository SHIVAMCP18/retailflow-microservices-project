package com.retailflow.order;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/** Command side of Order Service. */
@Service
public class OrderService {
  private static final Logger log = LoggerFactory.getLogger(OrderService.class);
  private final JdbcTemplate db;
  private final TransactionTemplate tx;
  private final CustomerClient customers;
  private final ProductClient products;
  private final ObjectMapper json;

  public OrderService(JdbcTemplate db, TransactionTemplate tx, CustomerClient customers, ProductClient products, ObjectMapper json) {
    this.db = db;
    this.tx = tx;
    this.customers = customers;
    this.products = products;
    this.json = json;
  }

  /**
   * 1. REST  -> Customer Service: does the customer exist and is it active?
   * 2. gRPC  -> Product Service: reserve stock and get authoritative prices.
   * 3. One local ACID transaction: order + items + outbox event.
   * Debezium then publishes the outbox row to RabbitMQ (CDC).
   * The remote calls run before the transaction so no DB locks are held while waiting on the network.
   */
  public Map<String, Object> place(String customerId, List<Line> lines, String bearerToken) {
    if (lines == null || lines.isEmpty() || lines.stream().anyMatch(l -> l.productId() == null || l.quantity() == null || l.quantity() < 1))
      throw new ApiException(HttpStatus.BAD_REQUEST, "items must contain productId and a positive quantity");

    var customer = customers.get(customerId, bearerToken);
    if (!"ACTIVE".equals(customer.status())) throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, "Customer account is not active");

    String orderId = UUID.randomUUID().toString();
    var reply = products.reserve(orderId, lines);
    if (!reply.getSuccess()) throw new ApiException(HttpStatus.CONFLICT, reply.getMessage());

    List<Map<String, Object>> items = new ArrayList<>();
    BigDecimal total = BigDecimal.ZERO;
    for (var line : reply.getLinesList()) {
      BigDecimal price = BigDecimal.valueOf(line.getUnitPrice());
      total = total.add(price.multiply(BigDecimal.valueOf(line.getQuantity())));
      items.add(Map.of("productId", line.getProductId(), "name", line.getName(), "unitPrice", price, "quantity", line.getQuantity()));
    }
    BigDecimal orderTotal = total;

    Map<String, Object> order = new LinkedHashMap<>();
    order.put("orderId", orderId);
    order.put("customerId", customer.id());
    order.put("customerName", customer.name());
    order.put("customerEmail", customer.email());
    order.put("status", "PENDING_PAYMENT");
    order.put("total", orderTotal);
    order.put("currency", "INR");
    order.put("items", items);
    order.put("createdAt", Instant.now().toString());

    tx.executeWithoutResult(status -> {
      db.update("INSERT INTO orders(id, customer_id, status, total, currency) VALUES (?,?,?,?,?)",
          orderId, customer.id(), "PENDING_PAYMENT", orderTotal, "INR");
      for (var item : items)
        db.update("INSERT INTO order_items(order_id, product_id, product_name, unit_price, quantity) VALUES (?,?,?,?,?)",
            orderId, item.get("productId"), item.get("name"), item.get("unitPrice"), item.get("quantity"));
      writeOutbox(orderId, "order.created", order);
    });
    log.info("order {} placed for customer {} total {}", orderId, customer.id(), orderTotal);
    return order;
  }

  /** Saga step: Billing reported a successful payment. */
  public void markPaid(String eventId, String orderId, String invoiceId, String customerId, String customerEmail) {
    tx.executeWithoutResult(status -> {
      if (!firstDelivery("order-payments", eventId)) return;
      int updated = db.update("UPDATE orders SET status = 'PAID', version = version + 1 WHERE id = ? AND status = 'PENDING_PAYMENT'", orderId);
      if (updated == 1) writeOutbox(orderId, "order.paid", Map.of("orderId", orderId, "invoiceId", invoiceId, "status", "PAID",
          "customerId", customerId, "customerEmail", customerEmail));
      log.info("order {} marked PAID (invoice {})", orderId, invoiceId);
    });
  }

  /** Idempotent consumer: returns false if this event was already handled. */
  boolean firstDelivery(String consumer, String eventId) {
    return db.update("INSERT IGNORE INTO processed_events(consumer, event_id) VALUES (?, ?)", consumer, eventId) == 1;
  }

  private void writeOutbox(String orderId, String type, Map<String, Object> payload) {
    Map<String, Object> event = new LinkedHashMap<>();
    event.put("eventId", UUID.randomUUID().toString());
    event.put("eventType", type);
    event.put("occurredAt", Instant.now().toString());
    event.put("correlationId", MDC.get("requestId"));
    event.put("payload", payload);
    try {
      db.update("INSERT INTO outbox(id, aggregatetype, aggregateid, type, payload) VALUES (?,?,?,?,?)",
          event.get("eventId"), "order", orderId, type, json.writeValueAsString(event));
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  public record Line(Long productId, Integer quantity) {}
}
