using System.Text.Json;
using System.Text.Json.Nodes;
using CodeDojo;

namespace CodeDojo.Tests;

/// <summary>Live debug sessions (CodeDebugger.Live.cs): web apps recorded per request, console programs with interactive input.</summary>
public class LiveDebuggerTests
{
    static readonly string Dotnet = new CSharpRunner().DotnetPath;
    static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    static JsonObject J(object o) => JsonSerializer.SerializeToNode(o, Web)!.AsObject();

    static List<JsonObject> Steps(JsonObject r) => r["events"]!.AsArray().OfType<JsonObject>().Where(e => e["k"] is null).ToList();
    static string FileOf(JsonObject r, JsonObject e) => (string)r["files"]![(int)e["f"]!]!;
    static JsonArray Frames(JsonObject r, JsonObject e) => r["stacks"]![(int)e["s"]!]!.AsArray();
    static JsonObject? Var(JsonObject r, JsonObject e, string name) =>
        e["v"]!.AsArray().Select(id => r["values"]![(int)id!]!.AsObject()).FirstOrDefault(v => (string?)v["n"] == name);

    const string WebProgram = """
        using Web.Services;

        var builder = WebApplication.CreateBuilder(args);
        builder.Services.AddSingleton<Greeter>();
        var app = builder.Build();

        app.MapGet("/hello/{name}", (string name, Greeter g) => g.Greet(name));
        app.MapGet("/fail", (Greeter g) =>
        {
            var reason = "testing";
            return g.Fail(reason);
        });

        app.Run();
        """;

    const string GreeterFile = """
        namespace Web.Services;

        public class Greeter
        {
            public string Greet(string name)
            {
                var text = $"Hello, {name}!";
                return text;
            }

            public string Fail(string reason)
            {
                throw new InvalidOperationException("No greeting today: " + reason);
            }
        }
        """;

