package com.retailflow.order;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.security.oauth2.resource.OAuth2ResourceServerProperties;
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * OAuth2 resource server: every request must carry an RS256 JWT issued by
 * Customer Service. The "role" claim becomes a Spring authority (ROLE_ADMIN /
 * ROLE_CUSTOMER). Actuator endpoints stay open because they are reachable only
 * inside the cluster (Kong does not route to them).
 */
@Configuration
public class SecurityConfig {
  public static final String ISSUER = "retailflow-customer-service";

  @Bean
  SecurityFilterChain security(HttpSecurity http) throws Exception {
    var roles = new JwtAuthenticationConverter();
    roles.setJwtGrantedAuthoritiesConverter(jwt -> List.of(new SimpleGrantedAuthority("ROLE_" + jwt.getClaimAsString("role"))));
    return http
        .csrf(csrf -> csrf.disable())
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/actuator/**").permitAll()
            .anyRequest().hasAnyRole("CUSTOMER", "ADMIN"))
        .oauth2ResourceServer(oauth -> oauth.jwt(jwt -> jwt.jwtAuthenticationConverter(roles)))
        .build();
  }

  @Bean
  NimbusJwtDecoder jwtDecoder(OAuth2ResourceServerProperties properties) throws IOException {
    try (var pem = properties.getJwt().getPublicKeyLocation().getInputStream()) {
      var decoder = NimbusJwtDecoder.withPublicKey(RsaKeyConverters.x509().convert(pem)).build();
      decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(ISSUER));
      return decoder;
    }
  }

  /** RestClient whose host names are resolved through Consul (Spring Cloud LoadBalancer). */
  @Bean
  @LoadBalanced
  RestClient.Builder loadBalancedRestClient() {
    return RestClient.builder();
  }

  /** Puts the gateway's X-Request-ID into every log line of this request. */
  @Component
  static class RequestIdFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
      var id = request.getHeader("X-Request-ID");
      MDC.put("requestId", id != null ? id : UUID.randomUUID().toString());
      try {
        chain.doFilter(request, response);
      } finally {
        MDC.remove("requestId");
      }
    }
  }
}
