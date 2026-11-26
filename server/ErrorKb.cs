using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// "Explain this error": a curated knowledge base of compiler and runtime errors (content/errors/*.json), matched to
/// what a run or check actually produced and to the learner's own line and identifiers. Works fully offline.
///
///   content/errors/{file}.json   { "entries": [ entry, ... ] }
///   entry = { "id", "language": "csharp" | "python" | "typescript" | "sql",
///             "code": "CS0165" | ["CS4032", "CS4033"],    compiler code (C# CS..., TypeScript TS...), or
///             "exception": "KeyNotFoundException",         runtime exception / error type (short name), and/or
///             "message": "regex on the error message",     narrows an exception, or matches on its own (SQLite)
///             "title", "explain", "causes": [..], "fix": [..], "before", "after",
///             "specific": "`{name}` is used before it is assigned{onLine}.",   {group} from "message"/"capture" groups
///             "capture": "regex with named groups run on the message (when \"message\" is not the one)",
///             "hunt": { "pattern": "regex over the code", "note": "Line {line} calls `{match}`..." } }
///   For errors without a line (a check that caught the exception), "hunt" points at the likely line.
/// </summary>
public sealed partial class ErrorKb(string dir)
{
    public string Dir { get; } = dir;

    public sealed record Entry(string Id, string File, string Language, string[] Codes, string? Exception, Regex? Message, Regex? Capture,
        Regex? Hunt, string? HuntNote, string Title, string Explain, string[] Causes, string[] Fix, string? Before, string? After, string? Specific);

    /// <summary>One error found in a result: a compiler diagnostic, an exception in stderr, or a crash in a check.</summary>
    public sealed record Problem(string Kind, string? Code, string? Exception, string Message, int Line);

    public sealed record ExplainRequest(string? Language, string? Code, List<Diag>? Diagnostics, string? Stderr, List<TestResult>? Tests);

    List<Entry>? cache;
    DateTime stamp;
    readonly object gate = new();

    static readonly JsonDocumentOptions DocOptions = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    /// <summary>Every entry (re-read when a file changes) and the problems found while reading them.</summary>
    public (List<Entry> Entries, List<string> Problems) Load()
    {
        var problems = new List<string>();
        var list = new List<Entry>();
        if (!Directory.Exists(Dir)) return (list, ["content/errors does not exist"]);
        foreach (var file in Directory.GetFiles(Dir, "*.json").Order())
        {
            var name = Path.GetFileName(file);
            JsonObject? root;
            try { root = JsonNode.Parse(File.ReadAllText(file), documentOptions: DocOptions) as JsonObject; }
            catch (Exception e) { problems.Add($"{name}: cannot parse: {e.Message}"); continue; }
            if (root?["entries"] is not JsonArray entries) { problems.Add($"{name}: needs \"entries\": [ ... ]"); continue; }
            var i = 0;
            foreach (var node in entries)
            {
                i++;
                var where = $"{name} entry {i}";
                if (node is not JsonObject o) { problems.Add($"{where}: not an object"); continue; }
                try { list.Add(Parse(o, name, where, problems)); }
                catch (Exception e) { problems.Add($"{where}: {e.Message}"); }
            }
        }
        foreach (var dup in list.GroupBy(e => e.Id).Where(g => g.Count() > 1)) problems.Add($"id \"{dup.Key}\" is used {dup.Count()} times");
        return (list, problems);
    }

    List<Entry> Entries()
    {
        lock (gate)
        {
            var latest = Directory.Exists(Dir) ? Directory.GetFiles(Dir, "*.json").Select(File.GetLastWriteTimeUtc).DefaultIfEmpty().Max() : default;
            if (cache is null || latest != stamp) { cache = Load().Entries; stamp = latest; }
            return cache;
        }
    }

    static string Text(JsonNode? n) => n switch
    {
        JsonArray a => string.Join("\n", a.Select(x => (string?)x ?? "")),
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        _ => "",
    };

    static string[] Lines(JsonNode? n) => n switch
    {
        JsonArray a => a.Select(x => (string?)x ?? "").Where(s => s.Length > 0).ToArray(),
        JsonValue v when v.TryGetValue<string>(out var s) && s.Length > 0 => [s],
        _ => [],
    };

    static readonly string[] Languages = ["csharp", "python", "typescript", "sql"];

