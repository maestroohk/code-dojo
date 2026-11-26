using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeDojo;

/// <summary>
/// Flashcards made from lesson content, for spaced repetition (ui/srs.js schedules them, ui/flashcards.js reviews them):
///   senior's toolkit entries   command -> what it does; "you need X, which command?" (typeable for shell commands);
///                              each flag -> its meaning
///   learn cards                glossary-style bold definitions ("A **deadlock** is ...", "- **Idempotent**: ...")
///   match steps                each pair, with the step's prompt as context
///   lesson "cards"             hand-written: [{ "front": "...", "back": "...", "type": "command"?, "lang"? }]
/// A card id is stable while its text is: "track/module/lesson:kind:hash".
/// </summary>
public static partial class Flashcards
{
    static readonly ConcurrentDictionary<string, (DateTime Stamp, List<JsonObject> Cards)> Cache = new();

    static readonly HashSet<string> ShellLangs = ["bash", "sh", "shell", "powershell", "pwsh", "zsh", "cmd"];

    /// <summary>The cards of these lessons ("track/module/lesson" keys). Unknown keys are skipped.</summary>
    public static List<JsonObject> ForLessons(Content content, IEnumerable<string> keys)
    {
        var all = new List<JsonObject>();
        foreach (var key in keys.Distinct().Take(5000))
        {
            var parts = key.Split('/');
            if (parts.Length != 3 || !parts.All(Content.SafeSegment)) continue;
            var file = Path.Combine(content.TracksDir, parts[0], parts[1], parts[2] + ".json");
            if (!File.Exists(file)) continue;
            var stamp = File.GetLastWriteTimeUtc(file);
            if (!Cache.TryGetValue(file, out var hit) || hit.Stamp != stamp)
            {
                JsonObject? lesson;
                try { lesson = content.Lesson(parts[0], parts[1], parts[2], coldOf: false); }
                catch { continue; }
                if (lesson is null) continue;
                hit = (stamp, FromLesson(lesson, key));
                Cache[file] = hit;
            }
            all.AddRange(hit.Cards.Select(c => (JsonObject)c.DeepClone()));
        }
        return all;
    }

