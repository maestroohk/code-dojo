// The shop's two services in one project: APP_ROLE=shop (the storefront API) or APP_ROLE=inventory (stock and
// reservations). Both are instrumented with the OpenTelemetry .NET SDK and export traces, metrics and logs over
// OTLP to the Collector. Every OTEL_* setting comes from the environment (/work/config/<role>.env).
//
// Edit this file on the shop node (/app/src/Program.cs). Saving it rebuilds and restarts the shop within
// a few seconds; the build output is in /work/logs/shop-build.log.
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Npgsql;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var role = Environment.GetEnvironmentVariable("APP_ROLE") ?? "shop";
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });

var db = new NpgsqlDataSourceBuilder(builder.Configuration["DB"] ?? "Host=postgres;Username=shop;Password=shop;Database=shop;Maximum Pool Size=20").Build();
builder.Services.AddSingleton(db);
builder.Services.AddHttpClient("inventory", c =>
{
    c.BaseAddress = new Uri(builder.Configuration["INVENTORY_URL"] ?? "http://inventory:8080");
    c.Timeout = TimeSpan.FromSeconds(5);
});

// One SDK setup for all three signals. The exporter, the sampler and extra resource attributes are read
// from the standard OTEL_* environment variables, so operations can change them without a rebuild.
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService(serviceName: role, serviceVersion: "1.4.2"))
    .WithTracing(t => t
        .AddSource(Telemetry.Source.Name)
        .AddAspNetCoreInstrumentation(o => o.Filter = ctx => ctx.Request.Path != "/healthz")
        .AddHttpClientInstrumentation()
        .AddNpgsql()
        .AddOtlpExporter())
    .WithMetrics(m => m
        .AddMeter(Telemetry.Meter.Name)
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter())
    .WithLogging(l => l.AddOtlpExporter());

var app = builder.Build();
app.MapGet("/healthz", () => "ok");

if (role == "inventory") Inventory.Map(app);
else Shop.Map(app);

app.Run();

static class Telemetry
{
    public static readonly ActivitySource Source = new("Shop.App");
    public static readonly Meter Meter = new("Shop.App");

    // Orders placed, by payment method and outcome.
    public static readonly Counter<long> Orders = Meter.CreateCounter<long>("app.orders", unit: "{order}", description: "Checkouts, by payment method and outcome");
}

record CartLine(int Sku, int Qty);
record Cart(int Customer, string Payment, List<CartLine> Items);

static class Shop
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/products", async (NpgsqlDataSource db) =>
        {
            await using var cmd = db.CreateCommand("SELECT id, name, price_cents FROM products ORDER BY id LIMIT 20");
            await using var r = await cmd.ExecuteReaderAsync();
            var list = new List<object>();
            while (await r.ReadAsync()) list.Add(new { id = r.GetInt32(0), name = r.GetString(1), price = r.GetInt32(2) / 100.0 });
            return Results.Ok(list);
        });

        app.MapGet("/api/products/{id:int}", async (int id, NpgsqlDataSource db, IHttpClientFactory http) =>
        {
            var stock = await http.CreateClient("inventory").GetFromJsonAsync<Stock>($"/stock/{id}");
            await using var cmd = db.CreateCommand("SELECT rating, body FROM reviews WHERE product_id = $1 ORDER BY created DESC LIMIT 5");
            cmd.Parameters.AddWithValue(id);
            await using var r = await cmd.ExecuteReaderAsync();
            var reviews = new List<object>();
            while (await r.ReadAsync()) reviews.Add(new { rating = r.GetInt16(0), body = r.GetString(1) });
            return Results.Ok(new { id, inStock = stock?.Qty ?? 0, reviews });
        });

        app.MapPost("/api/checkout", async (Cart cart, IHttpClientFactory http, ILogger<Cart> log) =>
        {
            using var activity = Telemetry.Source.StartActivity("checkout");
            activity?.SetTag("app.payment.method", cart.Payment);
            activity?.SetTag("user.email", $"customer{cart.Customer}@example.com");
            var client = http.CreateClient("inventory");
            foreach (var line in cart.Items)
            {
                var res = await client.PostAsJsonAsync("/reservations", line);
                if (!res.IsSuccessStatusCode)
                {
                    var problem = await res.Content.ReadFromJsonAsync<Problem>();
                    log.LogError("Reservation failed for sku {Sku}: {Reason} (code {Code})", line.Sku, problem?.Reason, problem?.Code);
                    activity?.SetStatus(ActivityStatusCode.Error, "reservation failed");
                    Telemetry.Orders.Add(1, new("app.payment.method", cart.Payment), new("app.order.status", "failed"),
                        new("app.customer.id", cart.Customer));
                    return Results.Problem("Could not reserve stock", statusCode: 502);
                }
            }
            Telemetry.Orders.Add(1, new("app.payment.method", cart.Payment), new("app.order.status", "placed"),
                new("app.customer.id", cart.Customer));
            log.LogInformation("Order placed for customer {Customer} with {Lines} lines", cart.Customer, cart.Items.Count);
            return Results.Ok(new { status = "placed" });
        });
    }

    record Stock(int Sku, int Qty);
    record Problem(string Reason, string Code);
}

static class Inventory
{
    public static void Map(WebApplication app)
    {
        var code = "INV-" + (Environment.GetEnvironmentVariable("ERRCODE") ?? "4711");
        app.MapGet("/stock/{sku:int}", async (int sku, NpgsqlDataSource db) =>
        {
            await using var cmd = db.CreateCommand("SELECT qty FROM stock WHERE product_id = $1");
            cmd.Parameters.AddWithValue(sku);
            var qty = await cmd.ExecuteScalarAsync() as int? ?? 0;
            return Results.Ok(new { sku, qty });
        });

        app.MapPost("/reservations", async (CartLine line, NpgsqlDataSource db, ILogger<CartLine> log) =>
        {
            // About one reservation in twelve hits a stock conflict: another warehouse took the last units.
            if (Random.Shared.Next(12) == 0)
            {
                log.LogWarning("Stock conflict on sku {Sku}", line.Sku);
                return Results.Json(new { reason = "stock conflict in warehouse eu-2", code }, statusCode: 409);
            }
            await using var cmd = db.CreateCommand("UPDATE stock SET qty = qty - $1 WHERE product_id = $2 AND qty >= $1");
            cmd.Parameters.AddWithValue(line.Qty);
            cmd.Parameters.AddWithValue(line.Sku);
            await cmd.ExecuteNonQueryAsync();
            return Results.Ok(new { reserved = line.Qty });
        });
    }
}
