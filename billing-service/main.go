// Billing Service (Go + SQLite)
// Consumes order.created, creates invoices, records payments and publishes
// payment.completed through a polling transactional outbox.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	amqp "github.com/rabbitmq/amqp091-go"
	_ "modernc.org/sqlite"
)

const port = 8084

var (
	db  *sql.DB
	log = slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "billing-service")

	invoicesCreated = promauto.NewCounter(prometheus.CounterOpts{Name: "billing_invoices_created_total", Help: "Invoices created from order events"})
	paymentsTotal   = promauto.NewCounterVec(prometheus.CounterOpts{Name: "billing_payments_total", Help: "Payment attempts"}, []string{"result"})
	httpRequests    = promauto.NewCounterVec(prometheus.CounterOpts{Name: "http_requests_total", Help: "HTTP requests"}, []string{"method", "route", "status"})
)

type Event struct {
	EventID       string          `json:"eventId"`
	EventType     string          `json:"eventType"`
	OccurredAt    string          `json:"occurredAt"`
	CorrelationID string          `json:"correlationId"`
	Payload       json.RawMessage `json:"payload"`
}

type OrderCreated struct {
	OrderID       string  `json:"orderId"`
	CustomerID    string  `json:"customerId"`
	CustomerName  string  `json:"customerName"`
	CustomerEmail string  `json:"customerEmail"`
	Total         float64 `json:"total"`
	Currency      string  `json:"currency"`
}