    [Fact]
    public async Task A_web_app_is_recorded_per_request_across_files()
    {
        var root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "wdbg-" + Guid.NewGuid().ToString("N")[..8]);
        using var spaces = new CodeSpaces(root, Dotnet);
        try
        {
            await spaces.Create(new("web1", "empty"));
            var dir = Path.Combine(root, "web1");
            Directory.CreateDirectory(Path.Combine(dir, "Web", "Services"));
            File.WriteAllText(Path.Combine(dir, "Web", "Web.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk.Web\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>");
            File.WriteAllText(Path.Combine(dir, "Web", "Program.cs"), WebProgram);
            File.WriteAllText(Path.Combine(dir, "Web", "Services", "Greeter.cs"), GreeterFile);
            List<CodeDebugger.Breakpoint> bps = [new("Web/Services/Greeter.cs", 7)];

            var start = J(await spaces.Debug("web1", new(null, null, bps, null), Dotnet));
            Assert.True(start["error"] is null, (string?)start["error"] + start["diagnostics"]?.ToJsonString() + start["notes"]?.ToJsonString());
            var live = start["live"]!.AsObject();
            Assert.True((bool)live["web"]!);
            Assert.True((bool)live["listening"]!, (string?)live["log"]);
            // Startup is recorded on its own: the top-level statements ran, no request yet.
            Assert.Contains(Steps(start), e => FileOf(start, e) == "Web/Program.cs" && (int)e["l"]! == 3);
            Assert.Empty(live["requests"]!.AsArray());

            // Two requests through the Request panel's endpoint (it goes to the debugged app).
            var ok = J(await spaces.Send("web1", new("GET", "/hello/Ada", null, null, null)));
            Assert.Equal(200, (int)ok["status"]!);
            Assert.Equal("Hello, Ada!", (string)ok["body"]!);
            var okId = int.Parse(ok["headers"]!.AsArray().First(h => (string)h![0]! == "X-Dojo-Request")![1]!.ToString());
            var bad = J(await spaces.Send("web1", new("GET", "/fail", null, null, null)));
            Assert.Equal(500, (int)bad["status"]!);

            // The list: both requests, newest first, with status, the breakpoint hit and the failure.
            JsonArray requests = [];
            for (var i = 0; i < 40; i++)
            {
                var s = J(spaces.DebugSession("web1", new(null, null, bps)));
                requests = s["requests"]!.AsArray();
                if (requests.Count == 2 && requests.All(r => (bool)r!["done"]!)) break;
                await Task.Delay(100);
            }
            Assert.Equal(2, requests.Count);
            var okRow = requests.Single(r => (string)r!["path"]! == "/hello/Ada")!;
            var badRow = requests.Single(r => (string)r!["path"]! == "/fail")!;
            Assert.Equal(okId, (int)okRow["id"]!);
            Assert.Equal("GET", (string)okRow["method"]!);
            Assert.Equal(200, (int)okRow["status"]!);
            Assert.True((bool)okRow["hit"]!);
            Assert.False((bool)okRow["failed"]!);
            Assert.Equal(500, (int)badRow["status"]!);
            Assert.True((bool)badRow["failed"]!);
            Assert.False((bool)badRow["hit"]!);

            // The first request: the handler lambda in Program.cs, then the service method in another file.
            var r1 = J(spaces.DebugRequestRecording("web1", new(okId, null, bps)));
            Assert.True(r1["error"] is null, (string?)r1["error"]);
            var steps = Steps(r1);
            Assert.Contains(steps, e => FileOf(r1, e) == "Web/Program.cs" && (int)e["l"]! == 7);
            var greet = steps.First(e => FileOf(r1, e) == "Web/Services/Greeter.cs" && (int)e["l"]! == 7);
            Assert.Equal("\"Ada\"", (string)Var(r1, greet, "name")!["t"]!);
            var frames = Frames(r1, greet);
            Assert.Equal("Greeter.Greet", (string)frames[^1]!["m"]!);
            Assert.Contains(frames, f => ((string)f!["m"]!).StartsWith("lambda"));
            Assert.Contains(steps, e => FileOf(r1, e) == "Web/Services/Greeter.cs" && (int)e["l"]! == 8);
            Assert.DoesNotContain(steps, e => FileOf(r1, e) == "Web/Program.cs" && (int)e["l"]! == 3);   // startup is not in it
            var hits = r1["hits"]!.AsArray().Select(i => (int)i!).ToList();
            Assert.Single(hits);
            Assert.Equal(7, (int)r1["events"]![hits[0]]!["l"]!);
            Assert.Null(r1["exception"]);

            // The second request: its exception, where it was thrown, with the handler's local.
            var r2 = J(spaces.DebugRequestRecording("web1", new((int)badRow["id"]!, null, bps)));
            var x = r2["exception"]!.AsObject();
            Assert.Equal("System.InvalidOperationException", (string)x["ty"]!);
            Assert.Equal("No greeting today: testing", (string)x["msg"]!);
            Assert.Equal("Web/Services/Greeter.cs", (string)r2["files"]![(int)x["f"]!]!);
            Assert.Equal(13, (int)x["l"]!);
            Assert.Contains(Steps(r2), e => FileOf(r2, e) == "Web/Program.cs" && (int)e["l"]! == 11 && (string?)Var(r2, e, "reason")?["t"] == "\"testing\"");
            Assert.DoesNotContain(Steps(r2), e => FileOf(r2, e) == "Web/Services/Greeter.cs" && (int)e["l"]! == 7);

            // Stop ends the app.
            Assert.True((bool)J(spaces.DebugStop("web1"))["stopped"]!);
            var after = J(await spaces.Send("web1", new("GET", "/hello/Ada", null, null, null)));
            Assert.NotNull(after["error"]);
        }
        finally
        {
            spaces.Dispose();
            try { Directory.Delete(root, true); } catch { }
        }
    }

