package com.retailflow.order;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.sql.Timestamp;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.amqp.AmqpRejectAndDontRequeueException;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/** Asynchronous side of Order Service (RabbitMQ consumers). */
@Component
public class EventListeners {
  private static final Logger log = LoggerFactory.getLogger(EventListeners.class);
  private final OrderService orders;
  private final JdbcTemplate db;
  private final TransactionTemplate tx;
  private final ObjectMapper json;

  public EventListeners(OrderService orders, JdbcTemplate db, TransactionTemplate tx, ObjectMapper json) {
    this.orders = orders;
    this.db = db;
    this.tx = tx;
    this.json = json;
  }

  /** Saga: payment.completed from Billing moves the order to PAID. */
  @RabbitListener(queues = "order.payments")
  public void onPayment(Message message) {
    JsonNode event = read(message);
    JsonNode p = event.path("payload");
    orders.markPaid(event.path("eventId").asText(), p.path("orderId").asText(), p.path("invoiceId").asText(),
        p.path("customerId").asText(), p.path("customerEmail").asText());
  }

  /**
   * CQRS projection: builds order_view from events (order.*, invoice.*, payment.*).
   * The view is eventually consistent with the write model (BASE).
   */
  @RabbitListener(queues = "order.projection")
  public void project(Message message) {
    JsonNode event = read(message);
    String type = event.path("eventType").asText();
    JsonNode p = event.path("payload");
    String orderId = p.path("orderId").asText();
    String step = "{\"event\":\"" + type + "\",\"at\":\"" + event.path("occurredAt").asText(Instant.now().toString()) + "\"}";

    tx.executeWithoutResult(status -> {
      if (!orders.firstDelivery("order-projection", event.path("eventId").asText())) return;
      switch (type) {
        case "order.created" -> db.update("""
            INSERT INTO order_view(order_id, customer_id, customer_name, customer_email, status, total, currency, items, history, created_at)
            VALUES (?,?,?,?,?,?,?,?,JSON_ARRAY(CAST(? AS JSON)),?)""",
            orderId, p.path("customerId").asText(), p.path("customerName").asText(), p.path("customerEmail").asText(),
            p.path("status").asText(), p.path("total").decimalValue(), p.path("currency").asText(), p.path("items").toString(),
            step, Timestamp.from(Instant.parse(p.path("createdAt").asText())));
        case "invoice.created" -> db.update(
            "UPDATE order_view SET invoice_id = ?, payment_status = 'UNPAID', history = JSON_ARRAY_APPEND(history, '$', CAST(? AS JSON)) WHERE order_id = ?",
            p.path("invoiceId").asText(), step, orderId);
        case "payment.completed" -> db.update(
            "UPDATE order_view SET invoice_id = ?, payment_status = 'PAID', history = JSON_ARRAY_APPEND(history, '$', CAST(? AS JSON)) WHERE order_id = ?",
            p.path("invoiceId").asText(), step, orderId);
        case "order.paid" -> db.update(
            "UPDATE order_view SET status = 'PAID', history = JSON_ARRAY_APPEND(history, '$', CAST(? AS JSON)) WHERE order_id = ?",
            step, orderId);
        default -> log.debug("projection ignores {}", type);
      }
    });
    log.info("projection applied {} for order {}", type, orderId);
  }

  private JsonNode read(Message message) {
    try {
      JsonNode event = json.readTree(message.getBody());
      if (event.path("correlationId").isTextual()) MDC.put("requestId", event.path("correlationId").asText());
      return event;
    } catch (IOException e) {
      // Malformed message: send straight to the dead-letter queue, never retry.
      throw new AmqpRejectAndDontRequeueException("Unreadable event", e);
    }
  }
}
