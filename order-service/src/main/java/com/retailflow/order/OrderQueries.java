package com.retailflow.order;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Query side of CQRS: reads only the denormalised order_view table. */
@Component
public class OrderQueries {
  private static final String SELECT = "SELECT * FROM order_view";
  private final JdbcTemplate db;
  private final ObjectMapper json;

  public OrderQueries(JdbcTemplate db, ObjectMapper json) {
    this.db = db;
    this.json = json;
  }

  public List<Map<String, Object>> all() {
    return db.queryForList(SELECT + " ORDER BY created_at DESC").stream().map(this::view).toList();
  }

  public List<Map<String, Object>> forCustomer(String customerId) {
    return db.queryForList(SELECT + " WHERE customer_id = ? ORDER BY created_at DESC", customerId).stream().map(this::view).toList();
  }

  public Optional<Map<String, Object>> byId(String id) {
    return db.queryForList(SELECT + " WHERE order_id = ?", id).stream().findFirst().map(this::view);
  }

  private Map<String, Object> view(Map<String, Object> row) {
    Map<String, Object> view = new LinkedHashMap<>();
    view.put("orderId", row.get("order_id"));
    view.put("customerId", row.get("customer_id"));
    view.put("customerName", row.get("customer_name"));
    view.put("status", row.get("status"));
    view.put("total", row.get("total"));
    view.put("currency", row.get("currency"));
    view.put("items", parse(row.get("items")));
    view.put("invoiceId", row.get("invoice_id"));
    view.put("paymentStatus", row.get("payment_status"));
    view.put("history", parse(row.get("history")));
    view.put("createdAt", row.get("created_at"));
    view.put("updatedAt", row.get("updated_at"));
    return view;
  }

  private Object parse(Object value) {
    try {
      return json.readValue(String.valueOf(value), new TypeReference<Object>() {});
    } catch (Exception e) {
      return value;
    }
  }
}
