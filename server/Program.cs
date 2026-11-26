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
using var apps = new AppHost(runner);
var langs = new LangRunner();
var stateDir = Environment.GetEnvironmentVariable("DOJO_STATE") is { Length: > 0 } envState ? envState : Path.Combine(root, ".state");

if (args.Length > 0 && args[0] == "validate")
    return await Validator.Run(content, checker, runner, langs,
        args.Skip(1).FirstOrDefault(a => !a.StartsWith("--")), args.Contains("--puzzles"),
        // Terminal steps start real containers; CI machines without Docker skip them (a warning, not an error).
        noDocker: args.Contains("--no-docker") || Environment.GetEnvironmentVariable("DOJO_NO_DOCKER") is "1" or "true");

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
        if (ctx.Request.ContentType?.StartsWith("application/json") != true || ctx.Request.ContentLength > (ctx.Request.Path.StartsWithSegments("/api/sync") ? 25_000_000 : 2_000_000))
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

// ?dream= serves each step's variant for the learner's chosen dream (see Builds.cs, "dreams").
app.MapGet("/api/lesson/{track}/{module}/{lesson}", (string track, string module, string lesson, string? dream) =>
    content.Lesson(track, module, lesson, dream) is { } l
        ? Results.Text(Pacing.ForLearner(l).ToJsonString(), "application/json")   // cold steps lose starter, hints and solution
        : Results.NotFound());

// Progress, the welcome profile, export / import and the sync folder (ProgressSync.cs, merge rules in ProgressMerge.cs).
// Mapped below, once the live labs (whose task progress travels with it) exist.

// Free run: compile and execute whatever is in the editor, no grading.
// Languages the playground can run here: C# always, others when their toolchain is installed.
app.MapGet("/api/languages", () => Results.Json(
    new[] { new { id = "csharp", name = "C#", sample = (string?)null } }
        .Concat(langs.Available.Select(l => new { id = l.Id, name = l.Name, sample = (string?)l.Sample })), json));

app.MapPost("/api/run", async (RunRequest req) =>
{
    var runLanguage = req.Language is { Length: > 0 } l ? l : content.Language(req.Track ?? "csharp");
    if (runLanguage == "sql") return Results.Json(SqlChecker.Run(SqlChecker.Text(req.Setup), req.Code ?? ""), json);
    if (runLanguage is { Length: > 0 } other && other != "csharp")
    {
        if (langs.Find(other) is not { } lang) return Results.BadRequest($"{other} is not installed on this machine");
        var r = await langs.Run(lang, req.Code ?? "", req.Stdin);
        if (!r.Compiled)
            return Results.Json(new { compiled = false, diagnostics = new[] { new Diag("error", lang.Name, r.CompileOutput, 0, 0, "") } }, json);
        // TypeScript: Node runs it without checking types, so tsc's errors are shown beside the output as warnings (TsCheck.cs).
        var typeNotes = other == "typescript" && await TsCheck.Check(req.Code ?? "", 1, int.MaxValue, null, TimeSpan.Zero) is { } td
            ? td.Select(d => d with { Severity = "warning" }).ToArray() : [];
        return Results.Json(new { compiled = true, diagnostics = typeNotes, r.Stdout, r.Stderr, r.ExitCode, r.TimedOut, r.Truncated, r.Ms, r.Images }, json);
    }
    if (content.Language(req.Track ?? "csharp") != "csharp") return Results.BadRequest("unsupported language");
    var (runWeb, runEf) = CSharpRunner.Frameworks(req.Framework ?? content.Framework(req.Track ?? "csharp"));
    // A free run (Try it, the Run button) also sees the namespaces samples use most, so a sample that leaves out its
    // using lines still runs. Graded checks never get these.
    var playground = req.Template is null ? CSharpRunner.PlaygroundUsings : null;
    var (program, diags) = runner.Compile(req.Code ?? "", req.Template, runWeb, efCore: runEf, extra: playground);
    // A sample that only declares types (a class, a record, an interface) has no entry point (CS5001). It still
    // compiles, and that is worth knowing: say so instead of showing a confusing error.
    if (program is null && req.Template is null && diags.Count(d => d.Severity == "error") == 1 && diags.Any(d => d.Id == "CS5001"))
    {
        var code = req.Code ?? "";
        var lines = code.Replace("\r\n", "\n").Split('\n');
        var head = lines.TakeWhile(l => l.TrimStart().StartsWith("using ") || l.Trim().Length == 0 || l.TrimStart().StartsWith("//")).Count();
        var wrapped = string.Join("\n", lines.Take(head)) + "\nSystem.Console.WriteLine(\"It compiles. This sample only declares types: add lines at the top that use them, then Run again.\");\n" + string.Join("\n", lines.Skip(head));
        var (typesOnly, typeDiags) = runner.Compile(wrapped, null, runWeb, efCore: runEf, extra: playground);
        if (typesOnly is not null) (program, diags) = (typesOnly, typeDiags.Where(d => d.Severity != "error").ToList());
    }
    // A sample that declares a type and then uses it (CS8803): C# wants the statements first. Free runs move the
    // statements above the types, which is what the learner would do in a real file.
    if (program is null && req.Template is null && diags.Any(d => d.Id == "CS8803") && CSharpRunner.StatementsFirst(req.Code ?? "") is { } reordered)
    {
        var (moved, movedDiags) = runner.Compile(reordered, null, runWeb, efCore: runEf, extra: playground);
        if (moved is not null) (program, diags) = (moved, movedDiags.Where(d => d.Severity != "error").ToList());
    }
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
    var language = content.Language(req.Track);
    if (language != "csharp" && !PolyChecker.Handles(language) && !SqlChecker.Handles(language)) return Results.BadRequest("unsupported language");
    var lesson = content.Lesson(req.Track, req.Module, req.Lesson, req.Dream);
    if ((lesson?["steps"] as JsonArray)?.ElementAtOrDefault(req.Step) is not JsonObject step || (string?)step["type"] != "code")
        return Results.NotFound();
    // "uses": the learner's own earlier pieces (or the reference ones they have not earned) are compiled with the step (Pacing.cs).
    var uses = Pacing.UsesOf(step).Count > 0
        ? Pacing.Resolve(content, content.Tracks(), req.Track, $"{req.Track}/{req.Module}/{req.Lesson}", req.Step, step, req.Dream, req.Uses)
        : null;
    var result = await Pacing.Grade(checker, langs, language, step, req.Code ?? "", uses?.Files);
    return Results.Text(Pacing.WithUses(result, uses, json).ToJsonString(json), "application/json");
});