type Invoice struct {
	ID            string  `json:"invoiceId"`
	OrderID       string  `json:"orderId"`
	CustomerID    string  `json:"customerId"`
	CustomerEmail string  `json:"customerEmail"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
	Status        string  `json:"status"`
	PaymentMethod *string `json:"paymentMethod"`
	CreatedAt     string  `json:"createdAt"`
	PaidAt        *string `json:"paidAt"`
}

func main() {
	var err error
	// WAL + busy timeout: safe concurrent reads while the consumer writes.
	db, err = sql.Open("sqlite", "file:"+env("SQLITE_PATH", "/data/billing.db")+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	must(err)
	db.SetMaxOpenConns(1)
	must(migrate())
	loadPublicKey()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go consumeOrders(ctx)
	go relayOutbox(ctx)
	go registerWithConsul(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if db.Ping() != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "UP", "service": "billing-service"})
	})
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("GET /billing/invoices", withAuth(listInvoices))
	mux.HandleFunc("GET /billing/invoices/{id}", withAuth(getInvoice))
	mux.HandleFunc("POST /billing/invoices/{id}/pay", withAuth(payInvoice))

	server := &http.Server{Addr: ":8084", Handler: instrument(mux), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		deregisterFromConsul()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Info("billing-service started", "port", port)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		must(err)
	}
}

func migrate() error {
	_, err := db.Exec(`
	CREATE TABLE IF NOT EXISTS invoices (
	  id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, customer_id TEXT NOT NULL, customer_email TEXT,
	  customer_name TEXT, amount REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL,
	  payment_method TEXT, created_at TEXT NOT NULL, paid_at TEXT);
	CREATE TABLE IF NOT EXISTS payments (
	  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), amount REAL NOT NULL,
	  method TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS outbox (
	  id TEXT PRIMARY KEY, routing_key TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT);`)
	return err
}

// ---------- HTTP handlers ----------

func listInvoices(w http.ResponseWriter, r *http.Request, user Claims) {
	query, args := "SELECT "+invoiceColumns+" FROM invoices ORDER BY created_at DESC", []any{}
	if user.Role != "ADMIN" {
		query, args = "SELECT "+invoiceColumns+" FROM invoices WHERE customer_id = ? ORDER BY created_at DESC", []any{user.Subject}
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	result := []Invoice{}
	for rows.Next() {
		if inv, err := scanInvoice(rows); err == nil {
			result = append(result, inv)
		}
	}
	writeJSON(w, 200, result)
}

func getInvoice(w http.ResponseWriter, r *http.Request, user Claims) {
	inv, err := scanInvoice(db.QueryRow("SELECT "+invoiceColumns+" FROM invoices WHERE id = ?", r.PathValue("id")))
	if err != nil || (user.Role != "ADMIN" && inv.CustomerID != user.Subject) {
		httpError(w, 404, "Invoice not found")
		return
	}
	writeJSON(w, 200, inv)
}

// payInvoice records a (simulated) payment. Invoice update, payment row and
// outbox event are committed in one SQLite transaction (ACID).
func payInvoice(w http.ResponseWriter, r *http.Request, user Claims) {
	var body struct {
		Method string `json:"method"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Method == "" {
		body.Method = "CARD"
	}
	tx, err := db.Begin()
	if err != nil {
		httpError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	inv, err := scanInvoice(tx.QueryRow("SELECT "+invoiceColumns+" FROM invoices WHERE id = ?", r.PathValue("id")))
	if err != nil || (user.Role != "ADMIN" && inv.CustomerID != user.Subject) {
		httpError(w, 404, "Invoice not found")
		return
	}
	if inv.Status != "UNPAID" {
		httpError(w, 409, "Invoice is already "+inv.Status)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx.Exec("UPDATE invoices SET status = 'PAID', payment_method = ?, paid_at = ? WHERE id = ?", body.Method, now, inv.ID)
	tx.Exec("INSERT INTO payments(id, invoice_id, amount, method, result, created_at) VALUES (?,?,?,?,?,?)",
		uuid.NewString(), inv.ID, inv.Amount, body.Method, "SUCCEEDED", now)
	err = addToOutbox(tx, "payment.completed", r.Header.Get("X-Request-ID"), map[string]any{
		"invoiceId": inv.ID, "orderId": inv.OrderID, "customerId": inv.CustomerID, "customerEmail": inv.CustomerEmail,
		"amount": inv.Amount, "currency": inv.Currency, "method": body.Method})
	if err != nil || tx.Commit() != nil {
		paymentsTotal.WithLabelValues("error").Inc()
		httpError(w, 500, "payment could not be recorded")
		return
	}
	paymentsTotal.WithLabelValues("succeeded").Inc()
	log.Info("payment.completed", "invoiceId", inv.ID, "orderId", inv.OrderID, "requestId", r.Header.Get("X-Request-ID"))
	inv.Status, inv.PaymentMethod, inv.PaidAt = "PAID", &body.Method, &now
	writeJSON(w, 200, inv)
}

const invoiceColumns = "id, order_id, customer_id, customer_email, amount, currency, status, payment_method, created_at, paid_at"

type scanner interface{ Scan(...any) error }

func scanInvoice(row scanner) (Invoice, error) {
	var i Invoice
	err := row.Scan(&i.ID, &i.OrderID, &i.CustomerID, &i.CustomerEmail, &i.Amount, &i.Currency, &i.Status, &i.PaymentMethod, &i.CreatedAt, &i.PaidAt)
	return i, err
}

// ---------- RabbitMQ consumer: order.created -> invoice ----------

func consumeOrders(ctx context.Context) {
	for ctx.Err() == nil {
		conn, err := amqp.Dial(os.Getenv("RABBITMQ_URL"))
		if err != nil {
			log.Warn("waiting for RabbitMQ", "err", err)
			sleep(ctx, 3*time.Second)
			continue
		}
		ch, _ := conn.Channel()
		ch.Qos(10, 0, false)
		deliveries, err := ch.Consume("billing.orders", "billing-service", false, false, false, false, nil)
		if err != nil {
			log.Warn("cannot consume billing.orders", "err", err)
			conn.Close()
			sleep(ctx, 3*time.Second)
			continue
		}
		log.Info("consuming billing.orders")
	loop:
		for {
			select {
			case <-ctx.Done():
				break loop
			case d, ok := <-deliveries:
				if !ok {
					break loop
				}
				handleDelivery(d)
			}
		}
		conn.Close()
	}
}

func handleDelivery(d amqp.Delivery) {
	var event Event
	var order OrderCreated
	if json.Unmarshal(d.Body, &event) != nil || json.Unmarshal(event.Payload, &order) != nil || order.OrderID == "" {
		log.Error("unreadable message sent to dead-letter queue", "body", string(d.Body))
		d.Nack(false, false)
		return
	}
	if err := createInvoice(event, order); err != nil {
		log.Error("invoice creation failed, will retry", "err", err, "orderId", order.OrderID)
		d.Nack(false, true) // quorum queue delivery-limit -> DLQ after 5 attempts
		return
	}
	d.Ack(false)
}

func createInvoice(event Event, order OrderCreated) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339)
	// Idempotent consumer: a redelivered event is acknowledged without side effects.
	res, err := tx.Exec("INSERT OR IGNORE INTO processed_events(event_id, processed_at) VALUES (?, ?)", event.EventID, now)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		log.Info("duplicate event ignored", "eventId", event.EventID)
		return nil
	}
	invoiceID := "INV-" + strings.ToUpper(uuid.NewString()[:8])
	if _, err = tx.Exec(`INSERT INTO invoices(id, order_id, customer_id, customer_email, customer_name, amount, currency, status, created_at)
		VALUES (?,?,?,?,?,?,?,'UNPAID',?)`, invoiceID, order.OrderID, order.CustomerID, order.CustomerEmail, order.CustomerName,
		order.Total, order.Currency, now); err != nil {
		return err
	}
	if err = addToOutbox(tx, "invoice.created", event.CorrelationID, map[string]any{
		"invoiceId": invoiceID, "orderId": order.OrderID, "customerId": order.CustomerID, "customerEmail": order.CustomerEmail,
		"amount": order.Total, "currency": order.Currency}); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	invoicesCreated.Inc()
	log.Info("invoice.created", "invoiceId", invoiceID, "orderId", order.OrderID, "requestId", event.CorrelationID)
	return nil
}

