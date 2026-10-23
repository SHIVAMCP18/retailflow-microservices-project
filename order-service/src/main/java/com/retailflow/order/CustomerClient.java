package com.retailflow.order;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

/** Synchronous REST call to Customer Service, discovered through Consul. */
@Component
public class CustomerClient {
  private static final Logger log = LoggerFactory.getLogger(CustomerClient.class);
  private final RestClient rest;

  public CustomerClient(RestClient.Builder loadBalanced) {
    this.rest = loadBalanced.baseUrl("http://customer-service").build();
  }

  /** The caller's JWT is relayed so Customer Service applies its own access rules. */
  @CircuitBreaker(name = "customer", fallbackMethod = "unavailable")
  public Customer get(String customerId, String bearerToken) {
    try {
      Map<?, ?> body = rest.get().uri("/customers/{id}", customerId)
          .header("Authorization", "Bearer " + bearerToken)
          .header("X-Request-ID", MDC.get("requestId"))
          .retrieve().body(Map.class);
      return new Customer((String) body.get("id"), (String) body.get("name"), (String) body.get("email"), (String) body.get("status"));
    } catch (HttpClientErrorException error) {
      if (error.getStatusCode() == HttpStatus.NOT_FOUND || error.getStatusCode() == HttpStatus.FORBIDDEN) throw new CustomerNotFound();
      throw error;
    }
  }

  Customer unavailable(String customerId, String bearerToken, Throwable error) {
    if (error instanceof CustomerNotFound notFound) throw notFound;
    log.warn("customer-service call failed, circuit breaker fallback: {}", error.toString());
    throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "Customer service unavailable (circuit breaker fallback). Please retry shortly.");
  }

  public record Customer(String id, String name, String email, String status) {}

  public static class CustomerNotFound extends ApiException {
    public CustomerNotFound() { super(HttpStatus.UNPROCESSABLE_ENTITY, "Customer does not exist"); }
  }
}