// Certificate lab: build a small PKI from a description and validate a chain with the real X509Chain.
app.MapPost("/api/pki", (PkiLab.Request req) => Results.Json(PkiLab.Run(req), json));

// LINQ in motion: run a query with every stage tapped, return the order items flowed through it.
app.MapPost("/api/linqviz", async (LinqViz.Request req) => Results.Json(await LinqViz.Run(runner, req), json));
SqlViz.Map(app, json);  // SQL visuals: rows through a query, EXPLAIN QUERY PLAN before/after (SqlViz.cs)

// Regular expressions: the regex lab and graded "regex" steps, run by System.Text.RegularExpressions with a match timeout.
RegexLab.Map(app, content);

// Code intelligence for the editors: type-aware completion, go to definition, references, hover.
app.MapPost("/api/intel", async (CodeIntel.Request req) => Results.Json(await CodeIntel.RunAny(runner, req), json));

// Code in motion: run a program with every statement traced (line, variables, call stack, output).
app.MapPost("/api/trace", async (CodeTrace.Request req) => Results.Json(await CodeTrace.Run(runner, req), json));
// The same for Python and TypeScript (names, objects and references), and the TypeScript event loop (PolyViz.cs).
PolyViz.Map(app, langs, json);

// Workbench: run learner web apps live, send them requests, and watch the traffic between them.
app.MapGet("/api/apps", () => Results.Json(apps.List(), json));
app.MapGet("/api/apps/events", (long? since) => Results.Json(apps.Events(since ?? 0), json));
app.MapPost("/api/apps/start", async (AppHost.StartRequest req) => Results.Json(await apps.Start(req), json));
app.MapPost("/api/apps/{id}/stop", (string id) => Results.Json(new { stopped = apps.Stop(id) }, json));
app.MapPost("/api/apps/{id}/send", async (string id, AppHost.SendRequest req) => Results.Json(await apps.Send(id, req), json));
app.MapPost("/api/outline", (RunRequest req) => Results.Json(CodeOutline.Read(req.Code ?? ""), json));
// Live network labs: Docker-based networking and security labs with an in-page terminal (NetLabs.cs).
var netlabs = NetLabs.Map(app, root, stateDir);
ProgressSync.Map(app, stateDir, netlabs);
// Learning paths: role routes across topics, stored as content/paths/*.json (Paths.cs).
Paths.Map(app, root, netlabs);
// Terminal steps: a real shell in a throwaway container per lesson step, checked by real commands (TermSteps.cs).
TermSteps.Map(app, content, root, Port);
PyEnv.Map(app);  // one-click data science environment (numpy, pandas, matplotlib)
// Code spaces: real multi-file .NET projects with NuGet packages, built and run with the dotnet CLI (CodeSpaces.cs).
CodeSpaces.Map(app, runner);
// Your builds: the real artifact each topic assembles from the learner's passing code (Builds.cs).
Builds.Map(app, content, CodeSpaces.DefaultRoot());
// Database studio: SQLite files plus PostgreSQL / SQL Server / MySQL in Docker, one query UI (DbStudio.cs).
DbStudio.Map(app, stateDir);
app.Lifetime.ApplicationStopping.Register(apps.Dispose);

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
    // The current folder wins when it is a code-dojo folder itself, so a build placed elsewhere (tests, another
    // checkout's artifacts) validates and serves the content you are standing in.
    var here = Directory.GetCurrentDirectory();
    if (Directory.Exists(Path.Combine(here, "tracks")) && Directory.Exists(Path.Combine(here, "ui"))) return here;
    foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            if (Directory.Exists(Path.Combine(dir.FullName, "tracks")) && Directory.Exists(Path.Combine(dir.FullName, "ui")))
                return dir.FullName;
    throw new DirectoryNotFoundException("Cannot find the code-dojo folder (the one holding tracks/ and ui/).");
}

record RunRequest(string? Track, string? Code, string? Stdin, string? Template, string? Framework, string? Language = null, System.Text.Json.Nodes.JsonNode? Setup = null);
record CheckRequest(string Track, string Module, string Lesson, int Step, string? Code, string? Dream = null,
    Dictionary<string, Pacing.UsesInput>? Uses = null);