// ---------- Transactional outbox (polling publisher) ----------

func addToOutbox(tx *sql.Tx, routingKey, correlationID string, payload map[string]any) error {
	id := uuid.NewString()
	body, _ := json.Marshal(map[string]any{"eventId": id, "eventType": routingKey, "occurredAt": time.Now().UTC().Format(time.RFC3339Nano),
		"correlationId": correlationID, "payload": payload})
	_, err := tx.Exec("INSERT INTO outbox(id, routing_key, body, created_at) VALUES (?,?,?,?)", id, routingKey, string(body), time.Now().UTC().Format(time.RFC3339))
	return err
}

// relayOutbox publishes committed outbox rows with publisher confirms and only
// then marks them published (at-least-once; consumers are idempotent).
func relayOutbox(ctx context.Context) {
	for ctx.Err() == nil {
		conn, err := amqp.Dial(os.Getenv("RABBITMQ_URL"))
		if err != nil {
			sleep(ctx, 3*time.Second)
			continue
		}
		ch, _ := conn.Channel()
		ch.Confirm(false)
		for ctx.Err() == nil && !conn.IsClosed() {
			if err := publishPending(ctx, ch); err != nil {
				log.Warn("outbox relay error", "err", err)
				break
			}
			sleep(ctx, time.Second)
		}
		conn.Close()
	}
}

func publishPending(ctx context.Context, ch *amqp.Channel) error {
	rows, err := db.Query("SELECT id, routing_key, body FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50")
	if err != nil {
		return err
	}
	type row struct{ id, key, body string }
	var pending []row
	for rows.Next() {
		var r row
		rows.Scan(&r.id, &r.key, &r.body)
		pending = append(pending, r)
	}
	rows.Close()
	for _, r := range pending {
		confirm, err := ch.PublishWithDeferredConfirmWithContext(ctx, "retailflow.events", r.key, true, false,
			amqp.Publishing{ContentType: "application/json", DeliveryMode: amqp.Persistent, MessageId: r.id, Body: []byte(r.body)})
		if err != nil {
			return err
		}
		if ok, err := confirm.WaitContext(ctx); err != nil || !ok {
			return errors.New("broker did not confirm publish")
		}
		db.Exec("UPDATE outbox SET published_at = ? WHERE id = ?", time.Now().UTC().Format(time.RFC3339), r.id)
		log.Info("event.published", "eventType", r.key, "eventId", r.id)
	}
	return nil
}

// ---------- helpers ----------

func instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		httpRequests.WithLabelValues(r.Method, route, strconv.Itoa(rec.status)).Inc()
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func httpError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func must(err error) {
	if err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}
