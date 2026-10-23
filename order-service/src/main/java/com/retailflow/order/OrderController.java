package com.retailflow.order;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderService commands;
  private final OrderQueries queries;

  public OrderController(OrderService commands, OrderQueries queries) {
    this.commands = commands;
    this.queries = queries;
  }

  /** Command. Customers order for themselves; an admin may pass customerId. */
  @PostMapping
  ResponseEntity<Map<String, Object>> place(@RequestBody PlaceOrder request, @AuthenticationPrincipal Jwt jwt) {
    String customerId = isAdmin(jwt) && request.customerId() != null ? request.customerId() : jwt.getSubject();
    return ResponseEntity.status(HttpStatus.CREATED).body(commands.place(customerId, request.items(), jwt.getTokenValue()));
  }

  /** Queries read the CQRS read model (order_view), never the write tables. */
  @GetMapping
  List<Map<String, Object>> list(@AuthenticationPrincipal Jwt jwt) {
    return isAdmin(jwt) ? queries.all() : queries.forCustomer(jwt.getSubject());
  }

  @GetMapping("/{id}")
  Map<String, Object> get(@PathVariable String id, @AuthenticationPrincipal Jwt jwt) {
    var order = queries.byId(id)
        .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Order not found in read model yet (it is eventually consistent - retry in a moment)"));
    if (!isAdmin(jwt) && !jwt.getSubject().equals(order.get("customerId"))) throw new ApiException(HttpStatus.NOT_FOUND, "Order not found");
    return order;
  }

  private static boolean isAdmin(Jwt jwt) {
    return "ADMIN".equals(jwt.getClaimAsString("role"));
  }

  record PlaceOrder(String customerId, List<OrderService.Line> items) {}
}
