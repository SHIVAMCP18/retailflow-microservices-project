package com.retailflow.order;

import com.retailflow.product.grpc.ProductStockGrpc;
import com.retailflow.product.grpc.ReserveItem;
import com.retailflow.product.grpc.ReserveReply;
import com.retailflow.product.grpc.ReserveRequest;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.stub.MetadataUtils;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.cloud.client.ServiceInstance;
import org.springframework.cloud.client.discovery.DiscoveryClient;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Synchronous gRPC call to Product Service. The address comes from Consul
 * (the instance's "grpc_port" metadata) and the call is protected by a
 * Resilience4j circuit breaker plus a 2-second gRPC deadline.
 */
@Component
public class ProductClient {
  private static final Logger log = LoggerFactory.getLogger(ProductClient.class);
  private static final Metadata.Key<String> REQUEST_ID = Metadata.Key.of("x-request-id", Metadata.ASCII_STRING_MARSHALLER);
  private final DiscoveryClient discovery;
  private final Map<String, ManagedChannel> channels = new ConcurrentHashMap<>();

  public ProductClient(DiscoveryClient discovery) {
    this.discovery = discovery;
  }

  @CircuitBreaker(name = "product", fallbackMethod = "unavailable")
  public ReserveReply reserve(String orderId, List<OrderService.Line> lines) {
    List<ServiceInstance> instances = discovery.getInstances("product-service");
    if (instances.isEmpty()) throw new IllegalStateException("No healthy product-service instance registered in Consul");
    ServiceInstance instance = instances.get(ThreadLocalRandom.current().nextInt(instances.size()));
    String target = instance.getHost() + ":" + instance.getMetadata().getOrDefault("grpc_port", "50051");
    ManagedChannel channel = channels.computeIfAbsent(target, t -> ManagedChannelBuilder.forTarget(t).usePlaintext().build());

    var headers = new Metadata();
    if (MDC.get("requestId") != null) headers.put(REQUEST_ID, MDC.get("requestId"));
    var request = ReserveRequest.newBuilder().setOrderId(orderId);
    lines.forEach(l -> request.addItems(ReserveItem.newBuilder().setProductId(l.productId()).setQuantity(l.quantity())));
    log.info("gRPC ReserveStock -> {}", target);
    return ProductStockGrpc.newBlockingStub(channel)
        .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
        .withDeadlineAfter(2, TimeUnit.SECONDS)
        .reserveStock(request.build());
  }

  ReserveReply unavailable(String orderId, List<OrderService.Line> lines, Throwable error) {
    log.warn("product-service call failed, circuit breaker fallback: {}", error.toString());
    throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "Product service unavailable (circuit breaker fallback). Please retry shortly.");
  }
}
