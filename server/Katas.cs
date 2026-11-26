using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// Code katas (#/katas): short timed exercises graded by the same runners as lesson code steps.
///
///   content/katas/{id}.json = {
///     "title", "summary", "language": "csharp" | "python" | "typescript" | "sql",
///     "difficulty": "easy" | "medium" | "hard", "minutes": 5..15, "tags": [..],
///     "prompt", "starter", "solution", "hints": [..],
///     ...grading fields exactly as on a lesson code step: "template", "tests", "require", "forbid",
///     SQL: "setup", "check", "stateQuery"; Python: "pytest"
///     "wrong": [ "a plausible broken solution", ... ]    each must FAIL the hidden tests (proves they bite)
///   }
/// The learner gets the kata without its solution, template, tests and wrong answers; checks run server-side.
/// </summary>
public sealed class Katas(string root)
{
    public string Dir { get; } = Path.Combine(root, "content", "katas");

    static readonly JsonDocumentOptions DocOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
    static readonly string[] TextKeys = ["prompt", "summary", "starter", "solution", "template", "explain", "expect", "stdin", "expectContains"];
    public static readonly string[] Languages = ["csharp", "python", "typescript", "sql"];
    public static readonly string[] Difficulties = ["easy", "medium", "hard"];
    static readonly string[] Hidden = ["solution", "template", "tests", "wrong", "require", "forbid", "pytest", "stateQuery", "check", "mypy"];