    [Fact]
    public async Task A_console_program_asks_for_input_while_it_is_recorded()
    {
        var root = Path.Combine(Path.GetTempPath(), "code-dojo-tests", "idbg-" + Guid.NewGuid().ToString("N")[..8]);
        using var spaces = new CodeSpaces(root, Dotnet);
        try
        {
            await spaces.Create(new("ask", "empty"));
            var dir = Path.Combine(root, "ask");
            File.WriteAllText(Path.Combine(dir, "Ask.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>");
            File.WriteAllText(Path.Combine(dir, "Program.cs"), """
                Console.Write("Name? ");
                var name = Console.ReadLine();
                Console.Write("Age? ");
                var age = int.Parse(Console.ReadLine()!);
                Console.WriteLine($"{name} is {age}");
                """);

            // It runs until the first ReadLine and waits there.
            var first = J(await spaces.Debug("ask", new(null, null, null, null, Interactive: true), Dotnet));
            Assert.True(first["error"] is null, (string?)first["error"] + first["diagnostics"]?.ToJsonString());
            Assert.True((bool)first["live"]!["waiting"]!);
            var waitAt = first["events"]!.AsArray().Last()!.AsObject();
            Assert.Equal("input", (string)waitAt["k"]!);
            Assert.Equal(2, (int)waitAt["l"]!);
            Assert.Equal("Name? ", (string)first["output"]!);

            // The first answer: it records on to the second question.
            var second = J(await spaces.DebugInputLine("ask", new(null, "Ada", null)));
            Assert.True((bool)second["live"]!["waiting"]!);
            Assert.Equal(4, (int)second["events"]!.AsArray().Last()!["l"]!);
            Assert.Equal("Name? Ada\nAge? ", (string)second["output"]!);
            Assert.Contains(Steps(second), e => (int)e["l"]! == 3 && (string)Var(second, e, "name")!["t"]! == "\"Ada\"");

            // The second answer: the program ends, and the whole run is one recording.
            var done = J(await spaces.DebugInputLine("ask", new(null, "36", null)));
            Assert.False((bool)done["live"]!["waiting"]!);
            Assert.False((bool)done["live"]!["alive"]!);
            Assert.Equal("Name? Ada\nAge? 36\nAda is 36\n", ((string)done["output"]!).Replace("\r\n", "\n"));
            Assert.Equal(2, done["events"]!.AsArray().Count(e => (string?)e!["k"] == "input"));
            var last = Steps(done).Last();
            Assert.Equal(5, (int)last["l"]!);
            Assert.Equal("36", (string)Var(done, last, "age")!["t"]!);
            Assert.Equal("end", (string)done["events"]!.AsArray().Last()!["k"]!);
        }
        finally
        {
            spaces.Dispose();
            try { Directory.Delete(root, true); } catch { }
        }
    }

    [Fact]
    public async Task Up_front_input_is_used_before_asking()
    {
        var (session, r) = LiveDebug.Start(Dotnet, new CodeDebugger.Input
        {
            Files = [new("Program.cs", "var a = Console.ReadLine();\nvar b = Console.ReadLine();\nConsole.WriteLine(a + b);")],
            GlobalUsings = CodeDebugger.DefaultImplicitUsings,
            Stdin = "x\n",
        });
        Assert.True(session is not null, r.Error);
        using (session)
        {
            var snap = await session.Snapshot(null);
            Assert.True(session.Waiting);
            Assert.Equal(2, (int)snap.Events.Last()!["l"]!);
            var end = await session.Input("y", null);
            Assert.Equal("xy", end.Output.Trim().Split('\n').Last());
        }
    }

    [Fact]
    public async Task Expression_lambdas_get_a_stop_but_expression_trees_do_not_break()
    {
        var r = await CodeDebugger.Run(Dotnet, new CodeDebugger.Input
        {
            Files = [new("Program.cs", """
                using System.Linq.Expressions;
                Func<int, int> twice = x => x * 2;
                Expression<Func<int, bool>> big = x => x > 10;
                Action<string> say = s => Console.WriteLine(s);
                say(twice(4).ToString());
                Console.WriteLine(big.Compile()(20));
                """)],
            GlobalUsings = CodeDebugger.DefaultImplicitUsings,
        });
        Assert.True(r.Error is null, r.Error + string.Join("\n", r.Diagnostics.Select(d => d.Message)) + string.Join("\n", r.Notes));
        Assert.Empty(r.Notes);
        var steps = r.Events.OfType<JsonObject>().Where(e => e["k"] is null).ToList();
        var inTwice = steps.Single(e => (int)e["l"]! == 2 && ((JsonArray)r.Stacks[(int)e["s"]!]!).Count == 2);
        Assert.Contains(inTwice["v"]!.AsArray(), id => (string?)r.Values[(int)id!]!["n"] == "x");
        Assert.Equal("8\nTrue", r.Output.Trim().Replace("\r", ""));
    }
}
