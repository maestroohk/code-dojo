using System.Text.Json;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

public class CodeOutlineTests
{
    [Fact]
    public void Lists_services_middleware_and_endpoints_with_group_prefixes()
    {
        var items = CodeOutline.Read("""
            var builder = WebApplication.CreateBuilder(args);
            builder.Services.AddSingleton<ITaskStore, MemoryStore>();
            var app = builder.Build();
            app.Use(async (ctx, next) => await next());
            app.MapGet("/health", () => "ok");
            var tasks = app.MapGroup("/tasks");
            tasks.MapGet("/{id}", (int id, ITaskStore s) => s.Get(id));
            tasks.MapPost("/", (TaskItem t) => t);
            app.Run();
            """);
        Assert.Contains(items, i => i is { Kind: "service", Name: "AddSingleton<ITaskStore, MemoryStore>" });
        Assert.Contains(items, i => i is { Kind: "middleware", Name: "Use" });
        Assert.Contains(items, i => i is { Kind: "endpoint", Method: "GET", Route: "/health" });
        var byId = Assert.Single(items, i => i.Route == "/tasks/{id}");
        Assert.Equal("(int id, ITaskStore s) => …", byId.Detail);
        Assert.Contains(items, i => i is { Method: "POST", Route: "/tasks/" });
    }
}

/// <summary>Starts real apps, so these take a few seconds.</summary>
public sealed class AppHostTests : IDisposable
{
    readonly AppHost host = new(new CSharpRunner());
    public void Dispose() => host.Dispose();

    static JsonNode J(object o) => JsonSerializer.SerializeToNode(o, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    [Fact]
    public async Task Runs_two_apps_that_talk_and_traces_both_sides()
    {
        var started = J(await host.Start(new("inventory", """
            var app = WebApplication.CreateBuilder(args).Build();
            app.MapGet("/stock/{sku}", (string sku) => new { sku, count = 7 });
            app.Run();
            """)));
        Assert.Null((string?)started["error"]);

        var shop = J(await host.Start(new("shop", """
            var builder = WebApplication.CreateBuilder(args);
            var app = builder.Build();
            var inventory = new HttpClient { BaseAddress = new Uri(builder.Configuration["Services:inventory"]!) };
            app.MapGet("/buy/{sku}", async (string sku) =>
            {
                var stock = await inventory.GetFromJsonAsync<JsonElement>($"/stock/{sku}");
                Console.WriteLine($"checked {sku}");
                return Results.Ok(new { sku, available = stock.GetProperty("count").GetInt32() });
            });
            app.MapPost("/upload", async (HttpRequest req) =>
            {
                var form = await req.ReadFormAsync();
                var file = form.Files["doc"]!;
                return new { note = form["note"].ToString(), name = file.FileName, size = file.Length };
            }).DisableAntiforgery();
            app.Run();
            """)));
        Assert.Null((string?)shop["error"]);

        var buy = J(await host.Send("shop", new("GET", "/buy/abc", null, null)));
        Assert.Equal(200, (int)buy["status"]!);
        Assert.Contains("\"available\":7", (string)buy["body"]!);
        Assert.Equal("/buy/{sku}", (string?)buy["server"]?["route"]);

        var upload = J(await host.Send("shop", new("POST", "/upload", null,
            new("multipart", null, [new("note", "hi", null, null, null), new("doc", null, "a.txt", "text/plain", Convert.ToBase64String("hello"u8.ToArray()))]))));
        Assert.Equal(200, (int)upload["status"]!);
        Assert.Contains("\"size\":5", (string)upload["body"]!);
        Assert.Contains("-F 'doc=@a.txt'", (string)upload["curl"]!);

        var events = J(host.Events(0));
        var traces = events["traces"]!.AsArray();
        Assert.Contains(traces, t => (string?)t!["app"] == "inventory" && (string?)t["route"] == "/stock/{sku}");
        Assert.Contains(traces, t => (string?)t!["app"] == "shop" && (string?)t["kind"] == "out");
        Assert.Contains(events["logs"]!.AsArray(), l => ((string?)l!["text"])?.Contains("checked abc") == true);
    }

    [Fact]
    public async Task Compile_errors_come_back_without_starting()
    {
        var r = J(await host.Start(new("broken", "var app = ")));
        Assert.NotNull((string?)r["error"]);
        Assert.Empty(J(host.List()).AsArray());
    }
}