    static Entry Parse(JsonObject o, string file, string where, List<string> problems)
    {
        var id = Text(o["id"]);
        var language = Text(o["language"]);
        if (id.Length == 0) throw new("missing \"id\"");
        where = $"{file} {id}";
        if (!Languages.Contains(language)) throw new($"\"language\" must be one of {string.Join(", ", Languages)}");
        Regex? Rx(string key)
        {
            var src = Text(o[key] is JsonObject h ? h["pattern"] : o[key]);
            if (src.Length == 0) return null;
            try { return new Regex(src, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200)); }
            catch (ArgumentException e) { throw new($"\"{key}\" is not a valid regex: {e.Message}"); }
        }
        var codes = Lines(o["code"]).Select(c => c.ToUpperInvariant()).ToArray();
        var exception = Text(o["exception"]) is { Length: > 0 } ex ? ex : null;
        var message = Rx("message");
        if (codes.Length == 0 && exception is null && message is null) throw new("needs \"code\", \"exception\" or \"message\" to match on");
        var entry = new Entry(id, file, language, codes, exception, message, Rx("capture"), Rx("hunt"),
            o["hunt"] is JsonObject hunt ? Text(hunt["note"]) : null,
            Text(o["title"]), Text(o["explain"]), Lines(o["causes"]), Lines(o["fix"]),
            Text(o["before"]) is { Length: > 0 } b ? b : null, Text(o["after"]) is { Length: > 0 } a ? a : null,
            Text(o["specific"]) is { Length: > 0 } sp ? sp : null);
        if (entry.Title.Length == 0) problems.Add($"{where}: missing \"title\"");
        if (entry.Explain.Length < 40) problems.Add($"{where}: \"explain\" should be a real explanation (40+ characters)");
        if (entry.Causes.Length == 0) problems.Add($"{where}: needs at least one entry in \"causes\"");
        if (entry.Fix.Length == 0) problems.Add($"{where}: needs at least one entry in \"fix\"");
        if (entry.Before is null || entry.After is null) problems.Add($"{where}: needs a \"before\" and \"after\" example");
        else if (entry.Before.Trim() == entry.After.Trim()) problems.Add($"{where}: \"before\" and \"after\" are the same");
        // Placeholders in "specific" must be groups of "message" / "capture" (or the built-in ones).
        foreach (Match m in Placeholder().Matches(entry.Specific ?? ""))
        {
            var g = m.Groups[1].Value;
            if (g is "line" or "onLine") continue;
            if (!(message?.GetGroupNames().Contains(g) ?? false) && !(entry.Capture?.GetGroupNames().Contains(g) ?? false))
                problems.Add($"{where}: \"specific\" uses {{{g}}}, which no named group in \"message\" or \"capture\" provides");
        }
        if (entry.Hunt is not null && string.IsNullOrEmpty(entry.HuntNote)) problems.Add($"{where}: \"hunt\" needs a \"note\"");
        return entry;
    }

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();

    // ------------------------------------------------------------ finding the problems in a result

    [GeneratedRegex(@"(?m)^(?:Unhandled exception\.\s*)?(?:[A-Za-z_]\w*\.)*(?<short>[A-Za-z_]\w*Exception)(?:\s*\(0x[0-9A-Fa-f]+\))?(?::\s*(?<msg>[^\r\n]*))?\s*$")]
    private static partial Regex DotNetException();
    [GeneratedRegex(@"--->\s*(?:[A-Za-z_]\w*\.)*(?<short>[A-Za-z_]\w*Exception)(?:\s*\(0x[0-9A-Fa-f]+\))?:\s*(?<msg>[^\r\n]*)")]
    private static partial Regex InnerException();
    [GeneratedRegex(@"Program\.cs:line (\d+)")]
    private static partial Regex DotNetLine();
    [GeneratedRegex(@"(?m)^(?:[A-Za-z_]\w*\.)*(?<short>[A-Za-z_]\w*(?:Error|Exception|Exit|Interrupt|StopIteration|Warning))(?::\s*(?<msg>[^\r\n]*))?\s*$")]
    private static partial Regex PythonException();
    [GeneratedRegex(@"File ""[^""]+"", line (\d+)")]
    private static partial Regex PythonLine();
    [GeneratedRegex(@"(?m)^(?:Uncaught\s+)?(?<short>[A-Z]\w*Error)(?::\s*(?<msg>[^\r\n]*))?\s*$")]
    private static partial Regex JsException();
    [GeneratedRegex(@"main\.[jt]s:(\d+)")]
    private static partial Regex JsLine();
    [GeneratedRegex(@"\b(?<short>[A-Z]\w*(?:Exception|Error))\b(?::\s*(?<msg>[^\r\n]*))?")]
    private static partial Regex AnyException();
    [GeneratedRegex(@"^Line \d+:\s*")]
    private static partial Regex SqlLinePrefix();
    [GeneratedRegex(@"^(CS|TS)\d{4,5}$")]
    private static partial Regex CompilerCode();

    /// <summary>The errors in a run or check result, most useful first (at most four).</summary>
    public static List<Problem> Extract(ExplainRequest req)
    {
        var language = Normal(req.Language);
        var codeLines = (req.Code ?? "").Replace("\r\n", "\n").Split('\n').Length;
        int InCode(int line) => line >= 1 && line <= codeLines ? line : 0;
        var list = new List<Problem>();
        void Add(Problem p)
        {
            if (list.Any(x => x.Code == p.Code && x.Exception == p.Exception && x.Message == p.Message)) return;
            list.Add(p);
        }

        var diags = req.Diagnostics ?? [];
        foreach (var d in diags.Where(d => d.Severity == "error"))
        {
            if (d.File == "tests") continue;   // the harness could not use the code: names and signatures, not an error to explain
            var code = CompilerCode().IsMatch(d.Id ?? "") ? d.Id!.ToUpperInvariant() : null;
            // Python syntax errors and Node's compile output arrive as one message holding a traceback.
            if (code is null && language is "python" or "typescript" && FromTrace(d.Message ?? "", language, InCode) is { Count: > 0 } traced)
            {
                foreach (var p in traced) Add(p with { Kind = "compile", Line = p.Line > 0 ? p.Line : InCode(d.Line) });
                continue;
            }
            // SQLite messages arrive as "Line 3: no such column: x".
            var message = (d.Message ?? "").Trim();
            if (language == "sql") message = SqlLinePrefix().Replace(message, "");
            Add(new(language == "sql" ? "sql" : "compile", code, null, message, InCode(d.Line)));
        }
        // Nullable warnings in C#, and tsc's errors on a free run (shown as warnings there), have their own entries.
        if (language is "csharp" or "typescript" && list.Count == 0)
            foreach (var d in diags.Where(d => d.Severity == "warning" && CompilerCode().IsMatch(d.Id ?? "")).Take(3))
                Add(new("warning", d.Id!.ToUpperInvariant(), null, d.Message ?? "", InCode(d.Line)));

        if (!string.IsNullOrWhiteSpace(req.Stderr))
            foreach (var p in FromTrace(req.Stderr!, language, InCode)) Add(p);

        foreach (var t in (req.Tests ?? []).Where(t => !t.Pass && !string.IsNullOrEmpty(t.Detail)))
        {
            // "expected KeyError but got ..." is a test about exceptions, not a crash.
            if (t.Detail.StartsWith("expected ", StringComparison.Ordinal)) continue;
            var fromTrace = FromTrace(t.Detail, language, InCode);
            if (fromTrace.Count > 0) { foreach (var p in fromTrace) Add(p); continue; }
            if (AnyException().Match(t.Detail) is { Success: true } m)
                Add(new("runtime", null, m.Groups["short"].Value, m.Groups["msg"].Value.Trim(), 0));
        }
        return list.Take(4).ToList();
    }

    static List<Problem> FromTrace(string text, string language, Func<int, int> inCode)
    {
        var list = new List<Problem>();
        text = text.Replace("\r\n", "\n");
        switch (language)
        {
            case "csharp":
            {
                if (text.Contains("Stack overflow.")) { list.Add(new("runtime", null, "StackOverflowException", "Stack overflow.", 0)); break; }
                var m = DotNetException().Match(text);
                if (!m.Success) break;
                var line = DotNetLine().Match(text) is { Success: true } l ? inCode(int.Parse(l.Groups[1].Value)) : 0;
                var msg = m.Groups["msg"].Value.Trim();
                // A wrapped cause (DbUpdateException ---> SqliteException: UNIQUE constraint failed) is the useful part.
                if (InnerException().Match(text) is { Success: true } inner)
                    msg += $" (inner {inner.Groups["short"].Value}: {inner.Groups["msg"].Value.Trim()})";
                list.Add(new("runtime", null, m.Groups["short"].Value, msg, line));
                break;
            }
            case "python":
            {
                var ms = PythonException().Matches(text);
                if (ms.Count == 0) break;
                var m = ms[^1];
                // The innermost frame that is in the learner's own code.
                var line = PythonLine().Matches(text).Select(x => inCode(int.Parse(x.Groups[1].Value))).LastOrDefault(x => x > 0);
                list.Add(new("runtime", null, m.Groups["short"].Value, m.Groups["msg"].Value.Trim(), line));
                break;
            }
            case "typescript":
            {
                var m = JsException().Match(text);
                if (!m.Success) break;
                var line = JsLine().Matches(text).Select(x => inCode(int.Parse(x.Groups[1].Value))).FirstOrDefault(x => x > 0);
                list.Add(new("runtime", null, m.Groups["short"].Value, m.Groups["msg"].Value.Trim(), line));
                break;
            }
        }
        return list;
    }

    static string Normal(string? language) => (language ?? "").ToLowerInvariant() switch
    {
        "cs" or "c#" or "csharp" or "" => "csharp",
        "py" or "python" => "python",
        "ts" or "typescript" or "js" or "javascript" => "typescript",
        "sql" or "sqlite" => "sql",
        var other => other,
    };

    // ------------------------------------------------------------ matching

    /// <summary>The best entry for one problem, or null. Codes beat exception types, which beat message patterns.</summary>
    public Entry? Best(Problem p, string language) => Best(Entries(), p, Normal(language));

    static Entry? Best(List<Entry> entries, Problem p, string language)
    {
        Entry? best = null;
        var bestScore = 0;
        foreach (var e in entries)
        {
            if (e.Language != language) continue;
            var score = 0;
            var messageOk = e.Message is null || SafeMatch(e.Message, p.Message).Success;
            if (e.Codes.Length > 0)
            {
                if (p.Code is null || !e.Codes.Contains(p.Code) || !messageOk) continue;
                score = e.Message is null ? 100 : 110;
            }
            else if (e.Exception is not null)
            {
                if (p.Exception is null || !string.Equals(e.Exception, p.Exception, StringComparison.OrdinalIgnoreCase) || !messageOk) continue;
                score = e.Message is null ? 80 : 90;
            }
            else
            {
                if (p.Code is not null || !messageOk) continue;
                score = 50;
            }
            if (score > bestScore) { best = e; bestScore = score; }
        }
        return best;
    }

    static Match SafeMatch(Regex rx, string text)
    {
        try { return rx.Match(text); }
        catch (RegexMatchTimeoutException) { return Match.Empty; }
    }

    /// <summary>All problems in the result, each with its entry and the sentence about the learner's own code.</summary>
    public JsonObject Explain(ExplainRequest req)
    {
        var language = Normal(req.Language);
        var entries = Entries();
        var lines = (req.Code ?? "").Replace("\r\n", "\n").Split('\n');
        var result = new JsonArray();
        foreach (var p in Extract(req))
        {
            var e = Best(entries, p, language);
            var line = p.Line;
            string? huntNote = null;
            if (e?.Hunt is { } hunt && line == 0)
                for (var i = 0; i < lines.Length; i++)
                    if (SafeMatch(hunt, lines[i]) is { Success: true } hm)
                    {
                        line = i + 1;
                        huntNote = e.HuntNote!.Replace("{line}", line.ToString()).Replace("{match}", hm.Value.Trim());
                        break;
                    }
            var o = new JsonObject
            {
                ["kind"] = p.Kind,
                ["code"] = p.Code,
                ["exception"] = p.Exception,
                ["message"] = p.Message,
                ["line"] = line,
                ["lineText"] = line > 0 && line <= lines.Length ? lines[line - 1].TrimEnd() : null,
            };
            if (e is not null)
            {
                o["entry"] = new JsonObject
                {
                    ["id"] = e.Id,
                    ["title"] = e.Title,
                    ["explain"] = e.Explain,
                    ["causes"] = new JsonArray(e.Causes.Select(c => (JsonNode)c).ToArray()),
                    ["fix"] = new JsonArray(e.Fix.Select(c => (JsonNode)c).ToArray()),
                    ["before"] = e.Before,
                    ["after"] = e.After,
                };
                var specific = Specific(e, p, line);
                if (huntNote is not null) specific = specific is null ? huntNote : specific + " " + huntNote;
                o["specific"] = specific;
            }
            result.Add(o);
        }
        return new JsonObject { ["problems"] = result, ["entries"] = entries.Count };
    }

    /// <summary>"`total` is used before it is assigned on line 7." from the entry's template and the real message.</summary>
    public static string? Specific(Entry e, Problem p, int line)
    {
        if (e.Specific is null) return null;
        var groups = new Dictionary<string, string>();
        foreach (var rx in new[] { e.Message, e.Capture })
        {
            if (rx is null) continue;
            var m = SafeMatch(rx, p.Message);
            if (!m.Success) continue;
            foreach (var name in rx.GetGroupNames())
                if (!int.TryParse(name, out _) && m.Groups[name].Success && !groups.ContainsKey(name)) groups[name] = m.Groups[name].Value;
        }
        groups["line"] = line > 0 ? line.ToString() : "";
        groups["onLine"] = line > 0 ? $" on line {line}" : "";
        var missing = false;
        var text = Placeholder().Replace(e.Specific, m =>
        {
            if (groups.TryGetValue(m.Groups[1].Value, out var v)) return v;
            missing = true;
            return m.Value;
        });
        return missing || (e.Specific.Contains("{line}") && line == 0) ? null : text;
    }

    public static void Map(WebApplication app, ErrorKb kb, JsonSerializerOptions json)
    {
        app.MapPost("/api/explain", (ExplainRequest req) => Results.Text(kb.Explain(req).ToJsonString(json), "application/json"));
        app.MapGet("/api/explain/stats", () =>
        {
            var all = kb.Entries();
            return Results.Json(new { entries = all.Count, byLanguage = all.GroupBy(e => e.Language).ToDictionary(g => g.Key, g => g.Count()) }, json);
        });
    }
}
