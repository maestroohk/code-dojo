// code-dojo: a local, gamified workbench for learning to program.
//
//   dojo                 start the server and open the browser
//   dojo --no-browser    start the server only
//   dojo validate [key]  lint all content and run every reference solution
//
// Everything stays on this machine. The server listens on 127.0.0.1 only.
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodeDojo;
using Microsoft.Extensions.FileProviders;

// DOJO_PORT and DOJO_STATE let a second copy run beside the real one (used for testing).
var Port = int.TryParse(Environment.GetEnvironmentVariable("DOJO_PORT"), out var envPort) ? envPort : 8378;

var root = FindRoot();
var content = new Content(root);
var runner = new CSharpRunner();
var checker = new Checker(runner);
var stateDir = Environment.GetEnvironmentVariable("DOJO_STATE") is { Length: > 0 } envState ? envState : Path.Combine(root, ".state");
var progressFile = Path.Combine(stateDir, "progress.json");
var progressLock = new object();

if (args.Length > 0 && args[0] == "validate")
    return await Validator.Run(content, checker, runner,
        args.Skip(1).FirstOrDefault(a => !a.StartsWith("--")), args.Contains("--puzzles"));

if (args.Length > 0 && args[0] == "stress")
{
    // Diagnostic: run one tiny program many times and report slow or hung runs.
    var (p, _) = runner.Compile("var d = new Dictionary<string,int>{[\"a\"]=1}; Console.WriteLine(d[\"a\"]);");
    var n = args.Length > 1 ? int.Parse(args[1]) : 200;
    var times = new List<long>();
    for (var i = 0; i < n; i++)
    {
        var r = await runner.RunDiagnostic(p!);
        times.Add(r.Ms);
        if (r.Ms > 1500) Console.WriteLine($"run {i}: {r.Ms} ms timedOut={r.TimedOut} cpu={r.Cpu.TotalMilliseconds:F0} ms exited={r.Exited} threads={r.Threads} out=[{r.Stdout.Trim()}]");
    }
    times.Sort();
    Console.WriteLine($"{n} runs: median {times[n / 2]} ms, p95 {times[(int)(n * 0.95)]} ms, max {times[^1]} ms");
    return 0;
}

var builder = WebApplication.CreateSlimBuilder();
builder.WebHost.UseUrls($"http://127.0.0.1:{Port}");
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var app = builder.Build();

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
string[] allowedHosts = [$"127.0.0.1:{Port}", $"localhost:{Port}"];

// This server runs code. Refuse anything that is not our own page talking to us:
// a wrong Host header means DNS rebinding, a foreign Origin means another site's script.
app.Use(async (ctx, next) =>
{
    var origin = ctx.Request.Headers.Origin.ToString();
    var originOk = origin.Length == 0 || allowedHosts.Any(h => origin == "http://" + h);
    if (!allowedHosts.Contains(ctx.Request.Host.Value) || !originOk)
    {
        ctx.Response.StatusCode = 403;
        return;
    }
    if (HttpMethods.IsPost(ctx.Request.Method) || HttpMethods.IsPut(ctx.Request.Method))
    {
        if (ctx.Request.ContentType?.StartsWith("application/json") != true || ctx.Request.ContentLength > 2_000_000)
        {
            ctx.Response.StatusCode = 415;
            return;
        }
    }
    ctx.Response.Headers.CacheControl = "no-store";
    await next();
});

var ui = new PhysicalFileProvider(Path.Combine(root, "ui"));
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = ui });
app.UseStaticFiles(new StaticFileOptions { FileProvider = ui });

app.MapGet("/api/tracks", () => Results.Text(content.Tracks().ToJsonString(), "application/json"));

app.MapGet("/api/lesson/{track}/{module}/{lesson}", (string track, string module, string lesson) =>
    content.Lesson(track, module, lesson) is { } l
        ? Results.Text(l.ToJsonString(), "application/json")
        : Results.NotFound());

app.MapGet("/api/progress", () =>
{
    lock (progressLock)
        return Results.Text(File.Exists(progressFile) ? File.ReadAllText(progressFile) : "{}", "application/json");
});

app.MapPut("/api/progress", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);   // reject anything that is not JSON
    var text = JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
    lock (progressLock)
    {
        Directory.CreateDirectory(stateDir);
        var tmp = progressFile + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, progressFile, overwrite: true);
    }
    return Results.NoContent();
});

// Free run: compile and execute whatever is in the editor, no grading.
app.MapPost("/api/run", async (RunRequest req) =>
{
    if (content.Language(req.Track ?? "csharp") != "csharp") return Results.BadRequest("unsupported language");
    var (program, diags) = runner.Compile(req.Code ?? "", req.Template, req.Framework == "web");
    if (program is null) return Results.Json(new { compiled = false, diagnostics = diags }, json);
    using (program)
    {
        var run = await runner.Run(program, req.Stdin);
        return Results.Json(new
        {
            compiled = true, diagnostics = diags, run.Stdout, run.Stderr, run.ExitCode, run.TimedOut, run.Truncated, run.Ms,
        }, json);
    }
});

// Graded run of one code step. The step is looked up server-side so tests cannot be bypassed by accident.
app.MapPost("/api/check", async (CheckRequest req) =>
{
    if (content.Language(req.Track) != "csharp") return Results.BadRequest("unsupported language");
    var lesson = content.Lesson(req.Track, req.Module, req.Lesson);
    if ((lesson?["steps"] as JsonArray)?.ElementAtOrDefault(req.Step) is not JsonObject step || (string?)step["type"] != "code")
        return Results.NotFound();
    return Results.Json(await checker.Check(step, req.Code ?? ""), json);
});

app.Lifetime.ApplicationStarted.Register(() =>
{
    var url = $"http://localhost:{Port}";
    Console.WriteLine($"code-dojo is running at {url}   (Ctrl+C to stop)");
    if (!args.Contains("--no-browser"))
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    // Warm Roslyn up so the learner's first Run is not the slow one.
    Task.Run(() => { var (p, _) = runner.Compile("Console.WriteLine(1);"); p?.Dispose(); });
});

await app.RunAsync();
return 0;

static string FindRoot()
{
    foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "tracks")) && Directory.Exists(Path.Combine(dir.FullName, "ui")))
                return dir.FullName;
    throw new DirectoryNotFoundException("Cannot find the code-dojo folder (the one holding tracks/ and ui/).");
}

record RunRequest(string? Track, string? Code, string? Stdin, string? Template, string? Framework);
record CheckRequest(string Track, string Module, string Lesson, int Step, string? Code);
