using System.Net.Http.Json;
using System.Net.Mail;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Polly;
using Polly.CircuitBreaker;
using Prometheus;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;

namespace RetailFlow.Notifications;

public record Notification(string Id, string EventType, string CustomerId, string Subject, string Message,
                           string[] Channels, string EmailStatus, string? CorrelationId, DateTime CreatedAt);

/// <summary>Redis is this service's own database: one list per customer plus a global feed.</summary>
public sealed class NotificationStore(IConnectionMultiplexer redis)
{
    private IDatabase Db => redis.GetDatabase();

    /// <summary>Idempotent consumer: SET NX on the event id (kept for 7 days).</summary>
    public Task<bool> FirstDelivery(string eventId) =>
        Db.StringSetAsync($"processed:{eventId}", "1", TimeSpan.FromDays(7), When.NotExists);

    public async Task Save(Notification n)
    {
        var json = JsonSerializer.Serialize(n);
        var batch = Db.CreateBatch();
        var a = batch.ListLeftPushAsync($"notifications:{n.CustomerId}", json);
        var b = batch.ListLeftPushAsync("notifications:all", json);
        var c = batch.ListTrimAsync("notifications:all", 0, 499);
        batch.Execute();
        await Task.WhenAll(a, b, c);
    }

    public Task<Notification[]> ForCustomer(string customerId) => Read($"notifications:{customerId}", 100);
    public Task<Notification[]> Latest() => Read("notifications:all", 100);

    private async Task<Notification[]> Read(string key, int count) =>
        (await Db.ListRangeAsync(key, 0, count - 1)).Select(v => JsonSerializer.Deserialize<Notification>(v.ToString())!).ToArray();
}

/// <summary>
/// SMTP e-mail behind a Polly circuit breaker: if the mail server keeps failing,
/// the breaker opens and e-mails are skipped for 30 s instead of blocking the consumer.
/// </summary>
public sealed class EmailSender(ILogger<EmailSender> logger)
{
    private static readonly Counter Sent = Metrics.CreateCounter("notifications_sent_total", "Notifications by channel and result", "channel", "result");
    private readonly string host = Environment.GetEnvironmentVariable("SMTP_HOST") ?? "mailpit";
    private readonly int port = int.Parse(Environment.GetEnvironmentVariable("SMTP_PORT") ?? "1025");
    private readonly ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
        .AddCircuitBreaker(new CircuitBreakerStrategyOptions {
            FailureRatio = 0.5, MinimumThroughput = 2, SamplingDuration = TimeSpan.FromSeconds(30), BreakDuration = TimeSpan.FromSeconds(30),
            OnOpened = _ => { logger.LogWarning("SMTP circuit breaker OPEN - e-mails paused"); return default; },
            OnClosed = _ => { logger.LogInformation("SMTP circuit breaker CLOSED"); return default; },
        })
        .AddTimeout(TimeSpan.FromSeconds(5))
        .Build();

    public async Task<string> Send(string? to, string subject, string body)
    {
        if (string.IsNullOrWhiteSpace(to)) return "NO_ADDRESS";
        try
        {
            await pipeline.ExecuteAsync(async token => {
                using var smtp = new SmtpClient(host, port);
                using var mail = new MailMessage("no-reply@retailflow.local", to, subject, body);
                await smtp.SendMailAsync(mail, token);
            });
            Sent.WithLabels("email", "sent").Inc();
            return "SENT";
        }
        catch (BrokenCircuitException)
        {
            Sent.WithLabels("email", "circuit_open").Inc();
            return "SKIPPED_CIRCUIT_OPEN";
        }
        catch (Exception error)
        {
            logger.LogWarning("e-mail to {To} failed: {Error}", to, error.Message);
            Sent.WithLabels("email", "failed").Inc();
            return "FAILED";
        }
    }

    public void SendSms(string? phone, string text)
    {
        if (string.IsNullOrWhiteSpace(phone)) return;
        // Simulated SMS gateway: a real deployment would call a provider API here.
        logger.LogInformation("SMS to {Phone}: {Text}", phone, text);
        Sent.WithLabels("sms", "sent").Inc();
    }
}