    public IEnumerable<string> Ids() =>
        Directory.Exists(Dir) ? Directory.GetFiles(Dir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)!).Where(Content.SafeSegment).Order() : [];

    /// <summary>The kata as authored, with line arrays joined (the grader's view), or null.</summary>
    public JsonObject? Get(string id)
    {
        if (!Content.SafeSegment(id)) return null;
        var file = Path.Combine(Dir, id + ".json");
        if (!File.Exists(file)) return null;
        var obj = JsonNode.Parse(File.ReadAllText(file), documentOptions: DocOptions) as JsonObject ?? throw new InvalidDataException($"{id}.json is not an object");
        Normalize(obj);
        obj["id"] = id;
        obj["type"] = "code";
        return obj;
    }

    static void Normalize(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var key in o.Select(p => p.Key).ToList())
                {
                    if (TextKeys.Contains(key) && o[key] is JsonArray lines && lines.All(l => l is JsonValue v && v.TryGetValue<string>(out _)))
                        o[key] = string.Join("\n", lines.Select(l => (string)l!));
                    else if (key == "wrong" && o[key] is JsonArray wrongs)
                    {
                        // Each wrong answer may itself be an array of lines.
                        for (var i = 0; i < wrongs.Count; i++)
                            if (wrongs[i] is JsonArray wl && wl.All(l => l is JsonValue v && v.TryGetValue<string>(out _)))
                                wrongs[i] = string.Join("\n", wl.Select(l => (string)l!));
                    }
                    else Normalize(o[key]);
                }
                break;
            case JsonArray a:
                foreach (var item in a) Normalize(item);
                break;
        }
    }

    /// <summary>What the learner may see: no solution, no hidden tests.</summary>
    public static JsonObject ForLearner(JsonObject kata)
    {
        var copy = (JsonObject)kata.DeepClone();
        foreach (var k in Hidden) copy.Remove(k);
        copy["checks"] = CountChecks(kata);
        return copy;
    }

    static int CountChecks(JsonObject k) =>
        (k["tests"] as JsonArray)?.Count ?? 0;

    public static JsonObject Summary(JsonObject k) => new()
    {
        ["id"] = k["id"]?.DeepClone(),
        ["title"] = k["title"]?.DeepClone(),
        ["summary"] = k["summary"]?.DeepClone(),
        ["language"] = k["language"]?.DeepClone(),
        ["difficulty"] = k["difficulty"]?.DeepClone(),
        ["minutes"] = k["minutes"]?.DeepClone(),
        ["tags"] = k["tags"]?.DeepClone(),
    };

    public static Task<CheckResult> Grade(Checker checker, LangRunner langs, JsonObject kata, string code) =>
        Pacing.Grade(checker, langs, (string?)kata["language"] ?? "csharp", kata, code);

    public record CheckRequest(string? Code);

    public static void Map(WebApplication app, Katas katas, Checker checker, LangRunner langs, JsonSerializerOptions json)
    {
        app.MapGet("/api/katas", () =>
        {
            var list = new JsonArray();
            foreach (var id in katas.Ids())
                try { if (katas.Get(id) is { } k) list.Add(Summary(k)); } catch { /* a broken file is reported by dojo validate */ }
            return Results.Text(list.ToJsonString(json), "application/json");
        });
        app.MapGet("/api/katas/{id}", (string id) =>
            katas.Get(id) is { } k ? Results.Text(ForLearner(k).ToJsonString(json), "application/json") : Results.NotFound());
        // The reference solution, asked for on purpose (after solving it, or to give up and learn from it).
        app.MapGet("/api/katas/{id}/solution", (string id) =>
            katas.Get(id) is { } k ? Results.Json(new { solution = (string?)k["solution"] ?? "" }, json) : Results.NotFound());
        app.MapPost("/api/katas/{id}/check", async (string id, CheckRequest req) =>
        {
            if (katas.Get(id) is not { } k) return Results.NotFound();
            var language = (string?)k["language"] ?? "csharp";
            if (!Languages.Contains(language)) return Results.BadRequest("unsupported language");
            var result = await Grade(checker, langs, k, req.Code ?? "");
            return Results.Text(Pacing.WithUses(result, null, json).ToJsonString(json), "application/json");
        });
    }

    // ------------------------------------------------------------ dojo validate katas

    /// <summary>
    /// Lints every kata and proves it: the reference passes, the starter does not, every "wrong" answer fails.
    /// Returns (katas checked, code runs). Languages not installed here are skipped with a warning.
    /// </summary>
    public async Task<(int Katas, int Runs)> Validate(Checker checker, LangRunner langs, string? filter, Action<string, string> error, Action<string, string> warn)
    {
        int count = 0, runs = 0;
        var titles = new Dictionary<string, string>();
        foreach (var id in Ids())
        {
            var where = $"katas/{id}";
            if (filter is not null && !where.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            Console.WriteLine(where);
            count++;
            JsonObject? k;
            try { k = Get(id); }
            catch (Exception e) { error(where, "cannot parse: " + e.Message); continue; }
            if (k is null) { error(where, "cannot read"); continue; }

            string? S(string key) => k[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
            foreach (var key in new[] { "title", "summary", "prompt", "solution" })
                if (string.IsNullOrWhiteSpace(S(key))) error(where, $"missing \"{key}\"");
            if (S("title") is { } title && titles.TryGetValue(title, out var other)) error(where, $"same title as katas/{other}");
            else if (S("title") is { } t2) titles[t2] = id;
            var language = S("language") ?? "";
            if (!Languages.Contains(language)) { error(where, $"\"language\" must be one of {string.Join(", ", Languages)}"); continue; }
            if (!Difficulties.Contains(S("difficulty") ?? "")) error(where, "\"difficulty\" must be easy, medium or hard");
            if (k["minutes"] is not JsonValue mv || !mv.TryGetValue<int>(out var minutes) || minutes < 5 || minutes > 15)
                error(where, "\"minutes\" must be a whole number from 5 to 15");
            if (k["tags"] is not JsonArray { Count: > 0 }) warn(where, "no \"tags\"");
            if (k["starter"] is null) error(where, "missing \"starter\" (it may be a comment line, but give the signature the tests call)");
            var hasGrading = language == "sql" ? k["setup"] is not null : k["template"] is not null || k["tests"] is JsonArray { Count: > 0 } || k["pytest"] is JsonObject;
            if (!hasGrading) { error(where, language == "sql" ? "a SQL kata needs \"setup\"" : "needs hidden checks: \"template\", \"tests\" or \"pytest\""); continue; }
            if (k["wrong"] is not JsonArray { Count: > 0 }) warn(where, "no \"wrong\" answers: add a plausible broken solution, so the tests are proven to catch it");

            if (language is "python" or "typescript" && langs.Find(language) is null) { warn(where, $"{language} is not installed here, so the kata was not run"); continue; }

            async Task<CheckResult> G(string code) { runs++; return await Grade(checker, langs, k, code); }
            var good = await G(S("solution") ?? "");
            if (!good.Passed)
            {
                var why = !good.Compiled
                    ? string.Join("; ", good.Diagnostics.Where(d => d.Severity == "error").Select(d => $"line {d.Line} {d.Id} {d.Message}"))
                    : string.Join("; ", good.Tests.Where(t => !t.Pass).Select(t => $"{t.Name}: {t.Detail}")) + " " + good.Stderr;
                error(where, "reference solution does not pass -> " + why.Replace("\n", " | "));
            }
            else if (good.Tests.Count < 3 && language != "sql") warn(where, $"only {good.Tests.Count} check rows; a kata should check edge cases too");
            if ((await G(S("starter") ?? "")).Passed) error(where, "the starter code already passes");
            var n = 0;
            foreach (var w in (k["wrong"] as JsonArray ?? []).Select(x => (string?)x ?? ""))
            {
                n++;
                if ((await G(w)).Passed) error(where, $"wrong answer {n} passes the hidden tests: add a test that catches it");
            }
        }
        return (count, runs);
    }
}