    /// <summary>Every card one lesson gives.</summary>
    public static List<JsonObject> FromLesson(JsonObject lesson, string key)
    {
        var cards = new List<JsonObject>();
        var seen = new HashSet<string>();
        var title = Str(lesson["title"]) ?? key;
        void Add(string kind, string idText, string front, string back, string? context, string? lang = null, string? type = null, string? extra = null)
        {
            front = front.Trim(); back = back.Trim();
            if (front.Length == 0 || back.Length == 0) return;
            var id = $"{key}:{kind}:{Hash(kind + "\n" + idText)}";
            if (!seen.Add(id)) return;
            var card = new JsonObject { ["id"] = id, ["lesson"] = key, ["lessonTitle"] = title, ["kind"] = kind, ["front"] = front, ["back"] = back };
            if (context is { Length: > 0 }) card["context"] = context;
            if (lang is { Length: > 0 }) card["lang"] = lang;
            if (type is { Length: > 0 }) card["type"] = type;
            if (extra is { Length: > 0 }) card["extra"] = extra;
            cards.Add(card);
        }

        foreach (var step in (lesson["steps"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var stepType = Str(step["type"]);
            var stepTitle = Str(step["title"]);
            if (step["toolkit"] is JsonArray toolkit)
                foreach (var e in toolkit.OfType<JsonObject>())
                {
                    var cmd = Str(e["cmd"])?.Trim();
                    var what = Str(e["what"])?.Trim();
                    if (string.IsNullOrEmpty(cmd)) continue;
                    var lang = Str(e["lang"]) ?? "bash";
                    var when = Str(e["when"]);
                    var example = Str(e["example"]);
                    var context = stepTitle?.Replace("Senior's toolkit: ", "Toolkit: ");
                    if (!string.IsNullOrEmpty(what))
                    {
                        Add("command", cmd, $"What does `{cmd}` do?", what + (when is { Length: > 0 } ? $"\n\n*Reach for it:* {when}" : ""), context, lang, extra: example);
                        // Typing a shell command from memory is the real skill; code APIs are flipped and graded.
                        var typeable = ShellLangs.Contains(lang.ToLowerInvariant()) && !cmd.Contains('\n');
                        Add("reverse", cmd, "You need to: " + Redact(what, cmd) + (when is { Length: > 0 } ? $" ({when})" : "") + "\n\nWhich command?",
                            $"`{cmd}`", context, lang, typeable ? "command" : null, example);
                    }
                    foreach (var f in (e["flags"] as JsonArray ?? []).OfType<JsonArray>())
                    {
                        var flag = Str(f.ElementAtOrDefault(0))?.Trim();
                        var meaning = Str(f.ElementAtOrDefault(1))?.Trim();
                        if (string.IsNullOrEmpty(flag) || string.IsNullOrEmpty(meaning) || flag == cmd) continue;
                        Add("flag", cmd + "\n" + flag, $"In `{cmd}`, what does `{flag}` do?", meaning, context, lang);
                    }
                }
            if (stepType == "match")
                foreach (var pair in (step["pairs"] as JsonArray ?? []).OfType<JsonArray>())
                {
                    var left = Str(pair.ElementAtOrDefault(0));
                    var right = Str(pair.ElementAtOrDefault(1));
                    if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right)) continue;
                    Add("match", left + "\n" + right, left, right, Str(step["prompt"]));
                }
            if (stepType == "learn" && Lines(step["body"]) is { } body)
                foreach (var (term, def) in Definitions(body))
                    Add("term", term, $"**{term}**", def, stepTitle ?? title);
        }

        foreach (var c in (lesson["cards"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var front = Lines(c["front"]);
            var back = Lines(c["back"]);
            if (front is null || back is null) continue;
            var type = Str(c["type"]) == "command" ? "command" : null;
            Add("custom", front, front, type is null ? back : back.Trim().StartsWith('`') ? back : $"`{back.Trim()}`", Str(c["context"]) ?? title, Str(c["lang"]), type);
        }
        return cards;
    }

    // "- **Idempotent**: safe to repeat ..." or "A **deadlock** is when two ..." outside code blocks.
    [GeneratedRegex(@"^\s*(?:[-*]\s+)?\*\*(?<term>[^*`]{2,40})\*\*\s*(?::|—|–| - )\s*(?<def>.{12,240})$")]
    private static partial Regex ListDefinition();
    [GeneratedRegex(@"(?:^|[.!?]\s+)(?:An?|The)\s+\*\*(?<term>[^*`]{2,40})\*\*\s+(?<verb>is|are|means)\s+(?<def>[^.!?]{12,240}[.!?])")]
    private static partial Regex SentenceDefinition();

    public static IEnumerable<(string Term, string Def)> Definitions(string body)
    {
        var inFence = false;
        foreach (var raw in body.Replace("\r\n", "\n").Split('\n'))
        {
            if (raw.TrimStart().StartsWith("```")) { inFence = !inFence; continue; }
            if (inFence || raw.TrimStart().StartsWith('|') || raw.TrimStart().StartsWith('#')) continue;
            if (ListDefinition().Match(raw) is { Success: true } m)
            {
                var def = m.Groups["def"].Value.Trim();
                if (def.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length >= 4 && !def.EndsWith(',')) yield return (m.Groups["term"].Value.Trim(), Capital(def));
            }
            else if (SentenceDefinition().Match(raw) is { Success: true } s)
                yield return (s.Groups["term"].Value.Trim(), Capital(s.Groups["def"].Value.Trim()));
        }
    }

    static string Capital(string s) => s.Length > 0 && char.IsLower(s[0]) ? char.ToUpperInvariant(s[0]) + s[1..] : s;

    /// <summary>The "what" text without the answer in it: backticked spans that name the command become `…`.</summary>
    public static string Redact(string what, string cmd)
    {
        var words = cmd.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var program = words.FirstOrDefault() ?? "";
        var sub = words.Skip(1).FirstOrDefault(w => !w.StartsWith('-') && !w.StartsWith('<')) ?? "";
        return Regex.Replace(what, "`([^`]+)`", m =>
        {
            var span = m.Groups[1].Value;
            var names = program.Length >= 2 && span.Contains(program, StringComparison.Ordinal)
                || sub.Length >= 3 && span.Contains(program + " " + sub, StringComparison.Ordinal)
                || span == cmd;
            return names ? "`…`" : m.Value;
        });
    }

    static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static string? Lines(JsonNode? n) => n switch
    {
        JsonArray a when a.All(x => x is JsonValue v && v.TryGetValue<string>(out _)) => string.Join("\n", a.Select(x => (string)x!)),
        _ => Str(n),
    };

    /// <summary>FNV-1a, 32 bits, as 8 hex digits.</summary>
    public static string Hash(string s)
    {
        uint h = 2166136261;
        foreach (var ch in s) { h ^= ch; h *= 16777619; }
        return h.ToString("x8");
    }

    /// <summary>`dojo validate`: a lesson's hand-written "cards" are well formed.</summary>
    public static List<string> Check(JsonObject lesson)
    {
        var problems = new List<string>();
        if (lesson["cards"] is null) return problems;
        if (lesson["cards"] is not JsonArray arr) { problems.Add("\"cards\" must be an array of { \"front\", \"back\" }"); return problems; }
        var fronts = new HashSet<string>();
        var i = 0;
        foreach (var node in arr)
        {
            i++;
            var where = $"card {i}";
            if (node is not JsonObject c) { problems.Add($"{where}: must be an object with \"front\" and \"back\""); continue; }
            foreach (var k in c.Select(p => p.Key))
                if (k is not ("front" or "back" or "type" or "lang" or "context")) problems.Add($"{where}: unknown field \"{k}\" (front, back, type, lang, context)");
            var front = Lines(c["front"]);
            var back = Lines(c["back"]);
            if (string.IsNullOrWhiteSpace(front)) problems.Add($"{where}: \"front\" must be a non-empty string (or an array of lines)");
            if (string.IsNullOrWhiteSpace(back)) problems.Add($"{where}: \"back\" must be a non-empty string (or an array of lines)");
            if (front is { Length: > 600 }) problems.Add($"{where}: \"front\" is over 600 characters; one idea per card");
            if (back is { Length: > 1200 }) problems.Add($"{where}: \"back\" is over 1200 characters; one idea per card");
            if (front is not null && !fronts.Add(front.Trim())) problems.Add($"{where}: another card has the same front");
            if (c["type"] is { } t && Str(t) != "command") problems.Add($"{where}: \"type\" can only be \"command\" (the learner may type the answer)");
            if (Str(c["type"]) == "command" && back is not null && back.Trim().Contains('\n')) problems.Add($"{where}: a \"command\" card's back must be one command on one line");
        }
        return problems;
    }

    public record CardsRequest(List<string>? Lessons);

    public static void Map(WebApplication app, Content content, JsonSerializerOptions json)
    {
        app.MapPost("/api/cards", (CardsRequest req) =>
        {
            var cards = ForLessons(content, req.Lessons ?? []);
            return Results.Text(new JsonObject { ["cards"] = new JsonArray(cards.ToArray<JsonNode>()) }.ToJsonString(json), "application/json");
        });
    }
}