/// <summary>Consumes the notification.events queue (bound to customer.*, order.*, invoice.*, payment.*).</summary>
public sealed class EventConsumer(NotificationStore store, EmailSender email, ILogger<EventConsumer> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var factory = new ConnectionFactory {
                    Uri = new Uri(Environment.GetEnvironmentVariable("RABBITMQ_URL")!),
                    DispatchConsumersAsync = true, AutomaticRecoveryEnabled = true,
                };
                using var connection = factory.CreateConnection("notification-service");
                using var channel = connection.CreateModel();
                channel.BasicQos(0, 10, false);
                var consumer = new AsyncEventingBasicConsumer(channel);
                consumer.Received += async (_, delivery) => {
                    try
                    {
                        await Handle(JsonNode.Parse(Encoding.UTF8.GetString(delivery.Body.Span))!);
                        channel.BasicAck(delivery.DeliveryTag, false);
                    }
                    catch (JsonException)
                    {
                        logger.LogError("unreadable message sent to dead-letter queue");
                        channel.BasicNack(delivery.DeliveryTag, false, requeue: false);
                    }
                    catch (Exception error)
                    {
                        logger.LogWarning("processing failed, message re-queued: {Error}", error.Message);
                        channel.BasicNack(delivery.DeliveryTag, false, requeue: true);
                    }
                };
                channel.BasicConsume("notification.events", autoAck: false, consumer);
                logger.LogInformation("consuming notification.events");
                await Task.Delay(Timeout.Infinite, stoppingToken);
            }
            catch (OperationCanceledException) { }
            catch (Exception error)
            {
                logger.LogWarning("waiting for RabbitMQ: {Error}", error.Message);
                await Task.Delay(3000, stoppingToken);
            }
        }
    }

    private async Task Handle(JsonNode e)
    {
        string eventId = (string)e["eventId"]!, type = (string)e["eventType"]!;
        string? correlationId = (string?)e["correlationId"];
        var p = e["payload"]!;
        using var scope = logger.BeginScope(new Dictionary<string, object?> { ["requestId"] = correlationId, ["eventType"] = type });
        if (!await store.FirstDelivery(eventId)) { logger.LogInformation("duplicate event {EventId} ignored", eventId); return; }

        string customerId = (string?)p["customerId"] ?? "unknown";
        string? to = (string?)p["customerEmail"] ?? (string?)p["email"];
        string order = ShortId((string?)p["orderId"]);
        (string subject, string message)? content = type switch {
            "customer.registered" => ("Welcome to RetailFlow", $"Hi {p["name"]}, your account is ready."),
            "order.created"       => ($"Order {order} received", $"We received your order {order} for {p["currency"]} {p["total"]}. An invoice follows shortly."),
            "invoice.created"     => ($"Invoice {p["invoiceId"]} is ready", $"Invoice {p["invoiceId"]} for {p["currency"]} {p["amount"]} is waiting for payment."),
            "payment.completed"   => ($"Payment received for order {order}", $"Thank you! We received {p["currency"]} {p["amount"]} by {p["method"]}."),
            "order.paid"          => ($"Order {order} confirmed", $"Order {order} is paid and confirmed. It will be dispatched soon."),
            _ => null,
        };
        if (content is null) return;

        var channels = new List<string> { "IN_APP" };
        var emailStatus = await email.Send(to, content.Value.subject, content.Value.message);
        if (emailStatus == "SENT") channels.Add("EMAIL");
        if (type == "customer.registered" && p["phone"] is not null) { email.SendSms((string?)p["phone"], content.Value.message); channels.Add("SMS"); }

        await store.Save(new Notification(Guid.NewGuid().ToString(), type, customerId, content.Value.subject, content.Value.message,
                                          channels.ToArray(), emailStatus, correlationId, DateTime.UtcNow));
        logger.LogInformation("notification stored for {CustomerId} via {Channels}", customerId, string.Join(",", channels));
    }

    private static string ShortId(string? id) => id is null ? "" : id.Length > 8 ? id[..8] : id;
}

/// <summary>Self-registration in Consul, refreshed every 30 s, removed on shutdown.</summary>
public sealed class ConsulRegistration(ILogger<ConsulRegistration> logger) : BackgroundService
{
    private readonly HttpClient http = new() { BaseAddress = new Uri(Environment.GetEnvironmentVariable("CONSUL_HTTP_ADDR") ?? "http://consul:8500"), Timeout = TimeSpan.FromSeconds(5) };
    private readonly string id = $"notification-service-{Environment.MachineName}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var address = Environment.GetEnvironmentVariable("POD_IP")
            ?? (await System.Net.Dns.GetHostAddressesAsync(System.Net.Dns.GetHostName())).First(a => a.AddressFamily == AddressFamily.InterNetwork).ToString();
        var body = new {
            ID = id, Name = "notification-service", Address = address, Port = 8085, Tags = new[] { "csharp" },
            Meta = new Dictionary<string, string> { ["metrics_path"] = "/metrics" },
            Check = new { HTTP = $"http://{address}:8085/health", Interval = "10s", Timeout = "3s", DeregisterCriticalServiceAfter = "1m" },
        };
        while (!stoppingToken.IsCancellationRequested)
        {
            try { (await http.PutAsJsonAsync("/v1/agent/service/register", body, stoppingToken)).EnsureSuccessStatusCode(); }
            catch (Exception error) when (error is not OperationCanceledException) { logger.LogWarning("consul unavailable: {Error}", error.Message); }
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken).ContinueWith(_ => { });
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        try { await http.PutAsync($"/v1/agent/service/deregister/{id}", null, cancellationToken); } catch { }
        await base.StopAsync(cancellationToken);
    }
}
