// Notification Service (C# / ASP.NET Core + Redis)
// Listens to every business event and notifies the customer in-app (Redis),
// by e-mail (SMTP -> Mailpit) and by SMS (simulated gateway).
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Prometheus;
using RetailFlow.Notifications;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => { o.IncludeScopes = true; o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ "; o.UseUtcTimestamp = true; });

var redis = ConnectionMultiplexer.Connect(new ConfigurationOptions {
    EndPoints = { Environment.GetEnvironmentVariable("REDIS_HOST") ?? "notification-db:6379" },
    Password = Environment.GetEnvironmentVariable("REDIS_PASSWORD"),
    AbortOnConnectFail = false,
});
builder.Services.AddSingleton<IConnectionMultiplexer>(redis);
builder.Services.AddSingleton<NotificationStore>();
builder.Services.AddSingleton<EmailSender>();
builder.Services.AddHostedService<EventConsumer>();
builder.Services.AddHostedService<ConsulRegistration>();

// RS256 JWT validation with the public key of Customer Service.
var rsa = RSA.Create();
rsa.ImportFromPem(File.ReadAllText(Environment.GetEnvironmentVariable("JWT_PUBLIC_KEY_FILE") ?? "/run/secrets/jwt_public_key"));
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o => {
    o.MapInboundClaims = false;
    o.TokenValidationParameters = new TokenValidationParameters {
        ValidIssuer = "retailflow-customer-service", ValidateAudience = false,
        IssuerSigningKey = new RsaSecurityKey(rsa), ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
        RoleClaimType = "role", NameClaimType = "sub",
    };
});
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseHttpMetrics();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", (IConnectionMultiplexer r) => r.IsConnected
    ? Results.Ok(new { status = "UP", service = "notification-service" })
    : Results.Json(new { status = "DOWN" }, statusCode: 503));
app.MapMetrics("/metrics");

// Customers see their own notifications; ADMIN sees the latest 100 of everyone's.
app.MapGet("/notifications", async (ClaimsPrincipal user, NotificationStore store) =>
    Results.Ok(user.IsInRole("ADMIN") ? await store.Latest() : await store.ForCustomer(user.FindFirstValue("sub")!)))
   .RequireAuthorization(p => p.RequireRole("CUSTOMER", "ADMIN"));

app.Run("http://0.0.0.0:8085");
