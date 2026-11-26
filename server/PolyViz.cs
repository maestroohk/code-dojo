using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// Visualizers for Python and TypeScript learn cards, run for real:
/// <list type="bullet">
/// <item><c>pytrace</c>: a Python program traced line by line with sys.settrace (intel/pytrace.py): every frame's names
///   and the objects they point to, so aliasing and mutation of lists and dicts are visible.</item>
/// <item><c>tstrace</c>: a TypeScript program traced with the V8 debugger from a worker thread (intel/tstrace.js): the
///   same picture for JavaScript objects, the call stack, closures and returns.</item>
/// <item><c>eventloop</c>: a TypeScript program run with timers, queueMicrotask, nextTick and V8's promise hooks
///   recorded (intel/evloop.js): the call stack, the microtask and macrotask queues and the order output appears.</item>
/// </list>
/// Each run gets a fresh temp folder and the runner's usual limits.
/// </summary>
public static class PolyViz
{
    public const int MaxSteps = 800;
    public record Request(string? Code, string? Stdin);

    static readonly Dictionary<string, string> Written = [];
    static readonly object Gate = new();

    /// <summary>The helper scripts ship inside the server assembly and are written out once per version.</summary>
    static string Script(string name)
    {
        lock (Gate)
        {
            if (Written.TryGetValue(name, out var known) && File.Exists(known)) return known;
            using var s = typeof(PolyViz).Assembly.GetManifestResourceStream(name) ?? throw new FileNotFoundException(name + " resource");
            using var reader = new StreamReader(s, Encoding.UTF8);
            var text = reader.ReadToEnd();
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..12];
            var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "intel");
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, $"{Path.GetFileNameWithoutExtension(name)}-{hash}{Path.GetExtension(name)}");
            if (!File.Exists(path))
            {
                var tmp = path + "." + Guid.NewGuid().ToString("N")[..8];
                File.WriteAllText(tmp, text, new UTF8Encoding(false));
                try { File.Move(tmp, path); } catch (IOException) { File.Delete(tmp); }
            }
            return Written[name] = path;
        }
    }

    static string Code(Request req) => (req.Code ?? "").Replace("\r\n", "\n");

    static JsonObject Fail(string code, string message) => new()
    {
        ["lines"] = new JsonArray(code.Split('\n').Select(l => (JsonNode?)l).ToArray()),
        ["steps"] = new JsonArray(), ["error"] = message, ["truncated"] = false,
    };

    static async Task<(LangRunner.Result Run, string Dir)> InFolder(string file, string code, Func<string, string[]> cmd, string? stdin)
    {
        var dir = Path.Combine(Path.GetTempPath(), "code-dojo", "viz-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(Path.Combine(dir, file), code, new UTF8Encoding(false));
        var r = await LangRunner.Exec(dir, cmd(dir), stdin, cpuMs: 10_000, wallMs: 20_000);
        return (r, dir);
    }

    static void Clean(string dir) { try { Directory.Delete(dir, true); } catch { } }

    public static async Task<JsonObject> PyTrace(LangRunner langs, Request req)
    {
        var code = Code(req);
        if (langs.Find("python") is null) return Fail(code, "Python is not installed on this machine, so this trace cannot run.");
        var script = Script("pytrace.py");
        var (r, dir) = await InFolder("main.py", code, _ => ["python", "-I", "-X", "utf8", script, "main.py"], req.Stdin);
        try
        {
            if (r.TimedOut) return Fail(code, "It ran too long and was stopped. Is a loop endless?");
            JsonObject? data;
            try { data = JsonNode.Parse(r.Stdout) as JsonObject; } catch (JsonException) { data = null; }
            if (data is null) return Fail(code, "The trace could not run: " + Checker.Tidy(r.Stderr).Split('\n').LastOrDefault());
            data["lines"] = new JsonArray(code.Split('\n').Select(l => (JsonNode?)l).ToArray());
            if (data["error"] is JsonObject e) data["error"] = $"{(string?)e["message"]}{((int?)e["line"] is > 0 and var l ? $" (line {l})" : "")}";
            return data;
        }
        finally { Clean(dir); }
    }

    public static async Task<JsonObject> TsTrace(Request req)
    {
        var code = Code(req);
        if (CodeSpaces.NodeExe() is null) return Fail(code, "Node.js is not installed on this machine, so this trace cannot run.");
        var script = Script("tstrace.js");
        var (r, dir) = await InFolder("main.ts", code, _ => ["node", "--no-warnings", script, "main.ts", "trace.jsonl"], req.Stdin);
        try
        {
            var steps = new JsonArray();
            string? error = null;
            var truncated = false;
            var file = Path.Combine(dir, "trace.jsonl");
            foreach (var line in File.Exists(file) ? await File.ReadAllLinesAsync(file) : [])
            {
                if (line.Length == 0) continue;
                JsonObject? o;
                try { o = JsonNode.Parse(line) as JsonObject; } catch (JsonException) { continue; }
                if (o is null) continue;
                if (o["error"] is JsonObject e) error ??= $"{(string?)e["message"]}{((int?)e["line"] is > 0 and var l ? $" (line {l})" : "")}";
                else if (o["stop"] is not null) truncated = true;
                else if (o["end"] is not null) steps.Add(new JsonObject { ["l"] = 0, ["ev"] = "end", ["end"] = true, ["s"] = new JsonArray(), ["h"] = new JsonObject(), ["o"] = (string?)o["o"] ?? "" });
                else steps.Add(o);
            }
            if (r.TimedOut && !truncated) error ??= "It ran too long and was stopped. Is a loop endless?";
            if (steps.Count == 0 && error is null) error = "The trace could not run: " + (Checker.Tidy(r.Stderr).Split('\n').LastOrDefault() ?? "no output");
            return new JsonObject
            {
                ["lines"] = new JsonArray(code.Split('\n').Select(l => (JsonNode?)l).ToArray()),
                ["steps"] = steps, ["truncated"] = truncated, ["error"] = error,
            };
        }
        finally { Clean(dir); }
    }

    public static async Task<JsonObject> EventLoop(Request req)
    {
        var code = Code(req);
        var lines = new JsonArray(code.Split('\n').Select(l => (JsonNode?)l).ToArray());
        if (CodeSpaces.NodeExe() is null) return new() { ["lines"] = lines, ["events"] = new JsonArray(), ["error"] = "Node.js is not installed on this machine." };
        var script = Script("evloop.js");
        var (r, dir) = await InFolder("main.ts", code, _ => ["node", "--no-warnings", script, "main.ts"], req.Stdin);
        try
        {
            var mark = r.Stdout.IndexOf("\u0002EVLOOP ", StringComparison.Ordinal);
            JsonObject? data = null;
            if (mark >= 0)
                try { data = JsonNode.Parse(r.Stdout[(mark + 8)..].Split('\n')[0]) as JsonObject; } catch (JsonException) { }
            data ??= new JsonObject { ["events"] = new JsonArray() };
            data["lines"] = lines;
            var events = data["events"] as JsonArray ?? [];
            var err = events.OfType<JsonObject>().FirstOrDefault(e => (string?)e["k"] == "error");
            data["error"] = r.TimedOut ? "It ran too long and was stopped (keep timers short: they really wait)."
                : err is not null ? $"{(string?)err["text"]}{((int?)err["line"] is > 0 and var l ? $" (line {l})" : "")}"
                : mark < 0 ? "The program could not run: " + Checker.Tidy(r.Stderr).Split('\n').LastOrDefault() : null;
            data["truncated"] = events.OfType<JsonObject>().Any(e => (string?)e["k"] == "stop");
            data["output"] = string.Concat(events.OfType<JsonObject>().Where(e => (string?)e["k"] == "log").Select(e => (string?)e["text"] + "\n"));
            return data;
        }
        finally { Clean(dir); }
    }

    public static void Map(WebApplication app, LangRunner langs, JsonSerializerOptions json)
    {
        app.MapPost("/api/viz/pytrace", async (Request req) => Results.Text((await PyTrace(langs, req)).ToJsonString(json), "application/json"));
        app.MapPost("/api/viz/tstrace", async (Request req) => Results.Text((await TsTrace(req)).ToJsonString(json), "application/json"));
        app.MapPost("/api/viz/eventloop", async (Request req) => Results.Text((await EventLoop(req)).ToJsonString(json), "application/json"));
    }

    static string Lines(JsonNode? n) => n is JsonArray a ? string.Join('\n', a.Select(l => (string?)l)) : (string?)n ?? "";

    /// <summary>`dojo validate`: run every visualizer on a learn card; (isError, message) for each problem.</summary>
    public static async Task<List<(bool Error, string Message)>> Validate(LangRunner langs, JsonObject step)
    {
        var issues = new List<(bool, string)>();
        foreach (var (key, run) in new (string, Func<Request, Task<JsonObject>>)[] { ("pytrace", r => PyTrace(langs, r)), ("tstrace", TsTrace), ("eventloop", EventLoop) })
        {
            if (step[key] is null) continue;
            if (step[key] is not JsonObject spec) { issues.Add((true, $"\"{key}\" must be an object with \"code\"")); continue; }
            var code = Lines(spec["code"]);
            if (code.Trim().Length == 0) { issues.Add((true, $"{key}: missing \"code\"")); continue; }
            var result = await run(new(code, (string?)spec["stdin"]));
            if ((string?)result["error"] is { } error && !(bool)(spec["expectError"] ?? false)) issues.Add((true, $"{key}: {error}"));
            if ((bool?)result["truncated"] == true) issues.Add((false, $"{key}: stopped at the step limit; use a smaller example"));
            if (key != "eventloop" && (result["steps"] as JsonArray)?.Count <= 1) issues.Add((true, $"{key}: the trace has no steps"));
            // "expect": the output the card promises (the event loop card is about output order).
            if (spec["expect"] is { } expect)
            {
                var printed = key == "eventloop" ? (string?)result["output"] ?? ""
                    : string.Concat((result["steps"] as JsonArray ?? []).Select(s => (string?)s?["o"] ?? ""));
                if (Checker.Tidy(printed) != Checker.Tidy(Lines(expect)))
                    issues.Add((true, $"{key}: prints [{Checker.Tidy(printed).Replace("\n", "\\n")}] but \"expect\" says [{Checker.Tidy(Lines(expect)).Replace("\n", "\\n")}]"));
            }
        }
        return issues;
    }
}
