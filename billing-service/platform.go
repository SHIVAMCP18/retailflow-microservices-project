package main

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ---------- JWT verification (RS256, issued by Customer Service) ----------

type Claims struct {
	Role string `json:"role"`
	jwt.RegisteredClaims
}

var publicKey *rsa.PublicKey

func loadPublicKey() {
	pem, err := os.ReadFile(env("JWT_PUBLIC_KEY_FILE", "/run/secrets/jwt_public_key"))
	must(err)
	publicKey, err = jwt.ParseRSAPublicKeyFromPEM(pem)
	must(err)
}

func withAuth(handler func(http.ResponseWriter, *http.Request, Claims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var claims Claims
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		_, err := jwt.ParseWithClaims(token, &claims, func(*jwt.Token) (any, error) { return publicKey, nil },
			jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer("retailflow-customer-service"), jwt.WithExpirationRequired())
		if err != nil {
			httpError(w, 401, "Invalid or missing token")
			return
		}
		if claims.Role != "CUSTOMER" && claims.Role != "ADMIN" {
			httpError(w, 403, "Unknown role")
			return
		}
		handler(w, r, claims)
	}
}

// ---------- Consul self-registration ----------

func serviceID() string { h, _ := os.Hostname(); return "billing-service-" + h }

func ownAddress() string {
	if ip := os.Getenv("POD_IP"); ip != "" {
		return ip
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil {
			return ipnet.IP.String()
		}
	}
	h, _ := os.Hostname()
	return h
}

func registerWithConsul(ctx context.Context) {
	address := ownAddress()
	body, _ := json.Marshal(map[string]any{
		"ID": serviceID(), "Name": "billing-service", "Address": address, "Port": port, "Tags": []string{"go"},
		"Meta": map[string]string{"metrics_path": "/metrics"},
		"Check": map[string]string{"HTTP": fmt.Sprintf("http://%s:%d/health", address, port), "Interval": "10s",
			"Timeout": "3s", "DeregisterCriticalServiceAfter": "1m"},
	})
	for ctx.Err() == nil {
		req, _ := http.NewRequest(http.MethodPut, env("CONSUL_HTTP_ADDR", "http://consul:8500")+"/v1/agent/service/register", bytes.NewReader(body))
		if resp, err := http.DefaultClient.Do(req); err != nil {
			log.Warn("consul unavailable", "err", err)
		} else {
			resp.Body.Close()
		}
		sleep(ctx, 30*time.Second)
	}
}

func deregisterFromConsul() {
	req, _ := http.NewRequest(http.MethodPut, env("CONSUL_HTTP_ADDR", "http://consul:8500")+"/v1/agent/service/deregister/"+serviceID(), nil)
	if resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req); err == nil {
		resp.Body.Close()
	}
}
