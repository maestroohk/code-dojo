using System.Net.Sockets;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var todos = new List<Todo> { new(1, "Write a Dockerfile", false), new(2, "Ship it", false) };

app.MapGet("/health", () => "ok");

// Readiness: can we reach the database named in ConnectionStrings:Todo?
app.MapGet("/health/ready", async (IConfiguration config) =>
{
    var cs = config.GetConnectionString("Todo");
    if (string.IsNullOrWhiteSpace(cs)) return Results.Problem("ConnectionStrings:Todo is not set", statusCode: 503);
    var parts = cs.Split(';', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Split('=', 2)).Where(p => p.Length == 2)
        .ToDictionary(p => p[0].Trim(), p => p[1].Trim(), StringComparer.OrdinalIgnoreCase);
    var host = parts.GetValueOrDefault("Host") ?? "localhost";
    var port = int.TryParse(parts.GetValueOrDefault("Port"), out var p) ? p : 5432;
    try
    {
        using var tcp = new TcpClient();
        await tcp.ConnectAsync(host, port).WaitAsync(TimeSpan.FromSeconds(2));
        return Results.Text("ready");
    }
    catch (Exception e)
    {
        return Results.Problem($"database {host}:{port} is unreachable: {e.Message}", statusCode: 503);
    }
});

app.MapGet("/todos", () => todos);
app.MapPost("/todos", (Todo input) =>
{
    var created = new Todo(todos.Count + 1, input.Title, false);
    todos.Add(created);
    return Results.Created($"/todos/{created.Id}", created);
});

app.Run();

record Todo(int Id, string Title, bool Done);
